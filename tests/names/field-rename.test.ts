import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { GenerationReport } from "../../src/report/index.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// A body field flag collision (RQB-03/flag-collision) is resolved by renaming one field's flag in
// the author config: naming.operations[<operationId>].fields[<body pointer>].flag, where the body
// pointer is the field's RFC 6901 pointer from the body root, the one its flag carries.

const golden = nodePath.resolve(import.meta.dir, "../fixtures/golden/users-update");

const JsonRecord = Schema.Record(Schema.String, Schema.Json);

const record = Schema.decodeUnknownSync(JsonRecord);

const readGolden = (file: string) =>
  record(JSON.parse(nodeFs.readFileSync(nodePath.join(golden, file), "utf-8")));

const goldenSpec = readGolden("openapi.json");

const goldenConfig = readGolden("author-config.json");

const goldenOperations = record(record(goldenConfig.naming).operations);

const authorCommands = `import { Command } from "effect/cli";\n\nexport const login = Command.make("login");\n`;

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(GenerationReport));

// The golden spec plus one operation whose body fields `fooBar` and `foo_bar` both fold to --foo-bar.
const spec: Schema.Json = {
  ...goldenSpec,
  paths: {
    ...record(goldenSpec.paths),
    "/things": {
      post: {
        operationId: "things-make",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                properties: { fooBar: { type: "string" }, foo_bar: { type: "string" } },
                type: "object",
              },
            },
          },
          required: true,
        },
        responses: { "204": { description: "Made." } },
        tags: ["things"],
      },
    },
  },
};

const withFields = (fields: Schema.Json): Schema.Json => ({
  ...goldenConfig,
  naming: { byPointer: {}, operations: { ...goldenOperations, "things-make": { fields } } },
});

const utf8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const reportOf = (generated: GeneratedPackage) =>
  Effect.gen(function* read() {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(nodePath.join(generated.dir, "generation-report.json"));

    return decodeReport(text);
  });

// Generates the spec with `config`, then hands the package to `inspect` before the scope removes it.
const generateWith = <A>(
  config: Schema.Json,
  inspect: (generated: GeneratedPackage) => Effect.Effect<A, unknown, FileSystem.FileSystem>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* run() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const inputs = yield* fs.makeTempDirectoryScoped({ prefix: "field-rename-" });
        const specPath = path.join(inputs, "openapi.json");
        const configPath = path.join(inputs, "author-config.json");
        yield* fs.writeFileString(specPath, JSON.stringify(spec));
        yield* fs.writeFileString(configPath, JSON.stringify(config));

        const generated = yield* generateFixture({
          authorFiles: [{ content: authorCommands, path: "custom/commands.ts" }],
          configPath,
          specPath,
        });

        return yield* inspect(generated);
      }),
    ).pipe(Effect.provide(layer)),
  );

const commandPaths = (report: typeof GenerationReport.Type) =>
  report.commandNames.map((entry) => entry.path.join(" "));

describe("author config body field flag renames", () => {
  test("a body field collision is refused with a hint naming the fields key and exact pointer", async () => {
    const report = await generateWith(withFields({}), reportOf);
    const refusal = report.refusals.find((entry) => entry.code === "RQB-03/flag-collision");

    expect(refusal?.operation?.operationId).toBe("things-make");
    expect(refusal?.hint).toContain('naming.operations["things-make"].fields["/foo_bar"].flag');
    expect(commandPaths(report)).not.toContain("things make");
  });

  test("a body pointer no flag carries is an unmatched override at its config pointer", async () => {
    const report = await generateWith(withFields({ "/nope": { flag: "nope" } }), reportOf);
    const unmatched = [...report.notices, ...report.refusals].filter(
      (entry) => entry.code === "CFG-1/unmatched-override",
    );

    expect(unmatched.map((entry) => String(entry.pointer))).toEqual([
      "/naming/operations/things-make/fields/~1nope",
    ]);
  });

  test("the renamed field flag generates and shows in help beside the other field", async () => {
    const observed = await generateWith(
      withFields({ "/foo_bar": { flag: "foo-bar-raw" } }),
      (generated) =>
        Effect.gen(function* inspect() {
          const report = yield* reportOf(generated);
          yield* preparePackage(generated);

          const help = yield* runBin(generated, {
            args: ["things", "make", "--help"],
            timeoutMs: 60_000,
          });

          return { help, report };
        }),
    );
    const stdout = utf8(observed.help.stdout);

    expect(observed.report.refusals.map((entry) => entry.code)).not.toContain(
      "RQB-03/flag-collision",
    );
    expect(commandPaths(observed.report)).toContain("things make");
    expect(observed.help.exitCode).toBe(0);
    expect(stdout).toContain("--foo-bar-raw");
    expect(stdout).toMatch(/--foo-bar(?![\w-])/u);
  }, 600_000);
});
