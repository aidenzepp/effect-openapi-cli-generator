import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { checkCoverage, coverageOf } from "../../corpus/tools/coverage.ts";
import type { Coverage } from "../../corpus/tools/coverage.ts";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Resolution } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";
import { Description } from "../../src/runtime-src/runtime/describe.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import { setEnv } from "../support/env.ts";

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

let restoreTmpdir: (() => void) | undefined;

const goldenRun = (): Golden => {
  if (built === undefined) {
    throw new Error("the golden package was not built");
  }

  return built;
};

beforeAll(async () => {
  nodeFs.mkdirSync(scratch, { recursive: true });
  restoreTmpdir = setEnv("TMPDIR", scratch);

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
  restoreTmpdir?.();

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

interface Notice extends Record {
  readonly code: string;
}

// Only the report fields the checker reads.
const decodeReport = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      notices: Schema.Array(Schema.Json),
      refusals: Schema.Array(Schema.Json),
      skipped: Schema.Array(Schema.Json),
    }),
  ),
);

// Report records named by the entry URI as the generator names them.
const named = <R extends Record>(list: readonly R[] = []) =>
  list.map((record) => ({ ...record, document: entry }));

// The golden report with records appended.
const withRecords = (records: {
  readonly notices?: readonly Notice[];
  readonly refusals?: readonly Record[];
  readonly skipped?: readonly string[];
}): string => {
  const report = decodeReport(goldenRun().report);
  const skipped = (records.skipped ?? []).map((pointer) => ({
    document: entry,
    pointer,
    reason: "config-skip",
  }));

  return JSON.stringify({
    notices: [...report.notices, ...named(records.notices)],
    refusals: [...report.refusals, ...named(records.refusals)],
    skipped: [...report.skipped, ...skipped],
  });
};

const coverage = (describeText: string, report: string = goldenRun().report): Coverage =>
  Effect.runSync(coverageOf({ ...goldenRun(), describe: describeText, report }).pipe(Effect.orDie));

const pointers = (result: Coverage): readonly string[] =>
  result.missing.map((element) => element.pointer);

