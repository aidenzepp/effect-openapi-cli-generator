import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { BunCrypto, BunFileSystem, BunPath } from "@effect/platform-bun";
import { Array as Arr, Effect, Exit, Layer, Order, Schema, Scope } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate, GenerateRefused } from "../../src/generate.ts";
import { LoadRefusal } from "../../src/load/budget.ts";
import { makeDocumentSet, maxDocuments, parseDocumentPair } from "../../src/load/document-set.ts";
import type { DocumentPair } from "../../src/load/document-set.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import type { Json } from "../../src/model/pointer.ts";
import { resolve, ResolveRefusal } from "../../src/resolve/index.ts";
import type { ResolveLimits, ResolveMember } from "../../src/resolve/index.ts";
import type { Line as ResolveLine } from "../../src/validate/index.ts";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { RecordedRequest } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// The Milestone 2 witness for the Reference Object and $ref rows (REF-*): one generated package
// per version line, built once, run against the capture server for the sibling rows; the
// resolution rows call `resolve()` in process; the refusal and document-set rows call `generate()`
// in process, the set built from `uri=path` pairs and `--ref-root` as the generator CLI builds it.
// A row the product gets wrong is a `test.todo` with what was observed. The informational rows
// (REF-03, REF-04) get no test here.

const fixtures = nodePath.resolve(import.meta.dir, "../../corpus/fixtures/rows/ref");

type Line = "3.0.4" | "3.1.2" | "3.2.1";

const lines: readonly Line[] = ["3.0.4", "3.1.2", "3.2.1"];

const resolveLine: Record<Line, ResolveLine> = { "3.0.4": "3.0", "3.1.2": "3.1", "3.2.1": "3.2" };

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layerDigest);

const work = nodePath.resolve(import.meta.dir, "../../work/wt-ref");

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

interface Exchange {
  readonly exitCode: number | null;
  readonly requests: readonly RecordedRequest[];
  readonly stdout: string;
}

// One invocation of the line's built CLI against the capture origin, with the requests the capture
// server recorded during it. `runBin` is asynchronous, so the in-process server keeps answering.
const invoke = async (line: Line, args: readonly string[]): Promise<Exchange> => {
  const generated = packages.get(line);
  if (generated === undefined) {
    throw new Error(`no package built for ${line}`);
  }

  const before = capture.requests().length;
  const result = await Effect.runPromise(
    runBin(generated, { args: ["--base-url", origin, ...args], timeoutMs: 30_000 }).pipe(
      Effect.provide(layer),
    ),
  );

  return {
    exitCode: result.exitCode,
    requests: capture.requests().slice(before),
    stdout: text(result.stdout),
  };
};

interface Outcome {
  readonly exitCode: number | null;
  readonly sent: readonly (readonly [string, string, string])[];
}

const outcome = (observed: Exchange): Outcome => ({
  exitCode: observed.exitCode,
  sent: observed.requests.map(
    (request) => [request.method, request.target, text(request.body)] as const,
  ),
});

// A usage error before anything was sent.
const rejectedBeforeSending: Outcome = { exitCode: 2, sent: [] };

const longCode = '"abcdef"';

const shortCode = '"abc"';

const siblingDescription = "sibling-description-5c1e";

// The emitted domain schemas of the line's package, where schema annotations land.
const emittedSchemas = (line: Line): string => {
  const generated = packages.get(line);
  if (generated === undefined) {
    throw new Error(`no package built for ${line}`);
  }

  return nodeFs.readFileSync(nodePath.join(generated.dir, "src/domain/schemas.ts"), "utf-8");
};

describe("REF sibling rows through the built CLI", () => {
  test("REF-05: a required sibling beside a parameter $ref has no effect; the flag stays optional (3.0.4)", async () => {
    const observed = await invoke("3.0.4", ["sibling-required"]);

    expect(outcome(observed)).toEqual({ exitCode: 0, sent: [["GET", "/sibling-required", ""]] });
  }, 60_000);

  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`REF-06: a required sibling beside a parameter $ref has no effect; the flag stays optional (${line})`, async () => {
      const observed = await invoke(line, ["sibling-required"]);

      expect(outcome(observed)).toEqual({ exitCode: 0, sent: [["GET", "/sibling-required", ""]] });
    }, 60_000);
  }

  test("REF-07: a maxLength sibling beside a 3.0 schema $ref is ignored and the long value is sent (3.0.4)", async () => {
    const observed = await invoke("3.0.4", ["schema-sibling", "--body", longCode]);

    expect(outcome(observed)).toEqual({
      exitCode: 0,
      sent: [["POST", "/schema-sibling", longCode]],
    });
  }, 60_000);

  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`REF-08: a maxLength sibling beside a schema $ref applies before send (${line})`, async () => {
      const longer = outcome(await invoke(line, ["schema-sibling", "--body", longCode]));
      const bound = outcome(await invoke(line, ["schema-sibling", "--body", shortCode]));

      expect([longer, bound]).toEqual([
        rejectedBeforeSending,
        { exitCode: 0, sent: [["POST", "/schema-sibling", shortCode]] },
      ]);
    }, 60_000);

    test(`REF-08: a description sibling beside a schema $ref reaches the emitted schema (${line})`, () => {
      expect(emittedSchemas(line).includes(siblingDescription)).toBe(true);
    });
  }

  test("REF-07: a description sibling beside a 3.0 schema $ref is not emitted (3.0.4)", () => {
    expect(emittedSchemas("3.0.4").includes(siblingDescription)).toBe(false);
  });
});

