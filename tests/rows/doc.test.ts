import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Array as Arr, Effect, Exit, Layer, Order, Scope, Schema } from "effect";
import { stringify as yamlStringify } from "yaml";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate, GenerateRefused } from "../../src/generate.ts";
import { makeDocumentSet, parseDocumentPair } from "../../src/load/document-set.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import type { Json } from "../../src/model/pointer.ts";
import { manifestFileName } from "../../src/write/manifest.ts";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { RecordedRequest } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// The Milestone 2 witness for the Document root, Official schema validation and Components rows
// (DOC-*, VAL-*, CMP-*): one generated package per version line, built once, run against the
// capture server; the refusal, notice and multi-document rows call `generate()` in process, the
// document set built from `uri=path` pairs as `--document` builds it. A row the product gets wrong
// is a `test.todo` with what was observed. The delegated rows (DOC-09, CMP-01) and the
// informational rows get no test here.

const fixtures = nodePath.resolve(import.meta.dir, "../../corpus/fixtures/rows/doc");

type Line = "3.0.4" | "3.1.2" | "3.2.1";

const lines: readonly Line[] = ["3.0.4", "3.1.2", "3.2.1"];

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = nodePath.resolve(import.meta.dir, "../../work/wt-doc");

nodeFs.rmSync(work, { force: true, recursive: true });

nodeFs.mkdirSync(work, { recursive: true });

interface Members {
  readonly [key: string]: Json;
}

const readJson = (file: string): Members =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
    nodeFs.readFileSync(file, "utf-8"),
  );

const authorConfig = readJson(nodePath.join(fixtures, "author-config.json"));

const capture = startCaptureServer();

const origin = capture.origins["127.0.0.1"];

const { port } = new URL(origin);

const scope = Effect.runSync(Scope.make());

const packages = new Map<Line, GeneratedPackage>();

beforeAll(async () => {
  // The port is known only once the capture server listens, so the bound origin is added here.
  const configPath = nodePath.join(work, "author-config.json");
  nodeFs.writeFileSync(
    configPath,
    `${JSON.stringify({ ...authorConfig, acceptedOrigins: [origin] })}\n`,
  );

  // One package per line, built one after the other.
  const built = await Effect.runPromise(
    Effect.forEach(
      lines,
      (line) =>
        generateFixture({ configPath, specPath: nodePath.join(fixtures, `${line}.json`) }).pipe(
          Effect.tap(preparePackage),
          Effect.map((generated) => [line, generated] as const),
        ),
      { concurrency: 1 },
    ).pipe(Scope.provide(scope), Effect.provide(layer)),
  );
  for (const [line, generated] of built) {
    packages.set(line, generated);
  }
}, 900_000);

afterAll(async () => {
  capture.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  nodeFs.rmSync(work, { force: true, recursive: true });
});

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf-8");

const rootCanary = "root-canary-7f3a";

const cmpCanary = "cmp-canary-91bc";

interface Exchange {
  readonly exitCode: number | null;
  readonly requests: readonly RecordedRequest[];
  readonly stderr: string;
  readonly stdout: string;
}

// One invocation of the line's built CLI, with the requests the capture server recorded during
// it. Both scheme credentials are always set, because the root requirement applies everywhere.
// `runBin` is asynchronous, so the in-process server keeps answering.
const invoke = async (line: Line, args: readonly string[]): Promise<Exchange> => {
  const generated = packages.get(line);
  if (generated === undefined) {
    throw new Error(`no package built for ${line}`);
  }

  const before = capture.requests().length;
  const result = await Effect.runPromise(
    runBin(generated, {
      args,
      env: { DOC_CMP_KEY: cmpCanary, DOC_ROOT_KEY: rootCanary },
      timeoutMs: 30_000,
    }).pipe(Effect.provide(layer)),
  );

  return {
    exitCode: result.exitCode,
    requests: capture.requests().slice(before),
    stderr: text(result.stderr),
    stdout: text(result.stdout),
  };
};

// An invocation against the capture origin through `--base-url`.
const run = (line: Line, args: readonly string[]): Promise<Exchange> =>
  invoke(line, ["--base-url", origin, ...args]);

// The request line and body of each request an invocation made.
const sent = (observed: Exchange) =>
  observed.requests.map((request) => [request.method, request.target, text(request.body)]);

const header = (observed: Exchange, name: string) =>
  observed.requests.map((request) =>
    request.headers.filter(([candidate]) => candidate.toLowerCase() === name).map(([, v]) => v),
  );

const sorted = (values: readonly string[]): readonly string[] => Arr.sort(values, Order.String);

const pointerToken = (path: string): string => path.replaceAll("~", "~0").replaceAll("/", "~1");