const at = (elements: Coverage["missing"]): readonly string[] =>
  elements.map((element) => element.pointer);

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
      refusedFields: [],
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

  test("an author-skipped operation covers its subtree and its inherited elements", () => {
    const dropped = dropCommand(update);
    const skipped = coverage(dropped, withRecords({ skipped: [update] }));

    expect(decodeReport(goldenRun().report).skipped).toEqual([]);
    expect(pointers(coverage(dropped))).toContain("/servers/0");
    expect(skipped.missing).toEqual([]);
    expect(skipped.byNotice).toEqual([]);
    expect(skipped.invented).toEqual([]);
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
      withRecords({ notices: [{ code: "PAR-01/test", pointer: header, scope: "element" }] }),
    );

    expect(result.missing).toEqual([]);
    expect(result.byNotice.map((element) => element.pointer)).toEqual([header]);
  });

  test("a notice at an operation pointer does not cover a dropped command or its subtree", () => {
    const result = coverage(
      dropCommand(update),
      withRecords({ notices: [{ code: "OPR-01/test", pointer: update, scope: "operation" }] }),
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
  refusedFields: [],
  requestMedia: [],
  responses: ["200"],
  security: [],
  servers: [],
  ...fields,
});

const joinSpec = (
  spec: Json,
  commands: readonly Command[],
  report?: Json,
  line: "3.0" | "3.1" = "3.1",
): Coverage =>
  Effect.runSync(
    resolve({ document: entry, line, value: spec }).pipe(
      Effect.flatMap((resolution) =>
        coverageOf({
          describe: encodeDescription({ commands, describeVersion: 1 }),
          report: JSON.stringify(report ?? { notices: [], refusals: [] }),
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

// A flag collision at `/a`'s path-item parameter as the names stage refuses it: once per operation,
// at the colliding parameter's pointer, naming the operation it refuses.
const collision = (method: string): Json => ({
  code: "PRM-02/flag-collision",
  document: entry,
  operation: { method, path: "/a" },
  pointer: "/paths/~1a/parameters/0",
  scope: "operation",
});

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

  test("an operation-scope refusal at a path-item parameter credits the operations it names", () => {
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
    const missing = (refusals: readonly Json[]) =>
      joinSpec(spec, [], { notices: [], refusals }).missing.map((element) => element.pointer);

    expect(missing([collision("GET"), collision("POST")])).toEqual([]);
    expect(missing([collision("GET")])).toEqual([
      "/paths/~1a/post",
      "/paths/~1a/post/responses/200",
    ]);
  });

  test("an OPR-10/body-ignored notice credits the media below its request body, other codes only their pointer", () => {
    const spec: Json = {
      ...bare,
      openapi: "3.0.0",
      paths: {
        "/a": {
          get: {
            requestBody: {
              content: { "application/x-www-form-urlencoded": { schema: { type: "object" } } },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const body = "/paths/~1a/get/requestBody";
    const media = `${body}/content/application~1x-www-form-urlencoded`;
    const noticeAt = (code: string) => ({
      notices: [{ code, document: entry, pointer: body, scope: "element" }],
      refusals: [],
    });
    const join = (report?: Json) => joinSpec(spec, [command({})], report, "3.0");

    expect(at(join().missing)).toEqual([media]);
    expect(at(join(noticeAt("OPR-10/body-ignored")).missing)).toEqual([]);
    expect(at(join(noticeAt("OPR-10/body-ignored")).byNotice)).toEqual([media]);
    expect(at(join(noticeAt("OPR-10/body-refused")).missing)).toEqual([media]);
  });

  test("skipping an operation leaves root servers and security carried by the emitted commands", () => {
    const spec: Json = {
      ...bare,
      components: { securitySchemes: { key: { in: "header", name: "X-Key", type: "apiKey" } } },
      paths: {
        "/a": {
          get: { responses: { "200": { description: "ok" } } },
          post: { responses: { "200": { description: "ok" } } },
        },
      },
      security: [{ key: [] }],
      servers: [{ url: "https://api.example.com" }],
    };
    const emitted = command({ security: [["key"]], servers: ["https://api.example.com"] });
    const skipped = {
      notices: [],
      refusals: [],
      skipped: [{ document: entry, pointer: "/paths/~1a/post", reason: "config-skip" }],
    };
    const missing = (commands: readonly Command[], report?: Json) =>
      joinSpec(spec, commands, report).missing.map((element) => element.pointer);

    expect(missing([emitted])).toEqual([
      "/paths/~1a/post",
      "/paths/~1a/post/responses/200",
      "/security/0",
      "/servers/0",
    ]);
    expect(missing([emitted], skipped)).toEqual([]);
    expect(missing([command({ security: [["key"]] })], skipped)).toEqual(["/servers/0"]);
  });
});

// A body offering JSON and a form alternative with an optional `meta` property.
const formBody: Json = {
  content: {
    "application/json": { schema: { type: "object" } },
    "application/x-www-form-urlencoded": {
      encoding: { meta: { style: "deepObject" } },
      schema: { properties: { meta: { type: "object" } }, type: "object" },
    },
  },
};

// A POST at `/a` whose request body is `requestBody`, beside `components`, on `openapi`.
const postSpec = (requestBody: Json, components: Json = {}, openapi = "3.1.1"): Json => ({
  ...bare,
  components,
  openapi,
  paths: { "/a": { post: { requestBody, responses: { "200": { description: "ok" } } } } },
});

const formSpec = postSpec(formBody);

const form = "application/x-www-form-urlencoded";

const formMedia = "/paths/~1a/post/requestBody/content/application~1x-www-form-urlencoded";

const metaField = `${formMedia}/encoding/meta`;

// The POST as `--describe` lists it, offering both media types and listing `refused` fields.
const post = (fields: Partial<Command> = {}): Command =>
  command({
    method: "POST",
    path: ["a", "post"],
    pointer: "/paths/~1a/post",
    requestMedia: ["application/json", form],
    ...fields,
  });

const refusedMeta = { mediaType: form, name: "meta" };

// A report with one `field` refusal at `pointer`, plus `refusals`.
const fieldReport = (pointer: string, refusals: readonly Json[] = []): Json => ({
  notices: [],
  refusals: [
    { code: "PRM-27/compound-nested", document: entry, pointer, scope: "field" },
    ...refusals,
  ],
});

// The same body as `components/requestBodies/Form`, reached through `$ref`. Its refusals sit at the
// use site, each locating itself in the target as `related[0]` (design 8.1).
const refFormSpec = postSpec(
  { $ref: "#/components/requestBodies/Form" },
  { requestBodies: { Form: formBody } },
);

const useSite = "/paths/~1a/post/requestBody";

const refFieldReport: Json = {
  notices: [],
  refusals: [
    {
      code: "PRM-27/compound-nested",
      document: entry,
      pointer: useSite,
      related: [
        {
          document: entry,
          pointer:
            "/components/requestBodies/Form/content/application~1x-www-form-urlencoded/encoding/meta",
        },
      ],
      scope: "field",
    },
  ],
};

describe("coverage join of field refusals", () => {
  test("a field refusal every command lists under a media type it carries accounts both ways", () => {
    const result = joinSpec(
      formSpec,
      [
        post({ refusedFields: [refusedMeta] }),
        post({ path: ["a", "send"], refusedFields: [refusedMeta] }),
      ],
      fieldReport(metaField),
    );

    expect(result.missing).toEqual([]);
    expect(result.invented).toEqual([]);
  });

  test("a field refusal under an alternative no command carries is missing, and so is its media", () => {
    const result = joinSpec(
      formSpec,
      [post({ requestMedia: ["application/json"] })],
      fieldReport(metaField),
    );

    expect(result.invented).toEqual([]);
    expect(result.missing).toEqual([
      expect.objectContaining({ kind: "requestMedia", pointer: formMedia }),
      { document: entry, kind: "refusedField", mediaType: form, name: "meta", pointer: metaField },
    ]);
  });

  test("a field refusal one alias does not list is missing", () => {
    const result = joinSpec(
      formSpec,
      [post({ refusedFields: [refusedMeta] }), post({ path: ["a", "send"] })],
      fieldReport(metaField),
    );

    expect(result.invented).toEqual([]);
    expect(result.missing).toEqual([
      { document: entry, kind: "refusedField", mediaType: form, name: "meta", pointer: metaField },
    ]);
  });

  test("a described refused field with no field refusal at its encoding entry is invented", () => {
    const result = joinSpec(formSpec, [post({ refusedFields: [refusedMeta] })]);

    expect(result.missing).toEqual([]);
    expect(result.invented).toEqual([
      {
        document: "openapi.json",
        kind: "refusedField",
        mediaType: form,
        name: "meta",
        path: ["a", "post"],
        pointer: "/paths/~1a/post",
      },
    ]);
  });

  test("a field refusal under a refused operation is accounted by that refusal", () => {
    const refusedPost = {
      code: "SEC-06/unsupported-scheme",
      document: entry,
      pointer: "/paths/~1a/post",
      scope: "operation",
    };

    expect(joinSpec(formSpec, [], fieldReport(metaField, [refusedPost])).missing).toEqual([]);
  });

  test("under a $ref body, a field refusal at the use site with its entry related accounts both ways", () => {
    const result = joinSpec(refFormSpec, [post({ refusedFields: [refusedMeta] })], refFieldReport);

    expect(result.missing).toEqual([]);
    expect(result.invented).toEqual([]);
  });

  test("under a $ref body, a field refusal at the use site with no entry related is missing", () => {
    const result = joinSpec(
      refFormSpec,
      [post({ refusedFields: [refusedMeta] })],
      fieldReport(useSite),
    );

    expect(result.missing).toEqual([
      { document: entry, kind: "refusedField", mediaType: "", name: "", pointer: useSite },
    ]);
    expect(result.invented).toEqual([
      expect.objectContaining({ kind: "refusedField", mediaType: form, name: "meta" }),
    ]);
  });
});

// One optional `deepObject` form property, `expand`, that the bracket switch refuses at field scope
// (design 8.5 rule 4), beside a plain `name`.
const expandMedia: Json = {
  encoding: { expand: { explode: true, style: "deepObject" } },
  schema: {
    properties: {
      expand: {
        anyOf: [
          { properties: { a: { type: "string" } }, type: "object" },
          { enum: [""], type: "string" },
        ],
      },
      name: { type: "string" },
    },
    type: "object",
  },
};

const bracketConfig = Schema.decodeUnknownSync(AuthorConfig)({
  binName: "example",
  nonStandard: { deepObjectBrackets: true },
  package: { name: "example-cli", version: "1.0.0" },
});

const configUri = Schema.decodeUnknownSync(DocumentUri)("file:///fixture/author.json");

interface Placed {
  readonly pointer: string;
  readonly related: readonly string[];
}

// The document normalized, its field refusals as placed, and the coverage join over its report and
// a `--describe` read off the normalized model: each command's kept request media and their
// refused fields.
interface NormalizedJoin {
  readonly fields: readonly Placed[];
  readonly join: Coverage;
}

const normalizedJoin = (spec: Json, line: "3.1" | "3.2"): NormalizedJoin => {
  const resolution = Effect.runSync(resolve({ document: entry, line, value: spec }));
  const { api, diagnostics } = Effect.runSync(
    normalize(resolution, { checkFindings: [], config: bracketConfig, configDocument: configUri }),
  );
  const commands = api.operations.map((operation) => {
    const alternatives = operation.body?.alternatives ?? [];

    return post({
      pointer: operation.origin.pointer,
      refusedFields: alternatives.flatMap((alternative) =>
        (alternative.refusedFields ?? []).map((name) => ({
          mediaType: alternative.mediaType,
          name,
        })),
      ),
      requestMedia: alternatives.map((alternative) => alternative.mediaType),
    });
  });
  const report = {
    notices: diagnostics.filter((diagnostic) => diagnostic.severity === "notice"),
    refusals: diagnostics.filter((diagnostic) => diagnostic.severity === "refusal"),
  };
  const join = Effect.runSync(
    coverageOf({
      describe: encodeDescription({ commands, describeVersion: 1 }),
      report: JSON.stringify(report),
      resolution,
    }).pipe(Effect.orDie),
  );
  const fields = diagnostics
    .filter((diagnostic) => diagnostic.scope === "field")
    .map((diagnostic) => ({
      pointer: diagnostic.pointer,
      related: (diagnostic.related ?? []).map((related) => related.pointer),
    }));

  return { fields, join };
};

const expandEntry = `${formMedia}/encoding/expand`;

const componentEntry = "/components/mediaTypes/Form/encoding/expand";

const mediaRef: Json = { $ref: "#/components/mediaTypes/Form" };

describe("coverage join of a field refusal under a 3.2 components/mediaTypes media type", () => {
  test("an inline body: the refusal sits at the use site, the component entry related, and joins both ways", () => {
    const { fields, join } = normalizedJoin(
      postSpec({ content: { [form]: mediaRef } }, { mediaTypes: { Form: expandMedia } }, "3.2.0"),
      "3.2",
    );

    expect(join.missing).toEqual([]);
    expect(join.invented).toEqual([]);
    expect(fields).toEqual([{ pointer: expandEntry, related: [componentEntry] }]);
  });

  test("a $ref body: the refusal sits at the body's use site, the component entry then the body's content entry related, and joins both ways", () => {
    const { fields, join } = normalizedJoin(
      postSpec(
        { $ref: "#/components/requestBodies/Create" },
        {
          mediaTypes: { Form: expandMedia },
          requestBodies: { Create: { content: { [form]: mediaRef } } },
        },
        "3.2.0",
      ),
      "3.2",
    );

    expect(join.missing).toEqual([]);
    expect(join.invented).toEqual([]);
    expect(fields).toEqual([
      {
        pointer: useSite,
        related: [
          componentEntry,
          "/components/requestBodies/Create/content/application~1x-www-form-urlencoded/encoding/expand",
        ],
      },
    ]);
  });

  test("guard: a 3.1 inline media type keeps its own Encoding entry and joins both ways", () => {
    const { fields, join } = normalizedJoin(postSpec({ content: { [form]: expandMedia } }), "3.1");

    expect(fields).toEqual([{ pointer: expandEntry, related: [] }]);
    expect(join.missing).toEqual([]);
    expect(join.invented).toEqual([]);
  });

  test("guard: a 3.1 $ref body keeps the m3-fl6r placement and joins both ways", () => {
    const { fields, join } = normalizedJoin(
      postSpec(
        { $ref: "#/components/requestBodies/Create" },
        { requestBodies: { Create: { content: { [form]: expandMedia } } } },
      ),
      "3.1",
    );

    expect(fields).toEqual([
      {
        pointer: useSite,
        related: [
          "/components/requestBodies/Create/content/application~1x-www-form-urlencoded/encoding/expand",
        ],
      },
    ]);
    expect(join.missing).toEqual([]);
    expect(join.invented).toEqual([]);
  });
});

// A flag as `--describe` lists it, named on the wire as in the spec.
const describedFlag = (pointer: string, name: string, location: "header" | "query") => ({
  location,
  name,
  pointer,
  wireName: name,
});

// A spec of `count` path items, each with a shared header, a GET and a POST, root servers and
// security, and a refusal or notice on every path: tens of thousands of walked elements against
// thousands of refusals and notices, the shape that ran for hours on Cloudflare.
const largeJoin = (count: number) => {
  const paths: { [path: string]: Json } = {};
  const commands: Command[] = [];
  const refusals: Json[] = [];
  const notices: Json[] = [];
  const roots = { security: [["k1"], ["k2"]], servers: ["https://a.example", "https://b.example"] };

  for (let index = 0; index < count; index += 1) {
    const path = `/r${String(index)}`;
    const item = `/paths/~1r${String(index)}`;
    const shared = describedFlag(`${item}/parameters/0`, "X-Trace", "header");
    const own = (method: string, names: readonly string[]) =>
      names.map((name, position) =>
        describedFlag(`${item}/${method}/parameters/${String(position)}`, name, "query"),
      );
    paths[path] = {
      get: {
        parameters: [
          { in: "query", name: "a" },
          { in: "query", name: "b" },
        ],
        responses: {
          "200": { description: "ok" },
          "404": { description: "no" },
          "500": { description: "err" },
        },
      },
      parameters: [{ in: "header", name: "X-Trace" }],
      post: {
        parameters: [
          { in: "query", name: "c" },
          { in: "query", name: "d" },
        ],
        requestBody: {
          content: {
            "application/json": { schema: { type: "object" } },
            "application/x-www-form-urlencoded": { schema: { type: "object" } },
          },
        },
        responses: {
          "201": { description: "ok" },
          "400": { description: "bad" },
          "500": { description: "err" },
        },
      },
    };

    // Every fourth POST is refused by a collision at the shared header; every fourth GET has its
    // 500 refused and its POST a form field `f` refused, which the POST lists; every fourth POST
    // body is ignored by notice; every fourth GET drops `b` by notice.
    const variant = index % 4;
    if (variant === 0) {
      refusals.push({
        code: "PRM-02/flag-collision",
        document: entry,
        operation: { method: "POST", path },
        pointer: shared.pointer,
        scope: "operation",
      });
    }

    if (variant === 1) {
      refusals.push(
        { document: entry, pointer: `${item}/get/responses/500`, scope: "element" },
        {
          document: entry,
          pointer: `${item}/post/requestBody/content/application~1x-www-form-urlencoded/encoding/f`,
          scope: "field",
        },
      );
    }

    if (variant === 2) {
      notices.push({
        code: "OPR-10/body-ignored",
        document: entry,
        pointer: `${item}/post/requestBody`,
        scope: "element",
      });
    }

    if (variant === 3) {
      notices.push({
        code: "PRM-09/other",
        document: entry,
        pointer: `${item}/get/parameters/1`,
        scope: "element",
      });
    }

    commands.push(
      command({
        flags: [shared, ...own("get", variant === 3 ? ["a"] : ["a", "b"])],
        path: [`r${String(index)}`, "get"],
        pathTemplate: path,
        pointer: `${item}/get`,
        responses: variant === 1 ? ["200", "404"] : ["200", "404", "500"],
        ...roots,
      }),
    );
    if (variant !== 0) {
      commands.push(
        command({
          flags: [shared, ...own("post", ["c", "d"])],
          method: "POST",
          path: [`r${String(index)}`, "post"],
          pathTemplate: path,
          pointer: `${item}/post`,
          refusedFields:
            variant === 1 ? [{ mediaType: "application/x-www-form-urlencoded", name: "f" }] : [],
          requestMedia:
            variant === 2 ? [] : ["application/json", "application/x-www-form-urlencoded"],
          responses: ["201", "400", "500"],
          ...roots,
        }),
      );
    }
  }

  const spec: Json = {
    components: {
      securitySchemes: {
        k1: { in: "header", name: "K1", type: "apiKey" },
        k2: { in: "header", name: "K2", type: "apiKey" },
      },
    },
    info: { title: "t", version: "1" },
    openapi: "3.1.1",
    paths,
    security: [{ k1: [] }, { k2: [] }],
    servers: [{ url: "https://a.example" }, { url: "https://b.example" }],
  };

  return { commands, notices, refusals, spec };
};

describe("coverage join cost", () => {
  test("the join examines a small multiple of elements plus claims, not their product", () => {
    const paths = 4000;
    const { commands, notices, refusals, spec } = largeJoin(paths);
    const resolution = Effect.runSync(
      resolve({ document: entry, line: "3.1", value: spec }).pipe(Effect.orDie),
    );
    // Per path: the shared header, GET (operation, 2 parameters, 3 responses) and POST (operation,
    // 2 parameters, 2 media, 3 responses); plus 2 root servers and 2 root security alternatives.
    const elements = paths * 15 + 4;
    // The indexed join examines about 26 per element or claim here; a scanning join, billions.
    const budget = 40 * (elements + commands.length + refusals.length + notices.length);
    let comparisons = 0;
    // Abort as soon as the budget is spent; a quadratic join would otherwise run for hours.
    const count = (examined: number) => {
      comparisons += examined;
      if (comparisons > budget) {
        throw new Error(`the join passed ${String(budget)} comparisons`);
      }
    };

    const result = Effect.runSync(
      coverageOf(
        {
          describe: encodeDescription({ commands, describeVersion: 1 }),
          report: JSON.stringify({ notices, refusals }),
          resolution,
        },
        count,
      ).pipe(Effect.orDie),
    );

    expect(result.missing).toEqual([]);
    expect(result.invented).toEqual([]);
    // Two media under each ignored body and `b` on each GET that drops it.
    expect(result.byNotice).toHaveLength((paths / 4) * 3);
    expect(comparisons).toBeLessThanOrEqual(budget);
  });
});