// In process resolution.

const entryUri = Schema.decodeUnknownSync(DocumentUri)("file:///spec/api/openapi.json");

const decodeDocument = Schema.decodeUnknownSync(DocumentUri);

const ok: Json = { "200": { description: "ok" } };

const operation = (extra: Members = {}): Members => ({ responses: ok, ...extra });

const queryParameter = (name: string): Members => ({
  in: "query",
  name,
  schema: { type: "string" },
});

const members = (line: string, extra: Members = {}): Members => ({
  info: { title: "Reference rows", version: "1.0.0" },
  openapi: line,
  paths: {},
  ...extra,
});

// A GET at /a with the given parameters.
const parameterUse = (parameters: readonly Json[]): Members => ({
  paths: { "/a": { get: operation({ parameters: [...parameters] }) } },
});

// A GET at /a with one query parameter of the given schema.
const schemaUse = (schema: Json): Members => parameterUse([{ in: "query", name: "q", schema }]);

interface Member {
  readonly uri: string;
  readonly value: Json;
}

interface Resolved {
  readonly diagnostics: readonly (readonly [string, string, string, string])[];
  readonly failure: readonly [string, string, string, string] | undefined;
  // Each reference as [site pointer, kind, target document, target pointer, hops via].
  readonly references: readonly (readonly [string, string, string, string, number])[];
}

const diagnosticRow = (diagnostic: Diagnostic) =>
  [
    diagnostic.code,
    diagnostic.scope,
    String(diagnostic.document),
    String(diagnostic.pointer),
  ] as const;

const sortedRows = <A extends readonly [string, ...unknown[]]>(rows: readonly A[]): readonly A[] =>
  Arr.sort(
    rows,
    Order.mapInput(Order.String, (row: A) => row[0]),
  );

const resolveSet = (
  line: Line,
  value: Members,
  set: readonly Member[] = [],
  options: { readonly entry?: string; readonly limits?: Partial<ResolveLimits> } = {},
): Resolved => {
  const document = options.entry === undefined ? entryUri : decodeDocument(options.entry);
  const exit = Effect.runSyncExit(
    resolve(
      {
        document,
        line: resolveLine[line],
        members: set.map((member): ResolveMember => ({
          document: decodeDocument(member.uri),
          value: member.value,
        })),
        value,
      },
      options.limits,
    ),
  );

  if (Exit.isSuccess(exit)) {
    return {
      diagnostics: exit.value.diagnostics.map(diagnosticRow),
      failure: undefined,
      references: sortedRows(
        [...exit.value.references.values()].map(
          (reference) =>
            [
              reference.site.pointer,
              reference.kind,
              reference.target.document,
              reference.target.pointer,
              reference.via.length,
            ] as const,
        ),
      ),
    };
  }

  const [refusal] = exit.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" && reason.error instanceof ResolveRefusal ? [reason.error] : [],
  );

  if (refusal === undefined) {
    throw new Error(`resolve died: ${String(exit.cause)}`);
  }

  return { diagnostics: [], failure: diagnosticRow(refusal.diagnostic), references: [] };
};

const entryHref = String(entryUri);

// A use site in the entry whose reference resolves in one hop to a target in the entry.
const useSite = (pointer: string, kind: string, target: string) =>
  [pointer, kind, entryHref, target, 0] as const;

const parameterAt = (index: number) => `/paths/~1a/get/parameters/${index}`;

const targetsOf = (found: Resolved) =>
  found.references.map((reference) => [reference[0], reference[2], reference[3]]);

// The Reference Object positions 3.1 adds (Path Item) and 3.2 adds (Media Type): their components.
const laterComponents = (line: Line): Members => {
  if (line === "3.0.4") {
    return {};
  }

  const pathItems = { PI: { get: operation() } };

  return line === "3.1.2"
    ? { pathItems }
    : { mediaTypes: { M: { schema: { type: "string" } } }, pathItems };
};

// The use sites of the positions `laterComponents` adds.
const laterPaths = (line: Line): Members => {
  if (line === "3.0.4") {
    return {};
  }

  const piped = { $ref: "#/components/pathItems/PI" };
  const media = {
    post: operation({
      requestBody: { content: { "application/json": { $ref: "#/components/mediaTypes/M" } } },
    }),
  };

  return line === "3.1.2" ? { "/piped": piped } : { "/media": media, "/piped": piped };
};