const Describe = Schema.Struct({
  commands: Schema.Array(Schema.Struct({ pointer: Schema.String })),
});

const PathItems = Schema.Struct({
  paths: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)),
});

const jsonBody = '{"a":1}';

// Whether the text holds a C0 or C1 control other than the line feed, or DEL.
const hasControl = (value: string): boolean =>
  Array.from({ length: value.length }, (_, index) => value.codePointAt(index) ?? 0).some(
    (code) => (code < 0x20 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f),
  );

describe("DOC and CMP rows through the built CLI", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`DOC-01: the line's minimal fixture generates a package that type-checks and runs (${line})`, async () => {
        const observed = await invoke(line, ["--help"]);

        expect({ exitCode: observed.exitCode, stderr: observed.stderr }).toEqual({
          exitCode: 0,
          stderr: "",
        });
      }, 60_000);

      test(`DOC-06: the request goes to the selected root server with its variable bound (${line})`, async () => {
        const observed = await invoke(line, [
          "--server",
          "0",
          "--server-variable",
          `port=${port}`,
          "root-secured",
        ]);

        expect({ sent: sent(observed), stderr: observed.stderr }).toEqual({
          sent: [["GET", "/root/root-secured", ""]],
          stderr: "",
        });
      }, 60_000);

      test(`DOC-07: every operation under paths is a command (${line})`, async () => {
        const spec = Schema.decodeUnknownSync(PathItems)(
          readJson(nodePath.join(fixtures, `${line}.json`)),
        );
        const expected = Object.entries(spec.paths).flatMap(([path, item]) =>
          "$ref" in item
            ? ["/components/pathItems/Piped/get"]
            : Object.keys(item).map((method) => `/paths/${pointerToken(path)}/${method}`),
        );
        const observed = await invoke(line, ["--describe"]);
        const { commands } = Schema.decodeUnknownSync(Schema.fromJsonString(Describe))(
          observed.stdout,
        );

        expect(sorted(commands.map((command) => command.pointer))).toEqual(sorted(expected));
      }, 60_000);

      test(`DOC-10: the root security requirement applies to an operation without its own (${line})`, async () => {
        const observed = await run(line, ["root-secured"]);

        expect([sent(observed), header(observed, "x-root-key")]).toEqual([
          [["GET", "/root-secured", ""]],
          [[rootCanary]],
        ]);
      }, 60_000);

      test(`DOC-24: help prints a description holding control characters as inert text (${line})`, async () => {
        const observed = await invoke(line, ["described-get", "--help"]);

        expect({
          controls: hasControl(observed.stdout),
          exitCode: observed.exitCode,
          shown: observed.stdout.includes("Line one"),
        }).toEqual({ controls: false, exitCode: 0, shown: true });
      }, 60_000);

      test(`CMP-02: a parameter schema that references a component reaches the flag through a component Reference (${line})`, async () => {
        const refused = await run(line, ["counted-get", "--count", "abc"]);
        const accepted = await run(line, ["counted-get", "--count", "5"]);

        expect([refused.exitCode === 0, refused.requests.length, sent(accepted)]).toEqual([
          false,
          0,
          [["GET", "/counted?count=5", ""]],
        ]);
      }, 60_000);

      test(`CMP-03: a referenced response supplies the media type the request accepts (${line})`, async () => {
        const observed = await run(line, ["accepted-get"]);

        expect(header(observed, "accept").flat().join(",")).toContain("application/vnd.thing+json");
      }, 60_000);

      test(`CMP-04: a referenced parameter is sent (${line})`, async () => {
        const observed = await run(line, ["things-list", "--limit", "5"]);

        expect(sent(observed)).toEqual([["GET", "/things?limit=5", ""]]);
      }, 60_000);

      test(`CMP-06: a referenced request body is sent with its media type (${line})`, async () => {
        const observed = await run(line, ["things-create", "--body", jsonBody]);

        expect([sent(observed), header(observed, "content-type")]).toEqual([
          [["POST", "/things", jsonBody]],
          [["application/json"]],
        ]);
      }, 60_000);

      test(`CMP-07: a referenced response header is read as the request id (${line})`, async () => {
        capture.script("/traced", {
          body: "",
          headers: [["X-Request-Id", "req-7"]],
          status: 400,
        });

        const observed = await run(line, ["traced-get"]);

        expect({
          exitCode: observed.exitCode === 0,
          requestId: observed.stderr.split("\n").includes("Request ID: req-7"),
        }).toEqual({ exitCode: false, requestId: true });
      }, 60_000);

      test(`CMP-08: a component security scheme named by the operation is applied (${line})`, async () => {
        const observed = await run(line, ["cmp-secured"]);

        expect([sent(observed), header(observed, "x-cmp-key")]).toEqual([
          [["GET", "/cmp-secured", ""]],
          [[cmpCanary]],
        ]);
      }, 60_000);
    });
  }

  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`CMP-11: a paths entry whose $ref targets a component Path Item is a command (${line})`, async () => {
      const observed = await run(line, ["piped-get"]);

      expect(sent(observed)).toEqual([["GET", "/piped", ""]]);
    }, 60_000);
  }

  test("CMP-12: a content value that references a component Media Type is sent (3.2.1)", async () => {
    const observed = await run("3.2.1", ["media-post", "--body", jsonBody]);

    expect([sent(observed), header(observed, "content-type")]).toEqual([
      [["POST", "/media", jsonBody]],
      [["application/json"]],
    ]);
  }, 60_000);
});

