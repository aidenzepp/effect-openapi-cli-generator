import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Array as Arr, Effect, Exit, Layer, Order, Schema, Scope } from "effect";
import { checkCoverage } from "../corpus/tools/coverage.ts";
import { DocumentUri } from "../src/model/brands.ts";
import type { Diagnostic } from "../src/model/diagnostic.ts";
import { GenerationReport } from "../src/report/index.ts";
import { resolve } from "../src/resolve/index.ts";
import { Description } from "../src/runtime-src/runtime/describe.ts";
import { startCaptureServer } from "./fixtures/capture-server.ts";
import type { RecordedRequest } from "./fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "./support/generated-cli.ts";
import type { GeneratedPackage } from "./support/generated-cli.ts";
import { setEnv } from "./support/env.ts";

// The Milestone 2 witness for naming extensions (NMX-6): one 3.1.1 spec whose operations are named
// by Forge and Fern extensions, by tag and operationId, and by the author config, with aliases, one
// malformed value, behaviour extensions and two collisions, generated and built once and run
// against the capture server. A product defect is a `test.todo` with what was observed.

const fixtures = nodePath.resolve(import.meta.dir, "fixtures/specs/naming-extensions");

const specPath = nodePath.join(fixtures, "openapi.json");

// Generated packages live under the worktree's `work/`, never the system temp directory.
const scratch = nodePath.resolve(import.meta.dir, "../work/naming-extensions");

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

// The document URI `generateFixture` gives the spec, so report pointers join with the walk.
const entry = Schema.decodeUnknownSync(DocumentUri)("file:///fixture/openapi.json");

const decodeDescription = Schema.decodeUnknownSync(Schema.fromJsonString(Description));

const decodeMembers = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(GenerationReport));

const utf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const capture = startCaptureServer();

// The retried operation and its control answer 503 on these paths only.
capture.script("/jobs/unavailable", { body: "{}", status: 503 });

capture.script("/reports", { body: "{}", status: 503 });

const origin = capture.origins["127.0.0.1"];

const { port } = new URL(origin);

const buildScope = Effect.runSync(Scope.make());

interface Built {
  readonly describe: string;
  readonly generated: GeneratedPackage;
  readonly report: string;
}

let built: Built | undefined;

let restoreTmpdir: (() => void) | undefined;

const builtPackage = (): Built => {
  if (built === undefined) {
    throw new Error("the naming-extensions package was not built");
  }

  return built;
};

beforeAll(async () => {
  nodeFs.mkdirSync(scratch, { recursive: true });
  restoreTmpdir = setEnv("TMPDIR", scratch);

  // The port is known only once the capture server listens, so the bound origin is added here.
  const configPath = nodePath.join(scratch, "author-config.json");
  const config = decodeMembers(
    nodeFs.readFileSync(nodePath.join(fixtures, "author-config.json"), "utf-8"),
  );
  nodeFs.writeFileSync(configPath, `${JSON.stringify({ ...config, acceptedOrigins: [origin] })}\n`);

  built = await Effect.runPromise(
    Effect.gen(function* build() {
      const generated = yield* generateFixture({ configPath, specPath });
      if (!generated.root.startsWith(scratch)) {
        return yield* Effect.die(`the package was generated outside work/: ${generated.root}`);
      }

      yield* preparePackage(generated);

      const run = yield* runBin(generated, { args: ["--describe"], timeoutMs: 30_000 });
      if (run.exitCode !== 0 || run.timedOut) {
        return yield* Effect.die(`--describe exited ${String(run.exitCode)}`);
      }

      const report = nodeFs.readFileSync(
        nodePath.join(generated.dir, "generation-report.json"),
        "utf-8",
      );

      return { describe: utf8(run.stdout), generated, report };
    }).pipe(Scope.provide(buildScope), Effect.provide(layer)),
  );
}, 600_000);

afterAll(async () => {
  capture.stop();
  await Effect.runPromise(Scope.close(buildScope, Exit.void));
  restoreTmpdir?.();

  nodeFs.rmSync(scratch, { force: true, recursive: true });
});

// The bound server: the spec's one server with the capture server's port.
const serverArgs = ["--server", "0", "--server-variable", `port=${port}`];

const bin = (args: readonly string[]) =>
  runBin(builtPackage().generated, { args, timeoutMs: 30_000 }).pipe(Effect.provide(layer));

const helpOf = (path: readonly string[]) =>
  bin([...path, "--help"]).pipe(Effect.map((run) => utf8(run.stdout)));

// A recorded request without its connection, as bytes: what "byte-identical" compares.
const wire = (request: RecordedRequest) => ({
  body: Buffer.from(request.body).toString("latin1"),
  headers: request.headers,
  method: request.method,
  target: request.target,
});

const line = (request: RecordedRequest) => `${request.method} ${request.target}`;

// One call against the capture server, with the requests recorded during it. Calls run one at a
// time, so the requests recorded between its start and end are its own.
const call = (args: readonly string[]) =>
  Effect.gen(function* callGen() {
    const before = capture.requests().length;
    const result = yield* bin([...serverArgs, ...args]);

    return { result, sent: capture.requests().slice(before) };
  });