// The refusal when two schemas of one document declare the same $id or $anchor.
const duplicateRefusal = (line: Line, keyword: "$anchor" | "$id", value: string) =>
  resolveSet(
    line,
    members(line, {
      components: { schemas: { A: { [keyword]: value }, B: { [keyword]: value } } },
    }),
  ).failure;

describe("REF rows through resolve()", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`REF-01: a Reference Object resolves in every position the line allows, typed by its position (${line})`, () => {
        const later = line !== "3.0.4";
        const components = {
          callbacks: { C: { "{$request.body#/url}": { post: operation() } } },
          examples: { E: { value: "x" } },
          headers: { H: { schema: { type: "string" } } },
          links: { L: { operationId: "used" } },
          parameters: { P: queryParameter("p") },
          requestBodies: { B: { content: { "text/plain": { schema: { type: "string" } } } } },
          responses: { R: { description: "r" } },
          schemas: { S: { type: "string" } },
          securitySchemes: {
            K: { in: "header", name: "X-Key", type: "apiKey" },
            K2: { $ref: "#/components/securitySchemes/K" },
          },
        };
        const paths = {
          "/a": {
            post: operation({
              callbacks: { c: { $ref: "#/components/callbacks/C" } },
              operationId: "used",
              parameters: [{ $ref: "#/components/parameters/P" }],
              requestBody: { $ref: "#/components/requestBodies/B" },
              responses: {
                "200": { $ref: "#/components/responses/R" },
                "201": {
                  content: {
                    "application/json": {
                      examples: { e: { $ref: "#/components/examples/E" } },
                      schema: { $ref: "#/components/schemas/S" },
                    },
                  },
                  description: "created",
                  headers: { X: { $ref: "#/components/headers/H" } },
                  links: { l: { $ref: "#/components/links/L" } },
                },
              },
            }),
          },
        };
        const document = members(line, {
          components: { ...components, ...laterComponents(line) },
          paths: { ...paths, ...laterPaths(line) },
        });
        const post = "/paths/~1a/post";
        const expected = [
          useSite(
            "/components/securitySchemes/K2",
            "securityScheme",
            "/components/securitySchemes/K",
          ),
          useSite(`${post}/callbacks/c`, "callback", "/components/callbacks/C"),
          useSite(`${post}/parameters/0`, "parameter", "/components/parameters/P"),
          useSite(`${post}/requestBody`, "requestBody", "/components/requestBodies/B"),
          useSite(`${post}/responses/200`, "response", "/components/responses/R"),
          useSite(
            `${post}/responses/201/content/application~1json/examples/e`,
            "example",
            "/components/examples/E",
          ),
          useSite(
            `${post}/responses/201/content/application~1json/schema`,
            "schema",
            "/components/schemas/S",
          ),
          useSite(`${post}/responses/201/headers/X`, "header", "/components/headers/H"),
          useSite(`${post}/responses/201/links/l`, "link", "/components/links/L"),
          ...(later ? [useSite("/paths/~1piped", "pathItem", "/components/pathItems/PI")] : []),
          ...(line === "3.2.1"
            ? [
                useSite(
                  "/paths/~1media/post/requestBody/content/application~1json",
                  "mediaType",
                  "/components/mediaTypes/M",
                ),
              ]
            : []),
        ];
        const found = resolveSet(line, document);

        expect([found.failure, found.diagnostics, found.references]).toEqual([
          undefined,
          [],
          sortedRows(expected),
        ]);
      });

      test(`REF-02: local, relative-file and absolute-URI $ref targets resolve (${line})`, () => {
        const found = resolveSet(
          line,
          members(line, {
            components: { parameters: { P: queryParameter("p") } },
            ...parameterUse([
              { $ref: "#/components/parameters/P" },
              { $ref: "common.json#/Q" },
              { $ref: "https://schemas.example.com/remote.json#/R" },
            ]),
          }),
          [
            { uri: "file:///spec/api/common.json", value: { Q: queryParameter("q") } },
            { uri: "https://schemas.example.com/remote.json", value: { R: queryParameter("r") } },
          ],
        );

        expect([found.failure, found.diagnostics, found.references]).toEqual([
          undefined,
          [],
          [
            [parameterAt(0), "parameter", entryHref, "/components/parameters/P", 0],
            [parameterAt(1), "parameter", "file:///spec/api/common.json", "/Q", 0],
            [parameterAt(2), "parameter", "https://schemas.example.com/remote.json", "/R", 0],
          ],
        ]);
      });

      test(`REF-13: JSON Pointer fragments decode the ~1 and ~0 escapes (${line})`, () => {
        const found = resolveSet(
          line,
          members(line, {
            components: { parameters: { "a/b~c": queryParameter("p") } },
            ...parameterUse([{ $ref: "#/components/parameters/a~1b~0c" }]),
          }),
        );

        expect([found.failure, found.references]).toEqual([
          undefined,
          [
            [
              "/paths/~1a/get/parameters/0",
              "parameter",
              entryHref,
              "/components/parameters/a~1b~0c",
              0,
            ],
          ],
        ]);
      });

      test(`REF-13: a plain-name fragment on a non-schema reference is unresolvable (${line})`, () => {
        const found = resolveSet(
          line,
          members(line, {
            components: { parameters: { foo: queryParameter("p") } },
            ...parameterUse([{ $ref: "#foo" }]),
          }),
        );

        expect(found.failure).toEqual([
          "REF-18/unresolvable",
          "document",
          entryHref,
          "/paths/~1a/get/parameters/0",
        ]);
      });

      test(`REF-18: a schema cycle resolves; it is not an unresolvable chain (${line})`, () => {
        const found = resolveSet(
          line,
          members(line, {
            components: {
              schemas: {
                Node: {
                  properties: { next: { $ref: "#/components/schemas/Node" } },
                  type: "object",
                },
              },
            },
            ...schemaUse({ $ref: "#/components/schemas/Node" }),
          }),
        );

        expect([found.failure, found.references]).toEqual([
          undefined,
          [
            [
              "/components/schemas/Node/properties/next",
              "schema",
              entryHref,
              "/components/schemas/Node",
              0,
            ],
            [
              "/paths/~1a/get/parameters/0/schema",
              "schema",
              entryHref,
              "/components/schemas/Node",
              0,
            ],
          ],
        ]);
      });

      test(`REF-18: a reference chain over the hop limit is refused and one within it resolves (${line})`, () => {
        // P0 to P(links - 1) each refer to the next; P(links) is the parameter.
        const chain = (links: number) =>
          members(line, {
            components: {
              parameters: Object.fromEntries([
                ...Array.from({ length: links }, (_, index): [string, Json] => [
                  `P${index}`,
                  { $ref: `#/components/parameters/P${index + 1}` },
                ]),
                [`P${links}`, queryParameter("p")],
              ]),
            },
            ...parameterUse([{ $ref: "#/components/parameters/P0" }]),
          });
        const limits = { maxHops: 3 };
        const within = resolveSet(line, chain(1), [], { limits });
        const over = resolveSet(line, chain(4), [], { limits });

        expect([within.failure, over.failure]).toEqual([
          undefined,
          ["REF-18/hop-limit", "document", entryHref, "/paths/~1a/get/parameters/0"],
        ]);
      });

      test(`REF-18: resolution over the node budget is refused at the document root (${line})`, () => {
        const found = resolveSet(
          line,
          members(line, {
            components: { parameters: { P: queryParameter("p") } },
            ...parameterUse([{ $ref: "#/components/parameters/P" }]),
          }),
          [],
          { limits: { maxNodes: 5 } },
        );

        expect(found.failure).toEqual(["REF-18/node-budget", "document", entryHref, ""]);
      });
    });
  }

  test("REF-02: a $ref resolved against the entryHref's $self reaches the member at that URI (3.2.1)", () => {
    const found = resolveSet(
      "3.2.1",
      members("3.2.1", {
        $self: "https://example.com/api/openapi.json",
        ...parameterUse([{ $ref: "shared.json#/P" }]),
      }),
      [{ uri: "https://example.com/api/shared.json", value: { P: queryParameter("p") } }],
    );

    expect([found.failure, found.references]).toEqual([
      undefined,
      [
        [
          "/paths/~1a/get/parameters/0",
          "parameter",
          "https://example.com/api/shared.json",
          "/P",
          0,
        ],
      ],
    ]);
  });

  test("REF-05: description and required beside a 3.0 Reference Object are a notice and leave the target unchanged (3.0.4)", () => {
    const found = resolveSet(
      "3.0.4",
      members("3.0.4", {
        components: { parameters: { P: queryParameter("p") } },
        ...parameterUse([
          { $ref: "#/components/parameters/P", description: "ignored", required: true },
        ]),
      }),
    );

    expect([found.diagnostics, found.references]).toEqual([
      [["REF-05/sibling-ignored", "element", entryHref, "/paths/~1a/get/parameters/0"]],
      [["/paths/~1a/get/parameters/0", "parameter", entryHref, "/components/parameters/P", 0]],
    ]);
  });

  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`REF-06: summary and description beside $ref override without a notice; another sibling is a notice (${line})`, () => {
      const exit = Effect.runSyncExit(
        resolve({
          document: entryUri,
          line: resolveLine[line],
          value: members(line, {
            components: { parameters: { P: queryParameter("p") } },
            paths: {
              "/a": {
                get: operation({
                  parameters: [
                    { $ref: "#/components/parameters/P", description: "D", summary: "S" },
                  ],
                }),
              },
              "/b": {
                get: operation({
                  parameters: [{ $ref: "#/components/parameters/P", required: true }],
                }),
              },
            },
          }),
        }),
      );
      const resolution = Exit.isSuccess(exit) ? exit.value : undefined;
      const docs = [...(resolution?.references.values() ?? [])].map((reference) => [
        reference.site.pointer,
        reference.summary,
        reference.description,
      ]);

      expect([resolution?.diagnostics.map(diagnosticRow), docs]).toEqual([
        [["REF-06/sibling-ignored", "element", entryHref, "/paths/~1b/get/parameters/0"]],
        [
          ["/paths/~1a/get/parameters/0", "S", "D"],
          ["/paths/~1b/get/parameters/0", undefined, undefined],
        ],
      ]);
    });
  }

  test("REF-07: nullable beside a 3.0 schema $ref is a notice and the target is the referenced schema (3.0.4)", () => {
    const found = resolveSet(
      "3.0.4",
      members("3.0.4", {
        components: { schemas: { S: { type: "string" } } },
        ...schemaUse({ $ref: "#/components/schemas/S", nullable: true }),
      }),
    );

    expect([found.diagnostics, found.references]).toEqual([
      [["REF-07/sibling-ignored", "element", entryHref, "/paths/~1a/get/parameters/0/schema"]],
      [["/paths/~1a/get/parameters/0/schema", "schema", entryHref, "/components/schemas/S", 0]],
    ]);
  });

  test("REF-10: a relative file reference resolves against the referring file, at each hop (3.0.4)", () => {
    const found = resolveSet(
      "3.0.4",
      members("3.0.4", parameterUse([{ $ref: "../shared/a.json#/P" }])),
      [
        { uri: "file:///spec/shared/a.json", value: { P: { $ref: "b.json#/Q" } } },
        { uri: "file:///spec/shared/b.json", value: { Q: queryParameter("q") } },
        { uri: "file:///spec/api/b.json", value: { Q: queryParameter("wrong") } },
      ],
    );

    expect([found.failure, found.references]).toEqual([
      undefined,
      [["/paths/~1a/get/parameters/0", "parameter", "file:///spec/shared/b.json", "/Q", 1]],
    ]);
  });

  test("REF-11: a schema $ref resolves against the nearest parent $id (3.1.2)", () => {
    const found = resolveSet(
      "3.1.2",
      members("3.1.2", {
        components: {
          schemas: {
            Outer: {
              $defs: { Inner: { $id: "inner.json", type: "string" } },
              $id: "https://example.com/schemas/outer.json",
              properties: { x: { $ref: "inner.json" } },
              type: "object",
            },
          },
        },
        ...schemaUse({ $ref: "#/components/schemas/Outer" }),
      }),
      [{ uri: "file:///spec/api/inner.json", value: { type: "integer" } }],
    );

    expect([found.failure, found.references]).toEqual([
      undefined,
      [
        [
          "/components/schemas/Outer/properties/x",
          "schema",
          entryHref,
          "/components/schemas/Outer/$defs/Inner",
          0,
        ],
        ["/paths/~1a/get/parameters/0/schema", "schema", entryHref, "/components/schemas/Outer", 0],
      ],
    ]);
  });

  test("REF-12: base URI precedence: $self over the retrieval URI, the nearest $id over $self, the retrieval URI when there is no $self (3.2.1)", () => {
    const parameter = queryParameter("p");
    const bySelf = resolveSet(
      "3.2.1",
      members("3.2.1", {
        $self: "https://example.com/api/openapi.json",
        ...parameterUse([{ $ref: "shared.json#/P" }]),
      }),
      [
        { uri: "https://example.com/api/shared.json", value: { P: parameter } },
        { uri: "file:///spec/api/shared.json", value: { P: parameter } },
      ],
    );
    const byId = resolveSet(
      "3.2.1",
      members("3.2.1", {
        $self: "https://example.com/api/openapi.json",
        components: {
          schemas: {
            R: {
              $id: "https://other.example.com/schemas/root.json",
              properties: { leaf: { $ref: "leaf.json" } },
              type: "object",
            },
          },
        },
        ...schemaUse({ $ref: "#/components/schemas/R" }),
      }),
      [
        { uri: "https://other.example.com/schemas/leaf.json", value: { type: "string" } },
        { uri: "https://example.com/api/leaf.json", value: { type: "integer" } },
      ],
    );
    const byRetrieval = resolveSet(
      "3.2.1",
      members("3.2.1", parameterUse([{ $ref: "shared.json#/P" }])),
      [{ uri: "https://example.com/v1/shared.json", value: { P: parameter } }],
      { entry: "https://example.com/v1/openapi.json" },
    );

    expect([targetsOf(bySelf), targetsOf(byId), targetsOf(byRetrieval)]).toEqual([
      [["/paths/~1a/get/parameters/0", "https://example.com/api/shared.json", "/P"]],
      [
        [
          "/components/schemas/R/properties/leaf",
          "https://other.example.com/schemas/leaf.json",
          "",
        ],
        ["/paths/~1a/get/parameters/0/schema", entryHref, "/components/schemas/R"],
      ],
      [["/paths/~1a/get/parameters/0", "https://example.com/v1/shared.json", "/P"]],
    ]);
  });

  test("REF-13: a plain-name fragment on a 3.0 schema reference is unresolvable (3.0.4)", () => {
    const found = resolveSet(
      "3.0.4",
      members("3.0.4", {
        components: { schemas: { S: { type: "string" } } },
        ...schemaUse({ $ref: "#S" }),
      }),
    );

    expect(found.failure).toEqual([
      "REF-18/unresolvable",
      "document",
      entryHref,
      "/paths/~1a/get/parameters/0/schema",
    ]);
  });

  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`REF-13: a plain-name fragment on a schema reference resolves as a $anchor (${line})`, () => {
      const found = resolveSet(
        line,
        members(line, {
          components: { schemas: { S: { $anchor: "foo", type: "string" } } },
          ...schemaUse({ $ref: "#foo" }),
        }),
      );

      expect([found.failure, found.references]).toEqual([
        undefined,
        [["/paths/~1a/get/parameters/0/schema", "schema", entryHref, "/components/schemas/S", 0]],
      ]);
    });

    test(`REF-14: schemas are referenced by $id and by $anchor under an $id (${line})`, () => {
      const found = resolveSet(
        line,
        members(line, {
          components: {
            schemas: {
              S: {
                $defs: { T: { $anchor: "t", type: "string" } },
                $id: "https://example.com/s.json",
                type: "object",
              },
            },
          },
          ...parameterUse([
            { in: "query", name: "q", schema: { $ref: "https://example.com/s.json" } },
            { in: "query", name: "r", schema: { $ref: "https://example.com/s.json#t" } },
          ]),
        }),
      );

      expect([found.failure, found.references]).toEqual([
        undefined,
        [
          ["/paths/~1a/get/parameters/0/schema", "schema", entryHref, "/components/schemas/S", 0],
          [
            "/paths/~1a/get/parameters/1/schema",
            "schema",
            entryHref,
            "/components/schemas/S/$defs/T",
            0,
          ],
        ],
      ]);
    });

    test(`REF-14: two schemas declaring one $id, or one $anchor, are refused (${line})`, () => {
      expect([
        duplicateRefusal(line, "$id", "https://example.com/x.json"),
        duplicateRefusal(line, "$anchor", "a"),
      ]).toEqual([
        ["REF-14/duplicate-id", "document", entryHref, "/components/schemas/B"],
        ["REF-14/duplicate-anchor", "document", entryHref, "/components/schemas/B"],
      ]);
    });

    test(`REF-14: a JSON Pointer crossing a schema $id resolves with a REF-14/pointer-crosses-id notice at the site (${line})`, () => {
      const found = resolveSet(
        line,
        members(line, {
          components: {
            schemas: {
              S: {
                $defs: { T: { type: "string" } },
                $id: "https://example.com/s.json",
                type: "object",
              },
            },
          },
          ...schemaUse({ $ref: "#/components/schemas/S/$defs/T" }),
        }),
      );

      expect([found.failure, found.diagnostics, found.references]).toEqual([
        undefined,
        [["REF-14/pointer-crosses-id", "element", entryHref, "/paths/~1a/get/parameters/0/schema"]],
        [
          [
            "/paths/~1a/get/parameters/0/schema",
            "schema",
            entryHref,
            "/components/schemas/S/$defs/T",
            0,
          ],
        ],
      ]);
    });

    test(`REF-14: a $ref to a $id declared in another supplied document resolves (${line})`, () => {
      const other = "https://other.example.com/schemas.json";
      const found = resolveSet(
        line,
        members(line, schemaUse({ $ref: "https://example.com/schemas/pet" })),
        [
          {
            uri: other,
            value: { $defs: { Pet: { $id: "https://example.com/schemas/pet", type: "object" } } },
          },
        ],
      );

      expect([found.failure, found.references]).toEqual([
        undefined,
        [["/paths/~1a/get/parameters/0/schema", "schema", other, "/$defs/Pet", 0]],
      ]);
    });
  }

  test("REF-17: a reference by the member's $self resolves, and the member's own relative references resolve against its $self (3.2.1)", () => {
    const found = resolveSet(
      "3.2.1",
      members(
        "3.2.1",
        parameterUse([
          { $ref: "https://canonical.example.com/v1/params.json#/components/parameters/P" },
        ]),
      ),
      [
        {
          uri: "https://mirror.example.org/copy.json",
          value: members("3.2.1", {
            $self: "https://canonical.example.com/v1/params.json",
            components: { parameters: { P: { $ref: "common.json#/Q" } } },
          }),
        },
        { uri: "https://canonical.example.com/v1/common.json", value: { Q: queryParameter("q") } },
        { uri: "https://mirror.example.org/common.json", value: { Q: queryParameter("wrong") } },
      ],
    );

    expect([found.failure, found.references]).toEqual([
      undefined,
      [
        [
          "/paths/~1a/get/parameters/0",
          "parameter",
          "https://canonical.example.com/v1/common.json",
          "/Q",
          1,
        ],
      ],
    ]);
  });
});