// In process generation of a document and the other documents of its set.

const operation = (extra: Members = {}): Members => ({
  responses: { "200": { description: "ok" } },
  ...extra,
});

const members = (line: string, extra: Members = {}): Members => ({
  info: { title: "Document rows", version: "1.0.0" },
  openapi: line,
  paths: { "/a": { get: operation() } },
  ...extra,
});

interface Generated {
  readonly commands: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
  readonly dir: string;
  readonly failure: string | undefined;
}

let counter = 0;

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const decodeDocument = Schema.decodeUnknownSync(DocumentUri);

interface Case {
  // The entry document, or its exact text (a YAML or malformed document) under `text`.
  readonly entry: Members | { readonly text: string };
  // The entry's file name; by default `openapi.json` or `openapi.yaml` after its content.
  readonly file?: string;
  // The other documents of the set, by retrieval URI.
  readonly set?: Readonly<Record<string, Members>>;
}

// Writes the entry and every set member, builds the set from `uri=path` pairs, and generates. The
// entry's URI is the `file:` URL of its real path, as the generator CLI gives it.
const inProcess = async ({ entry, file, set = {} }: Case): Promise<Generated> => {
  counter += 1;
  const dir = nodePath.join(work, `case-${counter}`);
  nodeFs.mkdirSync(dir, { recursive: true });

  const source = "text" in entry && Schema.is(Schema.String)(entry.text) ? entry.text : undefined;
  const specPath = nodePath.join(
    dir,
    file ??
      (source === undefined || source.trimStart().startsWith("{")
        ? "openapi.json"
        : "openapi.yaml"),
  );
  const configPath = nodePath.join(dir, "author-config.json");
  nodeFs.writeFileSync(specPath, source ?? JSON.stringify(entry));
  nodeFs.writeFileSync(configPath, JSON.stringify(authorConfig));

  const pairs = Object.entries(set).map(([uri, value], index) => {
    const path = nodePath.join(dir, `member-${index}.json`);
    nodeFs.writeFileSync(path, JSON.stringify(value));

    return parseDocumentPair(`${uri}=${path}`);
  });
  const outDir = nodePath.join(dir, "out");
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* generateCase() {
      const documents = yield* makeDocumentSet(pairs);

      return yield* generate(
        {
          document: decodeDocument(pathToFileURL(nodeFs.realpathSync(specPath)).href),
          documents,
          generator,
          outDir,
          source: { _tag: "File", path: specPath },
          strict: false,
        },
        { document: decodeDocument(pathToFileURL(configPath).href), path: configPath },
      );
    }).pipe(Effect.provide(layer)),
  );

  if (Exit.isSuccess(exit)) {
    return {
      commands: exit.value.report.commandNames.map((command) => command.pointer),
      diagnostics: exit.value.diagnostics,
      dir: outDir,
      failure: undefined,
    };
  }

  const errors = exit.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" ? [reason.error] : [],
  );
  const [refusal] = errors.flatMap((failure) =>
    failure instanceof GenerateRefused ? [failure] : [],
  );

  if (refusal !== undefined) {
    return { commands: [], diagnostics: refusal.diagnostics, dir: outDir, failure: undefined };
  }

  const [error] = errors;

  if (error === undefined) {
    throw new Error(`generate died: ${String(exit.cause)}`);
  }

  return { commands: [], diagnostics: [], dir: outDir, failure: error._tag };
};

const summary = (found: Generated) =>
  found.diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.severity,
    diagnostic.scope,
    diagnostic.pointer,
  ]);

const related = (found: Generated) =>
  found.diagnostics.map(
    (diagnostic) => diagnostic.related?.map((site) => String(site.pointer)) ?? [],
  );

