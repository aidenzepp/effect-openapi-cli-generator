import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { checkCoverage, coverageOf } from "../../corpus/tools/coverage.ts";
import type { Coverage } from "../../corpus/tools/coverage.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Resolution } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";
import { Description } from "../../src/runtime-src/runtime/describe.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";

const golden = nodePath.resolve(import.meta.dir, "../fixtures/golden/users-update");

const specPath = nodePath.join(golden, "openapi.json");

// The golden author config names `./custom/commands.ts`, which the author owns: one `login` command.
const authorCommands = `import { Command } from "effect/cli";\n\nexport const login = Command.make("login");\n`;

// Generated packages live under the worktree's `work/`, never the system temp directory.
const scratch = nodePath.resolve(import.meta.dir, "../../work/coverage");

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

// The same document URI `generateFixture` gives the spec, so report pointers join with the walk.
const entry = Schema.decodeUnknownSync(DocumentUri)("file:///fixture/openapi.json");

interface Golden {
  readonly describe: string;
  readonly report: string;
  readonly resolution: Resolution;
}

let built: Golden | undefined;

let previousTmp: string | undefined;

const goldenRun = (): Golden => {
  if (built === undefined) {
    throw new Error("the golden package was not built");
  }

  return built;
};

beforeAll(async () => {
  previousTmp = process.env.TMPDIR;
  nodeFs.mkdirSync(scratch, { recursive: true });
  process.env.TMPDIR = scratch;

  built = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* build() {
        const fs = yield* FileSystem.FileSystem;
        const generated = yield* generateFixture({
          authorFiles: [{ content: authorCommands, path: "custom/commands.ts" }],
          configPath: nodePath.join(golden, "author-config.json"),
          specPath,
        });
        if (!generated.root.startsWith(scratch)) {
          return yield* Effect.die(`the package was generated outside work/: ${generated.root}`);
        }

        yield* preparePackage(generated);

        const run = yield* runBin(generated, { args: ["--describe"], timeoutMs: 30_000 });
        if (run.exitCode !== 0 || run.timedOut) {
          return yield* Effect.die(
            `--describe exited ${String(run.exitCode)}: ${new TextDecoder().decode(run.stderr)}`,
          );
        }

        const report = yield* fs.readFileString(
          nodePath.join(generated.dir, "generation-report.json"),
        );
        const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
          yield* fs.readFileString(specPath),
        );
        const resolution = yield* resolve({ document: entry, line: "3.1", value });

        return { describe: new TextDecoder().decode(run.stdout), report, resolution };
      }),
    ).pipe(Effect.provide(layer)),
  );
}, 300_000);

afterAll(() => {
  if (previousTmp === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = previousTmp;
  }

  nodeFs.rmSync(scratch, { force: true, recursive: true });
});

const decodeDescription = Schema.decodeUnknownSync(Schema.fromJsonString(Description));

const encodeDescription = (description: typeof Description.Type): string =>
  JSON.stringify(Schema.encodeSync(Description)(description));

type Command = (typeof Description.Type)["commands"][number];

const update = "/paths/~1users~1{id}/patch";

const setAvatar = "/paths/~1users~1{id}~1avatar/put";

const goldenDescription = (): typeof Description.Type => decodeDescription(goldenRun().describe);

const commandsAt = (pointer: string, edit: (command: Command) => readonly Command[]): string => {
  const description = goldenDescription();
  if (!description.commands.some((command) => command.pointer === pointer)) {
    throw new Error(`the golden describe output has no command at ${pointer}`);
  }

  return encodeDescription({
    ...description,
    commands: description.commands.flatMap((command) =>
      command.pointer === pointer ? edit(command) : [command],
    ),
  });
};

// The golden describe output with the command for `pointer` rewritten.
const editCommand = (pointer: string, edit: (command: Command) => Command): string =>
  commandsAt(pointer, (command) => [edit(command)]);

// The golden describe output without the command for `pointer`.
const dropCommand = (pointer: string): string => commandsAt(pointer, () => []);

interface Record {
  readonly pointer: string;
  readonly scope: "document" | "element" | "operation";
}

// Only the report fields the checker reads.
const decodeReport = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ notices: Schema.Array(Schema.Json), refusals: Schema.Array(Schema.Json) }),
  ),
);

// The golden report with records appended, named by the entry URI as the generator names them.
const withRecords = (records: {
  readonly notices?: readonly Record[];
  readonly refusals?: readonly Record[];
}): string => {
  const report = decodeReport(goldenRun().report);
  const named = (list: readonly Record[] = []) =>
    list.map((record) => ({ ...record, document: entry }));

  return JSON.stringify({
    notices: [...report.notices, ...named(records.notices)],
    refusals: [...report.refusals, ...named(records.refusals)],
  });
};