// In process generation of an entry document and the other documents of its set.

interface Generated {
  readonly commands: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

let counter = 0;

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

interface Case {
  // The entry document, written at `api/openapi.json` under the case directory.
  readonly entry: Members;
  // Files written under the case directory by relative path, each added to the set under the
  // `file:` URL of its real path, unless `refRoot` preloads the directory instead.
  readonly files?: Readonly<Record<string, Members>>;
  // Symbolic links under the case directory by relative path, to absolute targets.
  readonly links?: Readonly<Record<string, string>>;
  // A directory under the case directory given as `--ref-root`.
  readonly refRoot?: string;
  // Further documents of the set by retrieval URI.
  readonly set?: Readonly<Record<string, Members>>;
}

// The diagnostics a failed generation carries: a generation refusal's, or a set load refusal's one.
const refusalDiagnostics = (failure: { readonly _tag: string }): readonly Diagnostic[] => {
  if (failure instanceof GenerateRefused) {
    return failure.diagnostics;
  }

  return failure instanceof LoadRefusal ? [failure.diagnostic] : [];
};

// Writes the case, builds the set from `uri=path` pairs and `--ref-root`, and generates. The
// entry's URI is the `file:` URL of its real path, as the generator CLI gives it. A load refusal
// of the set is returned as the one diagnostic.
const inProcess = async ({ entry, files = {}, links = {}, refRoot, set = {} }: Case) => {
  counter += 1;
  const dir = nodePath.join(work, `case-${counter}`);
  const write = (relative: string, value: Members) => {
    const path = nodePath.join(dir, relative);
    nodeFs.mkdirSync(nodePath.dirname(path), { recursive: true });
    nodeFs.writeFileSync(path, JSON.stringify(value));

    return path;
  };
  const specPath = write("api/openapi.json", entry);
  const configPath = nodePath.join(dir, "author-config.json");
  nodeFs.writeFileSync(configPath, JSON.stringify(authorConfig));

  const filePaths = Object.entries(files).map(([relative, value]) => write(relative, value));

  for (const [relative, target] of Object.entries(links)) {
    const path = nodePath.join(dir, relative);
    nodeFs.mkdirSync(nodePath.dirname(path), { recursive: true });
    nodeFs.symlinkSync(target, path);
  }
  const setPairs = Object.entries(set).map(([uri, value], index) =>
    parseDocumentPair(`${uri}=${write(`set/member-${index}.json`, value)}`),
  );
  const filePairs = filePaths.map((path) =>
    parseDocumentPair(`${pathToFileURL(nodeFs.realpathSync(path)).href}=${path}`),
  );
  const pairs: readonly DocumentPair[] = [...(refRoot === undefined ? filePairs : []), ...setPairs];
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* generateCase() {
      const documents = yield* makeDocumentSet(
        pairs,
        refRoot === undefined ? {} : { refRoot: nodePath.join(dir, refRoot) },
      );

      return yield* generate(
        {
          document: decodeDocument(pathToFileURL(nodeFs.realpathSync(specPath)).href),
          documents,
          generator,
          outDir: nodePath.join(dir, "out"),
          source: { _tag: "File", path: specPath },
          strict: false,
        },
        { document: decodeDocument(pathToFileURL(configPath).href), path: configPath },
      );
    }).pipe(Effect.provide(layer)),
  );

  if (Exit.isSuccess(exit)) {
    return {
      commands: exit.value.report.commandNames.map((command) => String(command.pointer)),
      diagnostics: exit.value.diagnostics,
      dir,
    };
  }

  const errors = exit.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" ? [reason.error] : [],
  );
  const diagnostics = errors.flatMap(refusalDiagnostics);

  if (diagnostics.length === 0) {
    throw new Error(`generate failed: ${String(exit.cause)}`);
  }

  return { commands: [], diagnostics, dir };
};