// The emitted files of a run, by path relative to the output directory, without the report,
// which names the input document and its hash, and the manifest, which hashes the report.
const emitted = (dir: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    sorted(
      nodeFs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => nodePath.relative(dir, nodePath.join(entry.parentPath, entry.name)))
        .filter((file) => file !== "generation-report.json" && file !== manifestFileName),
    ).map((file) => [file, nodeFs.readFileSync(nodePath.join(dir, file), "utf-8")]),
  );

const validationRow: Record<Line, string> = {
  "3.0.4": "VAL-02/schema-invalid",
  "3.1.2": "VAL-03/schema-invalid",
  "3.2.1": "VAL-04/schema-invalid",
};

const majorMinor: Record<Line, string> = { "3.0.4": "3.0", "3.1.2": "3.1", "3.2.1": "3.2" };

const remote = "https://schemas.example.com";

const queryParameter = (name: string): Members => ({
  in: "query",
  name,
  schema: { type: "string" },
});

// A member document that is a full OpenAPI document: its own paths, a parameter and a scheme.
const fullMember = (line: Line): Members =>
  members(line, {
    components: {
      parameters: { P: queryParameter("p") },
      securitySchemes: { memberKey: { in: "header", name: "X-Member", type: "apiKey" } },
    },
    paths: { "/hidden": { get: operation({ operationId: "hidden-get" }) } },
  });

const withMemberParameter = (line: Line, extra: Members = {}): Members =>
  members(line, {
    paths: {
      "/a": {
        get: operation({ parameters: [{ $ref: `${remote}/full.json#/components/parameters/P` }] }),
      },
    },
    ...extra,
  });

const schemaBody = (schema: Json): Members => ({
  paths: {
    "/a": { post: operation({ requestBody: { content: { "application/json": { schema } } } }) },
  },
});