// Bins run one at a time, so each call's recorded requests are its own.
const sequential = { concurrency: 1 } as const;

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

// The names under a help text's SUBCOMMANDS heading, in printed order. The section ends at the
// first blank line or the next unindented title, as help sections are delimited.
const subcommandsOf = (help: string): readonly string[] => {
  const lines = help.split("\n");
  const start = lines.indexOf("SUBCOMMANDS");

  if (start === -1) {
    return [];
  }

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((text) => text.trim() === "" || !/^\s/u.test(text));

  return (end === -1 ? rest : rest.slice(0, end)).map((text) => text.trim().split(/\s+/u)[0] ?? "");
};

// Every leaf command path reachable from the root `--help`, depth first in printed order.
const commandPaths = (prefix: readonly string[]): Effect.Effect<readonly string[], unknown> =>
  helpOf(prefix).pipe(
    Effect.flatMap((help) => {
      const children = subcommandsOf(help);

      return children.length === 0
        ? Effect.succeed([prefix.join(" ")])
        : Effect.forEach(children, (child) => commandPaths([...prefix, child]), sequential).pipe(
            Effect.map((nested) => nested.flat()),
          );
    }),
  );

type Command = (typeof Description.Type)["commands"][number];

// A described command without its path: the binding every name of one operation shares.
const bindingOf = ({ path: _path, ...binding }: Command) => binding;

// A report diagnostic as its stable fields (C5).
const stable = (diagnostic: Diagnostic) => ({
  code: diagnostic.code,
  pointer: String(diagnostic.pointer),
  scope: diagnostic.scope,
});

// One expected `commandNames` entry, as the test reads the report: both sources in one string.
const named = (path: string, sources: string, pointer: string, alias: number | null = null) => ({
  alias,
  document: String(entry),
  path,
  pointer,
  sources,
});

const zones = "/paths/~1zones~1{zone_id}/patch";

const widgets = "/paths/~1widgets~1{id}/get";

type Path = readonly string[];

// Each aliased operation's command paths, the primary first, and the arguments one call takes.
const aliased: readonly { readonly args: Path; readonly paths: readonly [Path, ...Path[]] }[] = [
  {
    args: ["z1", "--dry", "--paused", "--ttl", "30", "--x-trace", "t-1"],
    paths: [
      ["zones", "edit"],
      ["dns", "edit-zone"],
      ["legacy", "update-zone"],
    ],
  },
  {
    args: ["w-1"],
    paths: [
      ["inventory", "show-all"],
      ["gadgets", "fetch"],
    ],
  },
];

const curated = [
  "accounts members list",
  "dns edit-zone",
  "dns records create",
  "billing get-invoice",
  "jobs delete-job",
  "users show",
  "pets list-pets",
  "reports list-reports",
  "inventory show-all",
  "gadgets fetch",
  "zones edit",
  "legacy update-zone",
];