const coverage = (describeText: string, report: string = goldenRun().report): Coverage =>
  Effect.runSync(coverageOf({ ...goldenRun(), describe: describeText, report }).pipe(Effect.orDie));

const pointers = (result: Coverage): readonly string[] =>
  result.missing.map((element) => element.pointer);

describe("coverage check", () => {
  test("the golden spec passes: every walked element is in --describe or the report", () => {
    const result = Effect.runSync(
      checkCoverage(goldenRun()).pipe(
        Effect.match({ onFailure: (failure) => failure, onSuccess: () => "pass" }),
      ),
    );
    const joined = coverage(goldenRun().describe);

    expect(result).toBe("pass");
    expect(joined.missing).toEqual([]);
    expect(joined.invented).toEqual([]);
  });

  test("a describe output with a dropped flag fails with that parameter missing", () => {
    const description = goldenDescription();
    const [first, ...rest] = description.commands;
    if (first === undefined) {
      throw new Error("the golden describe output has no commands");
    }

    const dropped = first.flags.find((flag) => flag.location === "query");
    if (dropped === undefined) {
      throw new Error("the golden update command has no query flag");
    }

    const without = {
      ...description,
      commands: [{ ...first, flags: first.flags.filter((flag) => flag !== dropped) }, ...rest],
    };
    const result = coverage(encodeDescription(without));

    expect(result.invented).toEqual([]);
    expect(pointers(result)).toEqual([dropped.pointer]);
  });

  test("a describe output with an extra command fails with that command invented", () => {
    const description = goldenDescription();
    const extra: Command = {
      document: "openapi.json",
      flags: [],
      method: "DELETE",
      path: ["users", "delete"],
      pathTemplate: "/users/{id}",
      pointer: "/paths/~1users~1{id}/delete",
      requestMedia: [],
      responses: [],
      security: [],
      servers: [],
    };
    const result = coverage(
      encodeDescription({ ...description, commands: [...description.commands, extra] }),
    );

    expect(result.missing).toEqual([]);
    expect(result.invented).toEqual([
      {
        document: "openapi.json",
        kind: "command",
        path: ["users", "delete"],
        pointer: extra.pointer,
      },
    ]);
  });

  test("set-avatar without image/png fails with that request media missing", () => {
    const result = coverage(
      editCommand(setAvatar, (command) => ({
        ...command,
        requestMedia: command.requestMedia.filter((media) => media !== "image/png"),
      })),
    );

    expect(result.invented).toEqual([]);
    expect(pointers(result)).toEqual([`${setAvatar}/requestBody/content/image~1png`]);
  });

  test("update with no security alternative fails with that alternative missing", () => {
    const result = coverage(editCommand(update, (command) => ({ ...command, security: [] })));

    expect(result.invented).toEqual([]);
    expect(pointers(result)).toEqual([`${update}/security/0`]);
  });

  test("update without the 404 response key fails with that response missing", () => {
    const result = coverage(
      editCommand(update, (command) => ({
        ...command,
        responses: command.responses.filter((key) => key !== "404"),
      })),
    );

    expect(result.invented).toEqual([]);
    expect(pointers(result)).toEqual([`${update}/responses/404`]);
  });

  test("an inherited root server one command drops is missing unless that operation is refused", () => {
    const dropped = editCommand(update, (command) => ({ ...command, servers: [] }));

    expect(pointers(coverage(dropped))).toEqual(["/servers/0"]);
    expect(
      pointers(
        coverage(dropped, withRecords({ refusals: [{ pointer: update, scope: "operation" }] })),
      ),
    ).toEqual([]);
  });

  test("an operation-scope refusal covers its subtree and its inherited elements", () => {
    const dropped = dropCommand(update);
    const unrefused = coverage(dropped);
    const refused = coverage(
      dropped,
      withRecords({ refusals: [{ pointer: update, scope: "operation" }] }),
    );

    expect(pointers(unrefused)).toContain(update);
    expect(pointers(unrefused)).toContain(`${update}/requestBody/content/application~1json`);
    expect(pointers(unrefused)).toContain("/servers/0");
    expect(refused.missing).toEqual([]);
    expect(refused.invented).toEqual([]);
  });

  test("an operation-scope refusal anchored inside the operation refuses that operation", () => {
    const dropped = dropCommand(update);
    const refused = coverage(
      dropped,
      withRecords({ refusals: [{ pointer: `${update}/tags/0`, scope: "operation" }] }),
    );

    expect(pointers(coverage(dropped))).toContain(update);
    expect(refused.missing).toEqual([]);
    expect(refused.invented).toEqual([]);
  });

  test("an element-scope refusal below an operation leaves the operation counted", () => {
    const result = coverage(
      dropCommand(update),
      withRecords({ refusals: [{ pointer: `${update}/tags/0`, scope: "element" }] }),
    );

    expect(pointers(result)).toContain(update);
  });

  test("an element-scope refusal covers its descendants", () => {
    const result = coverage(
      editCommand(setAvatar, (command) => ({ ...command, requestMedia: [] })),
      withRecords({ refusals: [{ pointer: `${setAvatar}/requestBody`, scope: "element" }] }),
    );

    expect(result.missing).toEqual([]);
  });

  test("a document-scope refusal accounts every element of its document", () => {
    const empty = encodeDescription({ ...goldenDescription(), commands: [] });
    const unrefused = coverage(empty);
    const refused = coverage(
      empty,
      withRecords({ refusals: [{ pointer: "", scope: "document" }] }),
    );

    expect(pointers(unrefused)).toContain(update);
    expect(pointers(unrefused)).toContain("/servers/0");
    expect(refused.missing).toEqual([]);
    expect(refused.invented).toEqual([]);
  });

  test("an element accounted only by a notice is listed, not missing", () => {
    const header = `${update}/parameters/2`;
    const result = coverage(
      editCommand(update, (command) => ({
        ...command,
        flags: command.flags.filter((flag) => flag.pointer !== header),
      })),
      withRecords({ notices: [{ pointer: header, scope: "element" }] }),
    );

    expect(result.missing).toEqual([]);
    expect(result.byNotice.map((element) => element.pointer)).toEqual([header]);
  });

  test("a notice at an operation pointer does not cover a dropped command or its subtree", () => {
    const result = coverage(
      dropCommand(update),
      withRecords({ notices: [{ pointer: update, scope: "operation" }] }),
    );

    expect(pointers(result)).toContain(update);
    expect(pointers(result)).toContain(`${update}/responses/200`);
  });

  test("a described server with no spec counterpart is invented", () => {
    const result = coverage(
      editCommand(update, (command) => ({
        ...command,
        servers: [...command.servers, "https://other.example"],
      })),
    );

    expect(result.missing).toEqual([]);
    expect(result.invented).toEqual([
      {
        document: "openapi.json",
        kind: "server",
        path: ["users", "update"],
        pointer: update,
        url: "https://other.example",
      },
    ]);
  });
});