const summary = (found: Generated) =>
  found.diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.severity,
    diagnostic.scope,
    String(diagnostic.pointer),
  ]);

const fileUrl = (dir: string, relative: string): string =>
  pathToFileURL(nodePath.join(nodeFs.realpathSync(dir), relative)).href;

const validationRow: Record<Line, string> = {
  "3.0.4": "VAL-02/schema-invalid",
  "3.1.2": "VAL-03/schema-invalid",
  "3.2.1": "VAL-04/schema-invalid",
};

describe("REF rows through generate()", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`REF-09: a Reference Object as an Operation, where the field type forbids one, is refused at its $ref (${line})`, async () => {
        const found = await inProcess({
          entry: members(line, {
            paths: { "/a": { get: { $ref: "#/x-operations/get" } } },
            "x-operations": { get: operation() },
          }),
        });

        expect(summary(found)).toEqual([
          [validationRow[line], "refusal", "document", "/paths/~1a/get/$ref"],
        ]);
      }, 60_000);

      test(`REF-15: relative-file references to local files supplied in the set resolve (${line})`, async () => {
        const found = await inProcess({
          entry: members(line, parameterUse([{ $ref: "../shared/common.json#/P" }])),
          files: { "shared/common.json": { P: queryParameter("p") } },
        });

        expect([found.diagnostics, found.commands]).toEqual([[], ["/paths/~1a/get"]]);
      }, 60_000);

      test(`REF-15: relative-file references resolve over the files --ref-root preloads (${line})`, async () => {
        const found = await inProcess({
          entry: members(line, parameterUse([{ $ref: "../shared/common.json#/P" }])),
          files: { "shared/common.json": { P: queryParameter("p") } },
          refRoot: ".",
        });

        expect([found.diagnostics, found.commands]).toEqual([[], ["/paths/~1a/get"]]);
      }, 60_000);

      test(`REF-15: a relative file outside the set is refused with its pointer (${line})`, async () => {
        const found = await inProcess({
          entry: members(line, parameterUse([{ $ref: "../outside/common.json#/P" }])),
          files: { "shared/common.json": { P: queryParameter("p") } },
          refRoot: "shared",
        });

        expect(summary(found)).toEqual([
          ["REF-15/outside-set", "refusal", "document", "/paths/~1a/get/parameters/0"],
        ]);
      }, 60_000);

      test(`REF-15: a link escaping --ref-root is refused (${line})`, async () => {
        const outside = nodePath.join(work, `outside-${line}.json`);
        nodeFs.writeFileSync(outside, JSON.stringify({ P: queryParameter("p") }));

        const found = await inProcess({
          entry: members(line, parameterUse([{ $ref: "../shared/common.json#/P" }])),
          links: { "shared/common.json": outside },
          refRoot: "shared",
        });

        expect(summary(found)).toEqual([["REF-16/outside-root", "refusal", "document", ""]]);
      }, 60_000);

      test(`REF-16: a document supplied under its intended retrieval URI resolves offline (${line})`, async () => {
        const before = capture.requests().length;
        const found = await inProcess({
          entry: members(line, parameterUse([{ $ref: `${origin}/shared.json#/P` }])),
          set: { [`${origin}/shared.json`]: { P: queryParameter("p") } },
        });

        expect([found.diagnostics, found.commands, capture.requests().length - before]).toEqual([
          [],
          ["/paths/~1a/get"],
          0,
        ]);
      }, 60_000);

      test(`REF-16: a $ref to a URI outside the set is refused and no request is made (${line})`, async () => {
        const before = capture.requests().length;
        const found = await inProcess({
          entry: members(line, parameterUse([{ $ref: `${origin}/missing.json#/P` }])),
          set: { [`${origin}/shared.json`]: { P: queryParameter("p") } },
        });

        expect([summary(found), capture.requests().length - before]).toEqual([
          [["REF-16/outside-set", "refusal", "document", "/paths/~1a/get/parameters/0"]],
          0,
        ]);
      }, 60_000);

      test(`REF-18: an unresolvable reference is refused with the referring pointer and the target (${line})`, async () => {
        const found = await inProcess({
          entry: members(line, {
            components: { parameters: { P: queryParameter("p") } },
            ...parameterUse([{ $ref: "#/components/parameters/Missing" }]),
          }),
        });
        const [diagnostic] = found.diagnostics;

        const related = diagnostic?.related?.map((site) => [
          String(site.document),
          String(site.pointer),
        ]);

        expect([summary(found), related]).toEqual([
          [["REF-18/unresolvable", "refusal", "document", "/paths/~1a/get/parameters/0"]],
          [[fileUrl(found.dir, "api/openapi.json"), "/components/parameters/Missing"]],
        ]);
      }, 60_000);
    });
  }

  test("REF-09: a Reference Object as a 3.1 content value is refused at its $ref (3.1.2)", async () => {
    const found = await inProcess({
      entry: members("3.1.2", {
        components: { schemas: { S: { type: "string" } } },
        paths: {
          "/a": {
            post: operation({
              requestBody: {
                content: { "application/json": { $ref: "#/components/schemas/S" } },
              },
            }),
          },
        },
      }),
    });

    expect(summary(found)).toEqual([
      [
        "VAL-03/schema-invalid",
        "refusal",
        "document",
        "/paths/~1a/post/requestBody/content/application~1json/$ref",
      ],
    ]);
  }, 60_000);

  test("REF-09: a Reference Object as a 3.2 content value is a Media Type position and resolves (3.2.1)", async () => {
    const found = await inProcess({
      entry: members("3.2.1", {
        components: { mediaTypes: { M: { schema: { type: "string" } } } },
        paths: {
          "/a": {
            post: operation({
              requestBody: {
                content: { "application/json": { $ref: "#/components/mediaTypes/M" } },
              },
            }),
          },
        },
      }),
    });

    expect([found.diagnostics, found.commands]).toEqual([[], ["/paths/~1a/post"]]);
  }, 60_000);

  test("REF-16: a set over the document limit is refused before anything resolves (3.1.2)", async () => {
    const set = Object.fromEntries(
      Array.from({ length: maxDocuments + 1 }, (_, index) => [
        `https://schemas.example.com/d${index}.json`,
        { P: queryParameter("p") },
      ]),
    );
    const found = await inProcess({ entry: members("3.1.2"), set });

    expect(summary(found)).toEqual([["REF-16/document-limit", "refusal", "document", ""]]);
  }, 60_000);
});