describe("naming extensions through the built CLI", () => {
  test("--help lists the curated command paths and no refused operation", async () => {
    const paths = await run(commandPaths([]));

    expect(Arr.sort(paths, Order.String)).toEqual(Arr.sort(curated, Order.String));
  }, 120_000);

  test("the help of the primary and of each alias differs only in the usage line", async () => {
    const helps = await run(
      Effect.forEach(
        aliased,
        ({ paths }) => Effect.forEach(paths, (path) => helpOf(path), sequential),
        sequential,
      ),
    );

    for (const [operation, { paths }] of aliased.entries()) {
      const [primary, ...aliases] = paths;
      const [primaryHelp = [], ...aliasHelps] = (helps[operation] ?? []).map((help) =>
        help.split("\n"),
      );
      const usage = primaryHelp.indexOf("USAGE") + 1;

      expect(usage).toBeGreaterThan(0);
      for (const [index, alias] of aliases.entries()) {
        const renamed = primaryHelp.map((text, at) =>
          at === usage
            ? text.replace(`nmx ${primary.join(" ")} `, `nmx ${alias.join(" ")} `)
            : text,
        );

        expect(aliasHelps[index]?.[usage]).not.toBe(primaryHelp[usage]);
        expect(aliasHelps[index]).toEqual(renamed);
      }
    }
  }, 60_000);

  test("every name of an operation sends byte-identical requests", async () => {
    const calls = await run(
      Effect.forEach(
        aliased,
        ({ args, paths }) => Effect.forEach(paths, (path) => call([...path, ...args]), sequential),
        sequential,
      ),
    );
    const [zoneCalls = [], widgetCalls = []] = calls;

    expect(zoneCalls[0]?.sent.map(line)).toEqual(["PATCH /zones/z1?dry=true"]);
    expect(zoneCalls[0]?.sent.map((request) => wire(request).body)).toEqual([
      '{"paused":true,"ttl":30}',
    ]);
    expect(widgetCalls[0]?.sent.map(line)).toEqual(["GET /widgets/w-1"]);
    for (const operation of calls) {
      const [first, ...rest] = operation.map(({ result, sent }) => ({
        exitCode: result.exitCode,
        sent: sent.map(wire),
      }));

      expect(first?.exitCode).toBe(0);
      for (const other of rest) {
        expect(first).toEqual(other);
      }
    }
  }, 120_000);

  test("--describe lists every name of an operation with equal bindings", () => {
    const { commands } = decodeDescription(builtPackage().describe);
    const byPath = new Map(commands.map((command) => [command.path.join(" "), command]));

    expect(commands.map((command) => command.path.join(" "))).toEqual(curated);
    for (const { paths } of aliased) {
      const [primary, ...aliases] = paths.map((path) => {
        const command = byPath.get(path.join(" "));

        return command === undefined ? undefined : bindingOf(command);
      });

      expect(primary?.flags.length).toBeGreaterThan(0);
      expect(aliases).toEqual(aliases.map(() => primary));
    }
  });

  test("generation-report.json commandNames records the source of every name", () => {
    const { commandNames } = decodeReport(builtPackage().report);
    const entries = commandNames.map((name) => ({
      alias: name.alias ?? null,
      document: String(name.document),
      path: name.path.join(" "),
      pointer: String(name.pointer),
      sources: `${name.group} ${name.command}`,
    }));
    expect(entries).toEqual([
      named(
        "accounts members list",
        "x-forge x-forge",
        "/paths/~1accounts~1{account_id}~1members/get",
      ),
      named("dns edit-zone", "x-forge x-forge", zones, 0),
      named("dns records create", "x-forge x-forge", "/paths/~1dns~1records/post"),
      named("billing get-invoice", "x-fern x-fern", "/paths/~1invoices~1{id}/get"),
      named("jobs delete-job", "tag operationId", "/paths/~1jobs~1{id}/delete"),
      named("users show", "x-forge x-forge", "/paths/~1people~1{id}/get"),
      named("pets list-pets", "tag operationId", "/paths/~1pets/get"),
      named("reports list-reports", "tag operationId", "/paths/~1reports/get"),
      named("inventory show-all", "config config", widgets),
      named("gadgets fetch", "x-forge x-forge", widgets, 0),
      named("zones edit", "x-forge x-forge", zones),
      named("legacy update-zone", "x-fern x-fern", zones, 1),
    ]);
  });

  test("a malformed extension is a naming-invalid notice and the next source names the group", () => {
    const { notices } = decodeReport(builtPackage().report);

    expect(notices.filter((diagnostic) => diagnostic.row === "EXT-01").map(stable)).toEqual([
      {
        code: "EXT-01/naming-invalid",
        pointer: "/paths/~1reports/get/x-forge-group-name",
        scope: "element",
      },
    ]);
  });

  test("behaviour extensions change nothing: no prompt, the hidden operation runs, default retries", async () => {
    const [deleted, retried, control] = await run(
      Effect.forEach(
        [
          ["jobs", "delete-job", "j-1"],
          ["jobs", "delete-job", "unavailable"],
          ["reports", "list-reports"],
        ],
        (args) => call(args),
        sequential,
      ),
    );

    expect(deleted?.result.timedOut).toBe(false);
    expect(deleted?.result.exitCode).toBe(0);
    expect(deleted?.sent.map(line)).toEqual(["DELETE /jobs/j-1"]);
    // A 503 gets the runtime's default treatment, two retries after the first send, exactly as the
    // control operation, which has no extension.
    expect(retried?.sent.map(line)).toEqual(
      Array.from({ length: 3 }, () => "DELETE /jobs/unavailable"),
    );
    expect(control?.sent.map(line)).toEqual(Array.from({ length: 3 }, () => "GET /reports"));
    expect(retried?.result.exitCode).toBe(control?.result.exitCode);
  }, 60_000);

  test("the collisions are refused with OPR-06/command-collision and PRM-02/flag-collision", () => {
    const { refusals } = decodeReport(builtPackage().report);

    expect(refusals.map(stable)).toEqual([
      { code: "OPR-06/command-collision", pointer: "/paths/~1labels/get", scope: "operation" },
      {
        code: "OPR-06/command-collision",
        pointer: "/paths/~1labels~1archive/get/x-forge-aliases/0",
        scope: "operation",
      },
      {
        code: "PRM-02/flag-collision",
        pointer: "/paths/~1projects~1{name}/put/parameters/0",
        scope: "operation",
      },
    ]);
  });

  test("checkCoverage over --describe and the report finds nothing missing or invented", async () => {
    const { describe: describeText, report } = builtPackage();
    const value = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
      nodeFs.readFileSync(specPath, "utf-8"),
    );
    const coverage = await run(
      resolve({ document: entry, line: "3.1", value }).pipe(
        Effect.flatMap((resolution) =>
          checkCoverage({ describe: describeText, report, resolution }),
        ),
      ),
    );

    expect({ invented: coverage.invented, missing: coverage.missing }).toEqual({
      invented: [],
      missing: [],
    });
  });
});