const command = (fields: Partial<Command>): Command => ({
  document: "openapi.json",
  flags: [],
  method: "GET",
  path: ["a"],
  pathTemplate: "/a",
  pointer: "/paths/~1a/get",
  requestMedia: [],
  responses: ["200"],
  security: [],
  servers: [],
  ...fields,
});

const joinSpec = (spec: Json, commands: readonly Command[]): Coverage =>
  Effect.runSync(
    resolve({ document: entry, line: "3.1", value: spec }).pipe(
      Effect.flatMap((resolution) =>
        coverageOf({
          describe: encodeDescription({ commands, describeVersion: 1 }),
          report: JSON.stringify({ notices: [], refusals: [] }),
          resolution,
        }),
      ),
      Effect.orDie,
    ),
  );

const bare: Json = {
  info: { title: "t", version: "1" },
  openapi: "3.1.1",
  paths: { "/a": { get: { responses: { "200": { description: "ok" } } } } },
};

describe("coverage join without a build", () => {
  test("the default / server is not invented when no level declares servers", () => {
    const result = joinSpec(bare, [command({ servers: ["/"] })]);

    expect(result.missing).toEqual([]);
    expect(result.invented).toEqual([]);
  });

  test("any other server is invented when no level declares servers", () => {
    expect(joinSpec(bare, [command({ servers: ["/x"] })]).invented).toEqual([
      {
        document: "openapi.json",
        kind: "server",
        path: ["a"],
        pointer: "/paths/~1a/get",
        url: "/x",
      },
    ]);
  });

  test("a path-item parameter is missing when one inheriting command drops its flag", () => {
    const spec: Json = {
      ...bare,
      paths: {
        "/a": {
          get: { responses: { "200": { description: "ok" } } },
          parameters: [{ in: "query", name: "q" }],
          post: { responses: { "200": { description: "ok" } } },
        },
      },
    };
    const flag = {
      location: "query" as const,
      name: "q",
      pointer: "/paths/~1a/parameters/0",
      wireName: "q",
    };

    expect(
      joinSpec(spec, [
        command({ flags: [flag] }),
        command({ flags: [flag], method: "POST", pointer: "/paths/~1a/post" }),
      ]).missing,
    ).toEqual([]);
    expect(
      joinSpec(spec, [
        command({ flags: [flag] }),
        command({ method: "POST", pointer: "/paths/~1a/post" }),
      ]).missing.map((element) => element.pointer),
    ).toEqual(["/paths/~1a/parameters/0"]);
  });
});