describe("DOC, VAL and CMP rows through generate()", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`DOC-02: the patch digit is ignored, the line follows major.minor (${line})`, async () => {
        const found = await inProcess({ entry: members(`${majorMinor[line]}.9`) });

        expect([found.failure, found.diagnostics, found.commands]).toEqual([
          undefined,
          [],
          ["/paths/~1a/get"],
        ]);
      }, 60_000);

      test(`DOC-13: a document the line's root rule rejects is refused at the root pointer (${line})`, async () => {
        const { paths: _paths, ...bare } = members(line);
        const found = await inProcess({ entry: bare });

        expect(summary(found)).toEqual([[validationRow[line], "refusal", "document", ""]]);
      }, 60_000);

      test(`DOC-14: JSON and YAML texts of one description generate identical packages (${line})`, async () => {
        const description = members(line, {
          components: { schemas: { Thing: { properties: { n: { type: "integer" } } } } },
          paths: {
            "/things/{id}": {
              get: operation({
                parameters: [
                  { in: "path", name: "id", required: true, schema: { type: "string" } },
                ],
              }),
            },
          },
        });
        // One file name for both: the format is sniffed from the content, not the name.
        const fromJson = await inProcess({
          entry: { text: JSON.stringify(description) },
          file: "openapi",
        });
        const fromYaml = await inProcess({
          entry: { text: yamlStringify(description) },
          file: "openapi",
        });

        expect([fromJson.diagnostics, fromYaml.diagnostics]).toEqual([[], []]);
        expect(emitted(fromYaml.dir)).toEqual(emitted(fromJson.dir));
      }, 60_000);

      test(`DOC-14: YAML outside the JSON-compatible subset is refused (${line})`, async () => {
        const head = yamlStringify(members(line));
        const hazards = [
          `${head}info:\n  title: again\n`,
          `${head}---\nsecond: 1\n`,
          `${head}x-key:\n  ? [a, b]\n  : 1\n`,
          `${head}x-time: !!timestamp 2001-12-14\n`,
          `${head}x-bytes: !!binary aGVsbG8=\n`,
          `${head}x-custom: !custom 1\n`,
          `${head}x-inf: .inf\n`,
          `${head}x-nan: .nan\n`,
          `${head}x-alias: &a [*a]\n`,
        ];
        const found = await Effect.runPromise(
          Effect.forEach(
            hazards,
            (entry) => Effect.promise(() => inProcess({ entry: { text: entry } })),
            {
              concurrency: 1,
            },
          ),
        );

        expect(
          found.map((each) => summary(each).map(([code, severity]) => [code, severity])),
        ).toEqual(
          [
            "DOC-14/duplicate-key",
            "DOC-14/yaml-multi-document",
            "DOC-14/yaml-non-string-key",
            "DOC-14/yaml-non-json-tag",
            "DOC-14/yaml-non-json-tag",
            "DOC-14/yaml-non-json-tag",
            "DOC-14/yaml-non-finite",
            "DOC-14/yaml-non-finite",
            "DOC-14/yaml-alias-cycle",
          ].map((code) => [[code, "refusal"]]),
        );
      }, 60_000);

      test(`DOC-14: a duplicate JSON key is refused at its position (${line})`, async () => {
        const entry = `{"info":{"title":"t","version":"1"},"openapi":"${line}","paths":{},"paths":{}}`;
        const found = await inProcess({ entry: { text: entry } });
        const [diagnostic] = found.diagnostics;

        expect([summary(found), diagnostic?.line, diagnostic?.column]).toEqual([
          [["DOC-14/duplicate-key", "refusal", "document", "/paths"]],
          1,
          entry.lastIndexOf('"paths"') + 1,
        ]);
      }, 60_000);

      test(`DOC-15: a Get key under a Path Item is not an operation (${line})`, async () => {
        const found = await inProcess({
          entry: members(line, { paths: { "/a": { Get: operation() } } }),
        });

        expect([summary(found), found.commands]).toEqual([
          [[validationRow[line], "refusal", "document", "/paths/~1a/Get"]],
          [],
        ]);
      }, 60_000);

      test(`DOC-16: behavior the text leaves undefined is refused, not guessed (${line})`, async () => {
        const found = await inProcess({
          entry: members(line, {
            components: {
              schemas: {
                Cat: { properties: { kind: { type: "string" } }, type: "object" },
                Pet: {
                  discriminator: { propertyName: "kind" },
                  oneOf: [{ $ref: "#/components/schemas/Cat" }],
                  properties: { kind: { type: "string" } },
                  type: "object",
                },
              },
            },
            ...schemaBody({ $ref: "#/components/schemas/Pet" }),
          }),
        });

        expect(summary(found)).toEqual([
          line === "3.2.1"
            ? [
                "DSC-10/missing-default-mapping",
                "refusal",
                "element",
                "/components/schemas/Pet/discriminator",
              ]
            : [
                "DSC-09/property-not-required",
                "refusal",
                "element",
                "/components/schemas/Pet/discriminator/propertyName",
              ],
        ]);
      }, 60_000);

      test(`DOC-20: a security scheme name declared only in a referenced document is refused (${line})`, async () => {
        const found = await inProcess({
          entry: withMemberParameter(line, { security: [{ memberKey: [] }] }),
          set: { [`${remote}/full.json`]: fullMember(line) },
        });

        expect(summary(found).filter(([code]) => code === "SEC-09/undeclared-scheme")).toEqual([
          ["SEC-09/undeclared-scheme", "refusal", "element", "/security/0/memberKey"],
        ]);
        expect(found.commands).toEqual([]);
      }, 60_000);

      test(`DOC-21: Path Items under a referenced document's own paths produce no commands (${line})`, async () => {
        const found = await inProcess({
          entry: withMemberParameter(line),
          set: { [`${remote}/full.json`]: fullMember(line) },
        });

        expect([found.diagnostics, found.commands]).toEqual([[], ["/paths/~1a/get"]]);
      }, 60_000);

      test(`DOC-22: a $ref outside the supplied set is refused and nothing is fetched (${line})`, async () => {
        const before = capture.requests().length;
        const found = await inProcess({
          entry: members(line, {
            paths: {
              "/a": { get: operation({ parameters: [{ $ref: `${origin}/remote.json#/P` }] }) },
            },
          }),
        });

        expect([summary(found), capture.requests().length - before]).toEqual([
          [["REF-16/outside-set", "refusal", "document", "/paths/~1a/get/parameters/0"]],
          0,
        ]);
      }, 60_000);

      test(`DOC-23: a recursive schema generates (${line})`, async () => {
        const found = await inProcess({
          entry: members(line, {
            components: {
              schemas: {
                Node: {
                  properties: { next: { $ref: "#/components/schemas/Node" } },
                  type: "object",
                },
              },
            },
            ...schemaBody({ $ref: "#/components/schemas/Node" }),
          }),
        });

        expect([found.diagnostics, found.commands]).toEqual([[], ["/paths/~1a/post"]]);
      }, 60_000);

      test(`DOC-23: a cyclic non-schema reference chain is refused without hanging (${line})`, async () => {
        const found = await inProcess({
          entry: members(line, {
            components: {
              parameters: {
                A: { $ref: "#/components/parameters/B" },
                B: { $ref: "#/components/parameters/A" },
              },
            },
            paths: {
              "/a": { get: operation({ parameters: [{ $ref: "#/components/parameters/A" }] }) },
            },
          }),
        });

        expect(summary(found)).toEqual([
          ["DOC-23/non-schema-cycle", "refusal", "document", "/paths/~1a/get/parameters/0"],
        ]);
      }, 60_000);

      test(`VAL-05: an operationId used twice is refused by the generator's own check (${line})`, async () => {
        const found = await inProcess({
          entry: members(line, {
            paths: {
              "/a": { get: operation({ operationId: "dup" }) },
              "/b": { get: operation({ operationId: "dup" }) },
            },
          }),
        });

        expect([summary(found), related(found)]).toEqual([
          [["OPR-07/duplicate-id", "refusal", "document", "/paths/~1b/get/operationId"]],
          [["/paths/~1a/get/operationId"]],
        ]);
      }, 60_000);

      test(`VAL-05: a template expression without its path parameter is refused by the generator's own check (${line})`, async () => {
        const found = await inProcess({
          entry: members(line, { paths: { "/a/{id}": { get: operation() } } }),
        });

        expect(summary(found)).toEqual([
          ["PTH-03/missing-parameter", "refusal", "operation", "/paths/~1a~1{id}/get"],
        ]);
      }, 60_000);

      test(`VAL-05: a server variable default outside its enum is checked by the generator (${line})`, async () => {
        const found = await inProcess({
          entry: members(line, {
            servers: [
              {
                url: "https://{tier}.example.com",
                variables: { tier: { default: "prod", enum: ["dev", "stage"] } },
              },
            ],
          }),
        });

        expect(summary(found)).toEqual([
          [
            "SRV-12/default-not-in-enum",
            line === "3.0.4" ? "notice" : "refusal",
            "operation",
            "/servers/0/variables/tier",
          ],
        ]);
      }, 60_000);

      test(`CMP-13: a component key outside the key pattern is refused at document scope (${line})`, async () => {
        const found = await inProcess({
          entry: members(line, { components: { schemas: { "bad key": { type: "string" } } } }),
        });

        // 3.0's schema leaves the key alone, so the generator's own check refuses it; the 3.1
        // and 3.2 schemas enforce the pattern and refuse it first.
        expect(summary(found)).toEqual([
          [
            line === "3.0.4" ? "CMP-13/invalid-key" : validationRow[line],
            "refusal",
            "document",
            "/components/schemas/bad key",
          ],
        ]);
      }, 60_000);

      test(`CMP-14: an unreferenced component that would be refused does not refuse generation (${line})`, async () => {
        const stream = { content: { "text/event-stream": { schema: { type: "string" } } } };
        const unused = await inProcess({
          entry: members(line, { components: { requestBodies: { Stream: stream } } }),
        });
        const used = await inProcess({
          entry: members(line, {
            components: { requestBodies: { Stream: stream } },
            paths: {
              "/a": {
                post: operation({ requestBody: { $ref: "#/components/requestBodies/Stream" } }),
              },
            },
          }),
        });

        expect([unused.diagnostics, unused.commands, summary(used)]).toEqual([
          [],
          ["/paths/~1a/get"],
          [["EMT-1/unsupported-body", "refusal", "operation", "/paths/~1a/post"]],
        ]);
      }, 60_000);

      // One node referenced as a Parameter and as a Header generates; 3.0.4 adds one
      // PRM-32/header-percent-encoding notice, the others nothing.
      test.todo(`DOC-19: a component Parameter also referenced as a response Header generates with no refusal vs a refusal naming both pointers (${line})`, () =>
        Promise.resolve());
    });
  }

  test("DOC-02: a two-digit 3.0 patch is accepted per the text with a notice (3.0.4)", async () => {
    const found = await inProcess({ entry: members("3.0.10") });

    expect([summary(found), found.commands]).toEqual([
      [["DOC-02/patch-digits", "notice", "element", "/openapi"]],
      ["/paths/~1a/get"],
    ]);
  }, 60_000);

  test("DOC-02: 2.0, 3.3.0 and a missing openapi field are refused", async () => {
    const { openapi: _openapi, ...unversioned } = members("3.1.2");
    const found = await Effect.runPromise(
      Effect.forEach(
        [members("2.0"), members("3.3.0"), unversioned],
        (entry) => Effect.promise(() => inProcess({ entry })),
        { concurrency: 1 },
      ),
    );

    expect(found.map((each) => [each.failure, nodeFs.existsSync(each.dir)])).toEqual([
      ["UnsupportedOpenApiVersion", false],
      ["UnsupportedOpenApiVersion", false],
      ["UnsupportedOpenApiVersion", false],
    ]);
  }, 60_000);

  // generate() fails with UnsupportedOpenApiVersion, which carries the value only; the CLI prints
  // one `refused: unsupported openapi version` line.
  test.todo("DOC-02: 2.0, 3.3.0 and a missing field fail as UnsupportedOpenApiVersion with no diagnostic vs a refusal with the /openapi pointer and the oas-version section", () =>
    Promise.resolve());

  test("DOC-03: a $ref written against the target's $self resolves (3.2.1)", async () => {
    const found = await inProcess({
      entry: members("3.2.1", {
        paths: {
          "/a": {
            get: operation({
              parameters: [
                { $ref: "https://canonical.example.com/params.json#/components/parameters/P" },
              ],
            }),
          },
        },
      }),
      set: {
        "https://mirror.example.org/copy.json": members("3.2.1", {
          $self: "https://canonical.example.com/params.json",
          components: { parameters: { P: queryParameter("p") } },
        }),
      },
    });

    expect([found.diagnostics, found.commands]).toEqual([[], ["/paths/~1a/get"]]);
  }, 60_000);

  test("DOC-03: a relative $self is resolved against the retrieval URI first (3.2.1)", async () => {
    const found = await inProcess({
      entry: members("3.2.1", {
        paths: {
          "/a": {
            get: operation({
              parameters: [
                { $ref: "https://mirror.example.org/v2/params.json#/components/parameters/P" },
              ],
            }),
          },
        },
      }),
      set: {
        "https://mirror.example.org/v1/copy.json": members("3.2.1", {
          $self: "../v2/params.json",
          components: { parameters: { P: queryParameter("p") } },
        }),
      },
    });

    expect([found.diagnostics, found.commands]).toEqual([[], ["/paths/~1a/get"]]);
  }, 60_000);

  test("DOC-03: a fragment on $self is stripped per the text with a notice (3.2.1)", async () => {
    const found = await inProcess({
      entry: members("3.2.1", { $self: "https://example.com/api.json#top" }),
    });

    expect([summary(found), found.commands]).toEqual([
      [["DOC-03/self-fragment", "notice", "element", "/$self"]],
      ["/paths/~1a/get"],
    ]);
  }, 60_000);

  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`DOC-05: a jsonSchemaDialect outside the OAS dialect ids is refused at its pointer (${line})`, async () => {
      const found = await inProcess({
        entry: members(line, { jsonSchemaDialect: "https://example.com/dialect" }),
      });

      expect(summary(found)).toEqual([
        [validationRow[line], "refusal", "document", "/jsonSchemaDialect"],
      ]);
    }, 60_000);

    test(`DOC-17: a reference into a later supplied document resolves, and a missing target is refused once the set is parsed (${line})`, async () => {
      const set = {
        [`${remote}/first.json`]: { Other: { type: "string" } },
        [`${remote}/second.json`]: { Pet: { type: "object" } },
      };
      const resolved = await inProcess({
        entry: members(line, schemaBody({ $ref: `${remote}/second.json#/Pet` })),
        set,
      });
      const missing = await inProcess({
        entry: members(line, schemaBody({ $ref: `${remote}/second.json#/Missing` })),
        set,
      });

      expect([resolved.diagnostics, summary(missing)]).toEqual([
        [],
        [
          [
            "REF-18/unresolvable",
            "refusal",
            "document",
            "/paths/~1a/post/requestBody/content/application~1json/schema",
          ],
        ],
      ]);
    }, 60_000);

    // The $id index covers the entry only: a $id declared in another supplied document is never
    // found.
    test.todo(`DOC-17: a $ref to a $id declared in a later supplied document is refused as REF-16/outside-set vs resolves (${line})`, () =>
      Promise.resolve());
  }

  test("DOC-05: the OAS dialect ids are accepted, the 3.1 text id with an SCH-01 notice (3.1.2)", async () => {
    const found = await Effect.runPromise(
      Effect.forEach(
        [
          "https://spec.openapis.org/oas/3.1/dialect/base",
          "https://spec.openapis.org/oas/3.1/dialect/2024-11-10",
        ],
        (jsonSchemaDialect) =>
          Effect.promise(() => inProcess({ entry: members("3.1.2", { jsonSchemaDialect }) })),
        { concurrency: 1 },
      ),
    );

    expect(found.map(summary)).toEqual([
      [["SCH-01/dialect-base-id", "notice", "element", "/jsonSchemaDialect"]],
      [],
    ]);
  }, 60_000);

  test("DOC-05: the OAS dialect id is accepted (3.2.1)", async () => {
    const found = await inProcess({
      entry: members("3.2.1", {
        jsonSchemaDialect: "https://spec.openapis.org/oas/3.2/dialect/2026-02-26",
      }),
    });

    expect([found.diagnostics, found.commands]).toEqual([[], ["/paths/~1a/get"]]);
  }, 60_000);

  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`DOC-13: a document with components and no paths is accepted (${line})`, async () => {
      const { paths: _paths, ...bare } = members(line);
      const found = await inProcess({ entry: { ...bare, components: {} } });

      expect([found.failure, found.diagnostics, found.commands]).toEqual([undefined, [], []]);
    }, 60_000);
  }

  test("DOC-13: a 3.0 document with components and no paths is refused at the root pointer (3.0.4)", async () => {
    const { paths: _paths, ...bare } = members("3.0.4");
    const found = await inProcess({ entry: { ...bare, components: {} } });

    expect(summary(found)).toEqual([["VAL-02/schema-invalid", "refusal", "document", ""]]);
  }, 60_000);

  test("DOC-18: a fragment of a bare-map document is typed by the referencing context (3.2.1)", async () => {
    const found = await inProcess({
      entry: members("3.2.1", {
        paths: {
          "/a": { get: operation({ parameters: [{ $ref: `${remote}/parameters.json#/Limit` }] }) },
        },
      }),
      set: {
        [`${remote}/parameters.json`]: {
          Limit: { in: "query", name: "limit", schema: { type: "integer" } },
        },
      },
    });

    expect([found.diagnostics, found.commands]).toEqual([[], ["/paths/~1a/get"]]);
    expect(Object.values(emitted(found.dir)).some((source) => source.includes('"limit"'))).toBe(
      true,
    );
  }, 60_000);

  test("VAL-01: a known disagreement generates with a notice citing both sides (3.0.4)", async () => {
    const found = await inProcess({ entry: members("3.0.10") });

    expect([summary(found), found.commands]).toEqual([
      [["DOC-02/patch-digits", "notice", "element", "/openapi"]],
      ["/paths/~1a/get"],
    ]);
  }, 60_000);

  test("VAL-01: a known disagreement generates with a notice citing both sides (3.1.2)", async () => {
    const found = await inProcess({
      entry: members("3.1.2", {
        jsonSchemaDialect: "https://spec.openapis.org/oas/3.1/dialect/base",
      }),
    });

    expect([summary(found), found.commands]).toEqual([
      [["SCH-01/dialect-base-id", "notice", "element", "/jsonSchemaDialect"]],
      ["/paths/~1a/get"],
    ]);
  }, 60_000);

  test("VAL-01: a known disagreement generates with a notice citing both sides (3.2.1)", async () => {
    const found = await inProcess({
      entry: members("3.2.1", { $self: "https://example.com/api.json#top" }),
    });

    expect([summary(found), found.commands]).toEqual([
      [["DOC-03/self-fragment", "notice", "element", "/$self"]],
      ["/paths/~1a/get"],
    ]);
  }, 60_000);

  test("VAL-02: a 3.0 document failing its schema is refused before generation with the failing pointer (3.0.4)", async () => {
    const found = await inProcess({
      entry: { info: { title: "Document rows" }, openapi: "3.0.4", paths: {} },
    });

    expect([summary(found), nodeFs.existsSync(found.dir)]).toEqual([
      [["VAL-02/schema-invalid", "refusal", "document", "/info"]],
      false,
    ]);
  }, 60_000);

  test("VAL-03: a Schema Object failing schema-base is refused (3.1.2)", async () => {
    const found = await inProcess({
      entry: members("3.1.2", { components: { schemas: { S: { type: "strng" } } } }),
    });

    expect([summary(found), nodeFs.existsSync(found.dir)]).toEqual([
      [["VAL-03/schema-invalid", "refusal", "document", "/components/schemas/S/type"]],
      false,
    ]);
  }, 60_000);

  test("VAL-03: a schema failure the text permits is a notice, not a refusal (3.1.2)", async () => {
    const found = await inProcess({
      entry: members("3.1.2", {
        paths: {
          "/a": {
            get: operation({
              parameters: [
                { allowReserved: true, in: "header", name: "X-R", schema: { type: "string" } },
              ],
            }),
          },
        },
      }),
    });

    expect(
      summary(found).filter(([code]) => code === "PRM-35/allow-reserved-outside-query"),
    ).toEqual([
      [
        "PRM-35/allow-reserved-outside-query",
        "notice",
        "element",
        "/paths/~1a/get/parameters/0/allowReserved",
      ],
    ]);
    expect(found.commands).toEqual(["/paths/~1a/get"]);
  }, 60_000);

  test("VAL-04: a Schema Object failing schema-base is refused (3.2.1)", async () => {
    const found = await inProcess({
      entry: members("3.2.1", { components: { schemas: { S: { type: "strng" } } } }),
    });

    expect([summary(found), nodeFs.existsSync(found.dir)]).toEqual([
      [["VAL-04/schema-invalid", "refusal", "document", "/components/schemas/S/type"]],
      false,
    ]);
  }, 60_000);
});
