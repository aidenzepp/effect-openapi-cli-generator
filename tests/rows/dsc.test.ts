import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunCrypto, BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate, GenerateRefused } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import type { Json } from "../../src/model/pointer.ts";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { RecordedRequest } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";
import { setEnv } from "../support/env.ts";

// The Milestone 2 witness for the Discriminator Object rows DSC-01 to DSC-11 and the XML Object
// rows XML-01 to XML-08: one generated package per version line, built once, run against the
// capture server; the generation rows call `generate()` in process. The discriminator is a hint
// only (design D-OQ9): help prints it as the VARIANTS line and validation stays plain
// `oneOf`/`anyOf`; an XML body is opaque and sent byte for byte, and a multipart part typed as XML
// over an object schema is refused (design D-SCH3). A row the product gets wrong is a `test.todo`
// with what was observed.

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

const fixtures = nodePath.join(repoRoot, "corpus/fixtures/rows/dsc");

type Line = "3.0.4" | "3.1.2" | "3.2.1";

const lines: readonly Line[] = ["3.0.4", "3.1.2", "3.2.1"];

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layerDigest);

// Generated packages live under the worktree's git-ignored `work/`, never the system temp
// directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "wt-dsc-"));

const restoreTmpdir = setEnv("TMPDIR", work);

interface Members {
  readonly [key: string]: Json;
}

const readJson = (file: string): Members =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
    nodeFs.readFileSync(file, "utf-8"),
  );

const authorConfig = readJson(nodePath.join(fixtures, "author-config.json"));

const specOf = (line: Line): Members => readJson(nodePath.join(fixtures, `${line}.json`));

const capture = startCaptureServer();

const origin = capture.origins["127.0.0.1"];

const scope = Effect.runSync(Scope.make());

const packages = new Map<Line, GeneratedPackage>();

interface Generated {
  readonly diagnostics: readonly Diagnostic[];
  readonly refused: boolean;
}

// The in-process generation of each line's fixture: the diagnostics its rows assert.
const fixtureRuns = new Map<Line, Generated>();

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const decodeDocument = Schema.decodeUnknownSync(DocumentUri);

let counter = 0;

// In process generation of a document; the diagnostics of a refused run are the refusal's.
const inProcess = async (document: Members): Promise<Generated> => {
  counter += 1;
  const dir = nodePath.join(work, `case-${counter}`);
  nodeFs.mkdirSync(dir, { recursive: true });

  const specPath = nodePath.join(dir, "openapi.json");
  const configPath = nodePath.join(dir, "author-config.json");

  nodeFs.writeFileSync(specPath, JSON.stringify(document));
  nodeFs.writeFileSync(configPath, JSON.stringify(authorConfig));

  const exit = await Effect.runPromiseExit(
    generate(
      {
        document: decodeDocument("file:///fixture/openapi.json"),
        generator,
        outDir: nodePath.join(dir, "out"),
        source: { _tag: "File", path: specPath },
        strict: false,
      },
      { document: decodeDocument("file:///fixture/author-config.json"), path: configPath },
    ).pipe(Effect.provide(layer)),
  );
  nodeFs.rmSync(dir, { force: true, recursive: true });
  if (Exit.isSuccess(exit)) {
    return { diagnostics: exit.value.diagnostics, refused: false };
  }

  const [failure] = exit.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" && reason.error instanceof GenerateRefused ? [reason.error] : [],
  );
  if (failure === undefined) {
    throw new Error(`generate failed for a reason other than a refusal: ${String(exit.cause)}`);
  }

  return { diagnostics: failure.diagnostics, refused: true };
};

// The opaque XML file the operator names with `--body-file`.
const xmlFile = nodePath.join(work, "item.xml");

const xmlText = '<ex:item xmlns:ex="https://example.com/ns" id="1"><note/>é</ex:item>';

beforeAll(async () => {
  nodeFs.writeFileSync(xmlFile, xmlText);

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

  // The fixtures' in-process generations, also one after the other.
  const runs = await Effect.runPromise(
    Effect.forEach(
      lines,
      (line) =>
        Effect.promise(() => inProcess(specOf(line))).pipe(
          Effect.map((found) => [line, found] as const),
        ),
      { concurrency: 1 },
    ),
  );
  for (const [line, found] of runs) {
    fixtureRuns.set(line, found);
  }
}, 900_000);

afterAll(async () => {
  capture.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  nodeFs.rmSync(work, { force: true, recursive: true });
  restoreTmpdir();
});

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf-8");

const header = (request: RecordedRequest, name: string): string | undefined =>
  request.headers.find(([key]) => key.toLowerCase() === name)?.[1];

// What one invocation did: its exit code, stdout and every request it sent.
interface Invoked {
  readonly exitCode: number | null;
  readonly requests: readonly RecordedRequest[];
  readonly stdout: string;
}

// One invocation of the line's built CLI against the capture server. `runBin` is asynchronous, so
// the in-process server keeps answering.
const invoke = async (line: Line, args: readonly string[]): Promise<Invoked> => {
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

// What one invocation did: its exit code and the target and body of every request it sent.
interface Outcome {
  readonly exitCode: number | null;
  readonly sent: readonly (readonly [target: string, body: string])[];
}

// One invocation with `--body`.
const send = async (line: Line, command: string, body: string): Promise<Outcome> => {
  const invoked = await invoke(line, [command, "--body", body]);

  return {
    exitCode: invoked.exitCode,
    sent: invoked.requests.map((request) => [request.target, text(request.body)] as const),
  };
};

// The body went out once, byte for byte as given.
const sentAsGiven = (command: string, body: string): Outcome => ({
  exitCode: 0,
  sent: [[`/${command}`, body]],
});

// A usage error before anything was sent.
const rejectedBeforeSending: Outcome = { exitCode: 2, sent: [] };

// Bodies that tell plain `oneOf` validation from discriminator-driven validation: `mislabeled`
// matches only Cat although its `petType` maps to Dog, `both` matches Cat and Dog, `neither`
// matches no branch.
const bodies = {
  both: '{"bark":true,"meow":true,"petType":"cat"}',
  mislabeled: '{"meow":true,"petType":"dog"}',
  neither: '{"petType":"cat"}',
};

// The XML body sent once per line from `--body-file`; every XML row reads the same invocation.
const xmlRuns = new Map<Line, Promise<Invoked>>();

const xmlSent = (line: Line): Promise<Invoked> => {
  const running = xmlRuns.get(line) ?? invoke(line, ["xml", "--body-file", xmlFile]);
  xmlRuns.set(line, running);

  return running;
};

// The exit code, request count, Content-Type and body text of the line's XML upload.
const xmlUpload = async (line: Line) => {
  const uploaded = await xmlSent(line);
  const [request] = uploaded.requests;

  return [
    uploaded.exitCode,
    uploaded.requests.length,
    request === undefined ? undefined : header(request, "content-type"),
    request === undefined ? undefined : text(request.body),
  ];
};

const uploadedAsGiven = [0, 1, "application/xml", xmlText];

const summary = (diagnostics: readonly Diagnostic[]) =>
  diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.severity,
    diagnostic.scope,
    String(diagnostic.pointer),
  ]);

const fixtureRun = (line: Line): Generated => {
  const found = fixtureRuns.get(line);
  if (found === undefined) {
    throw new Error(`no in-process generation for ${line}`);
  }

  return found;
};

// The diagnostics of one row, and whether the generation as a whole was refused.
const rowOutcome = (found: Generated, row: string) => ({
  diagnostics: summary(found.diagnostics.filter((diagnostic) => diagnostic.row === row)),
  refused: found.refused,
});

const generatedClean = { diagnostics: [], refused: false };

const ok: Members = { "200": { description: "ok" } };

const branchRef = (name: string): Members => ({ $ref: `#/components/schemas/${name}` });

// The fixtures' Cat and Dog components: each requires `petType` and its own boolean.
const pets: Members = {
  Cat: {
    properties: { meow: { type: "boolean" }, petType: { type: "string" } },
    required: ["petType", "meow"],
    type: "object",
  },
  Dog: {
    properties: { bark: { type: "boolean" }, petType: { type: "string" } },
    required: ["petType", "bark"],
    type: "object",
  },
};

// A one-operation document of a line whose JSON request body has the given schema, with the
// fixture's Cat and Dog components.
const withBody = (line: Line, schema: Members): Members => ({
  components: { schemas: pets },
  info: { title: "DSC rows", version: "1.0.0" },
  openapi: line,
  paths: {
    "/a": {
      post: {
        operationId: "a",
        requestBody: { content: { "application/json": { schema } }, required: true },
        responses: ok,
      },
    },
  },
});

// A body over Cat and Dog with a discriminator on `petType` and the given extra fields.
const tagged = (line: Line, discriminator: Members): Members =>
  withBody(line, {
    discriminator: { propertyName: "petType", ...discriminator },
    oneOf: [branchRef("Cat"), branchRef("Dog")],
  });

// A body whose first branch does not require `petType`, so the discriminating property is optional.
const optional = (line: Line, discriminator: Members): Members =>
  withBody(line, {
    discriminator: { propertyName: "petType", ...discriminator },
    oneOf: [
      { properties: { petType: { type: "string" }, purr: { type: "boolean" } }, type: "object" },
      branchRef("Dog"),
    ],
  });

const discriminatorAt =
  "/paths/~1a/post/requestBody/content/application~1json/schema/discriminator";

// The VARIANTS lines of a command's help, trimmed.
const variants = async (line: Line, command: string): Promise<readonly string[]> => {
  const help = await invoke(line, [command, "--help"]);

  return help.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("VARIANTS "));
};

const taggedLine = 'VARIANTS  application/json oneOf by petType: "cat" (Cat), "dog" (Dog)';

const anyTaggedLine = 'VARIANTS  application/json anyOf by petType: "Cat" (Cat), "Dog" (Dog)';

const mixedLine =
  'VARIANTS  application/json oneOf by petType: "cat" (Cat), "Dog" (Dog), oneOf/2 (inline, no petType value)';

const basedLine = 'VARIANTS  application/json allOf by petType: "Hound" (Hound), "Kitty" (Kitty)';

// A one-operation document whose optional multipart body has an object part `doc`, typed
// application/xml by its Encoding Object, with the given schema.
const xmlPartDocument = (line: Line, doc: Members): Members => ({
  info: { title: "XML rows", version: "1.0.0" },
  openapi: line,
  paths: {
    "/a": {
      post: {
        operationId: "a",
        requestBody: {
          content: {
            "multipart/form-data": {
              encoding: { doc: { contentType: "application/xml" } },
              schema: { properties: { doc, name: { type: "string" } }, type: "object" },
            },
          },
          required: false,
        },
        responses: ok,
      },
    },
  },
});

const partAt = "/paths/~1a/post/requestBody/content/multipart~1form-data";

// The XML-01 schema-driven refusal of the `doc` part, and whether the generation was refused.
const xmlPartOutcome = async (line: Line, doc: Members) => {
  const found = await inProcess(xmlPartDocument(line, doc));

  return {
    diagnostics: found.diagnostics
      .filter((diagnostic) => diagnostic.code === "XML-01/schema-driven")
      .map((diagnostic) => [
        diagnostic.code,
        diagnostic.severity,
        diagnostic.scope,
        String(diagnostic.pointer),
        diagnostic.related?.map((key) => String(key.pointer)),
      ]),
    refused: found.refused,
  };
};

// The part is refused at the multipart media type, its contentType first in related; the optional
// body's operation still generates.
const xmlPartRefused = {
  diagnostics: [
    ["XML-01/schema-driven", "refusal", "element", partAt, [`${partAt}/encoding/doc/contentType`]],
  ],
  refused: false,
};

const idProperty: Members = { id: { type: "integer" } };

const docPart = (extra: Members, properties: Members): Members => ({
  properties,
  type: "object",
  ...extra,
});

describe("DSC-01 to XML-08 through the built CLI and generate()", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`DSC-01: the body is asserted as plain oneOf and anyOf whatever the discriminator says (${line})`, async () => {
        const mislabeled = await send(line, "tagged", bodies.mislabeled);
        const both = await send(line, "tagged", bodies.both);
        const anyBoth = await send(line, "any-tagged", bodies.both);
        const anyNeither = await send(line, "any-tagged", bodies.neither);

        expect([mislabeled, both, anyBoth, anyNeither]).toEqual([
          sentAsGiven("tagged", bodies.mislabeled),
          rejectedBeforeSending,
          sentAsGiven("any-tagged", bodies.both),
          rejectedBeforeSending,
        ]);
      }, 60_000);

      test(`DSC-01: tagged help labels each branch by its mapped value and component (${line})`, async () => {
        expect(await variants(line, "tagged")).toEqual([taggedLine]);
      }, 60_000);

      test(`DSC-02: tagged help groups the body branches under the petType property (${line})`, async () => {
        const [found] = await variants(line, "tagged");

        expect(found?.startsWith("VARIANTS  application/json oneOf by petType: ")).toBe(true);
      }, 60_000);

      test(`DSC-03: mapping values naming a component and a URI resolve with no diagnostic (${line})`, () => {
        expect(rowOutcome(fixtureRun(line), "DSC-03")).toEqual(generatedClean);
      });

      test(`DSC-03: an unresolved mapping target refuses the discriminator at element scope and the operation still generates (${line})`, async () => {
        const found = await inProcess(tagged(line, { mapping: { x: "Missing" } }));

        expect(rowOutcome(found, "DSC-03")).toEqual({
          diagnostics: [
            ["DSC-03/unresolved-target", "refusal", "element", `${discriminatorAt}/mapping/x`],
          ],
          refused: false,
        });
      });

      test(`DSC-05: a discriminator on a schema with no oneOf, anyOf or allOf is refused at element scope and the operation still generates (${line})`, async () => {
        const found = await inProcess(
          withBody(line, {
            discriminator: { propertyName: "petType" },
            properties: { petType: { type: "string" } },
            required: ["petType"],
            type: "object",
          }),
        );

        expect(rowOutcome(found, "DSC-05")).toEqual({
          diagnostics: [["DSC-05/no-composition", "refusal", "element", discriminatorAt]],
          refused: false,
        });
      });

      test(`DSC-06: the same bodies are sent or rejected identically with and without the discriminator (${line})`, async () => {
        const outcomes = async (command: string) => [
          await send(line, command, bodies.mislabeled),
          await send(line, command, bodies.both),
          await send(line, command, bodies.neither),
        ];
        const withIt = await outcomes("tagged");
        const without = await outcomes("untagged");

        expect([
          withIt.map(({ exitCode }) => exitCode),
          without.map(({ exitCode }) => exitCode),
        ]).toEqual([
          [0, 2, 2],
          [0, 2, 2],
        ]);
        expect(without[0]).toEqual(sentAsGiven("untagged", bodies.mislabeled));
        expect(withIt[0]).toEqual(sentAsGiven("tagged", bodies.mislabeled));
      }, 60_000);

      test(`DSC-07: an implicit mapping over component branches and an inline branch raises no discriminator diagnostic (${line})`, async () => {
        const found = await inProcess(
          withBody(line, {
            discriminator: { propertyName: "petType" },
            oneOf: [
              branchRef("Cat"),
              {
                properties: { petType: { type: "string" } },
                required: ["petType"],
                type: "object",
              },
            ],
          }),
        );

        expect(
          summary(found.diagnostics.filter((diagnostic) => diagnostic.row.startsWith("DSC-"))),
        ).toEqual([]);
        expect(found.refused).toBe(false);
      });

      test(`DSC-07: an unmapped component branch is labeled by its component name and an inline branch is unlabeled (${line})`, async () => {
        expect([await variants(line, "mixed"), await variants(line, "any-tagged")]).toEqual([
          [mixedLine],
          [anyTaggedLine],
        ]);
      }, 60_000);

      test(`DSC-08: a value that is both a name and a relative URI resolves as a name; ./ forces a URI (${line})`, async () => {
        const name = await inProcess(tagged(line, { mapping: { cat: "Cat" } }));
        const forced = await inProcess(tagged(line, { mapping: { cat: "./Cat" } }));
        const uri = await inProcess(
          tagged(line, { mapping: { cat: "./openapi.json#/components/schemas/Cat" } }),
        );

        expect([
          rowOutcome(name, "DSC-03"),
          rowOutcome(forced, "DSC-03"),
          rowOutcome(uri, "DSC-03"),
        ]).toEqual([
          generatedClean,
          {
            diagnostics: [
              ["DSC-03/unresolved-target", "refusal", "element", `${discriminatorAt}/mapping/cat`],
            ],
            refused: false,
          },
          generatedClean,
        ]);
      });

      if (line !== "3.2.1") {
        test(`DSC-09: a discriminating property the payload schema does not require is refused at element scope; a required one is not (${line})`, async () => {
          const found = await inProcess(optional(line, {}));

          expect([rowOutcome(found, "DSC-09"), rowOutcome(fixtureRun(line), "DSC-09")]).toEqual([
            {
              diagnostics: [
                [
                  "DSC-09/property-not-required",
                  "refusal",
                  "element",
                  `${discriminatorAt}/propertyName`,
                ],
              ],
              refused: false,
            },
            generatedClean,
          ]);
        });
      }

      if (line === "3.2.1") {
        test(`DSC-04: a defaultMapping target resolves with no diagnostic and an unresolved one is refused at element scope (${line})`, async () => {
          const found = await inProcess(tagged(line, { defaultMapping: "Nope" }));

          expect([rowOutcome(fixtureRun(line), "DSC-04"), rowOutcome(found, "DSC-04")]).toEqual([
            generatedClean,
            {
              diagnostics: [
                [
                  "DSC-04/unresolved-target",
                  "refusal",
                  "element",
                  `${discriminatorAt}/defaultMapping`,
                ],
              ],
              refused: false,
            },
          ]);
        });

        test(`DSC-10: an optional discriminating property without defaultMapping is refused at element scope; with one it is not (${line})`, async () => {
          const found = await inProcess(optional(line, {}));

          expect([rowOutcome(found, "DSC-10"), rowOutcome(fixtureRun(line), "DSC-10")]).toEqual([
            {
              diagnostics: [
                ["DSC-10/missing-default-mapping", "refusal", "element", discriminatorAt],
              ],
              refused: false,
            },
            generatedClean,
          ]);
        });
      }

      if (line === "3.0.4") {
        // Hound and Kitty extend Pet through allOf and no operation references either.
        test(`DSC-11: the allOf children of a discriminating base are found among every entry component (${line})`, async () => {
          expect(await variants(line, "based")).toEqual([basedLine]);
        }, 60_000);
      }

      // Every XML row: the schema's `xml` fields are never consulted for an XML body, which is the
      // operator's file sent byte for byte. A multipart part typed `application/xml` over an
      // object schema is built from its schema instead: `--<part>` is a JSON flag sent as a JSON
      // part, with no diagnostic.
      test(`XML-01: an XML body is opaque, so the schema's XML Object is never consulted and the file is sent byte for byte (${line})`, async () => {
        expect(await xmlUpload(line)).toEqual(uploadedAsGiven);
        expect(rowOutcome(fixtureRun(line), "XML-01")).toEqual(generatedClean);
      }, 60_000);

      test(`XML-01: a multipart part with contentType application/xml over an object schema is refused as schema-driven XML at the media type (${line})`, async () => {
        expect(await xmlPartOutcome(line, docPart({}, idProperty))).toEqual(xmlPartRefused);
      });

      test(`XML-02: an XML body is opaque, so xml.name is never consulted and the file is sent byte for byte (${line})`, async () => {
        expect(await xmlUpload(line)).toEqual(uploadedAsGiven);
        expect(rowOutcome(fixtureRun(line), "XML-02")).toEqual(generatedClean);
      }, 60_000);

      test(`XML-02: a multipart part with contentType application/xml whose schema sets xml.name is refused as schema-driven XML at the media type (${line})`, async () => {
        expect(
          await xmlPartOutcome(line, docPart({ xml: { name: "document" } }, idProperty)),
        ).toEqual(xmlPartRefused);
      });

      test(`XML-03: an XML body is opaque, so xml.namespace is never consulted and the file is sent byte for byte (${line})`, async () => {
        expect(await xmlUpload(line)).toEqual(uploadedAsGiven);
        expect(rowOutcome(fixtureRun(line), "XML-03")).toEqual(generatedClean);
      }, 60_000);

      test(`XML-03: a multipart part with contentType application/xml whose schema sets xml.namespace is refused as schema-driven XML at the media type (${line})`, async () => {
        expect(
          await xmlPartOutcome(
            line,
            docPart({ xml: { namespace: "https://example.com/ns" } }, idProperty),
          ),
        ).toEqual(xmlPartRefused);
      });

      test(`XML-04: an XML body is opaque, so xml.prefix is never consulted and the file is sent byte for byte (${line})`, async () => {
        expect(await xmlUpload(line)).toEqual(uploadedAsGiven);
        expect(rowOutcome(fixtureRun(line), "XML-04")).toEqual(generatedClean);
      }, 60_000);

      test(`XML-04: a multipart part with contentType application/xml whose schema sets xml.prefix is refused as schema-driven XML at the media type (${line})`, async () => {
        expect(
          await xmlPartOutcome(
            line,
            docPart({ xml: { namespace: "https://example.com/ns", prefix: "ex" } }, idProperty),
          ),
        ).toEqual(xmlPartRefused);
      });

      test(`XML-05: an XML body is opaque, so xml.attribute is never consulted and the file is sent byte for byte (${line})`, async () => {
        expect(await xmlUpload(line)).toEqual(uploadedAsGiven);
        expect(rowOutcome(fixtureRun(line), "XML-05")).toEqual(generatedClean);
      }, 60_000);

      test(`XML-05: a multipart part with contentType application/xml whose schema sets xml.attribute is refused as schema-driven XML at the media type (${line})`, async () => {
        expect(
          await xmlPartOutcome(
            line,
            docPart({}, { id: { type: "integer", xml: { attribute: true } } }),
          ),
        ).toEqual(xmlPartRefused);
      });

      test(`XML-06: an XML body is opaque, so xml.wrapped is never consulted and the file is sent byte for byte (${line})`, async () => {
        expect(await xmlUpload(line)).toEqual(uploadedAsGiven);
        expect(rowOutcome(fixtureRun(line), "XML-06")).toEqual(generatedClean);
      }, 60_000);

      test(`XML-06: a multipart part with contentType application/xml whose schema sets xml.wrapped is refused as schema-driven XML at the media type (${line})`, async () => {
        expect(
          await xmlPartOutcome(
            line,
            docPart(
              {},
              { tags: { items: { type: "string" }, type: "array", xml: { wrapped: true } } },
            ),
          ),
        ).toEqual(xmlPartRefused);
      });

      if (line === "3.2.1") {
        test(`XML-07: an XML body is opaque, so xml.nodeType is never consulted and the file is sent byte for byte (${line})`, async () => {
          expect(await xmlUpload(line)).toEqual(uploadedAsGiven);
          expect(rowOutcome(fixtureRun(line), "XML-07")).toEqual(generatedClean);
        }, 60_000);

        test(`XML-07: a multipart part with contentType application/xml whose schema sets xml.nodeType is refused as schema-driven XML at the media type (${line})`, async () => {
          expect(
            await xmlPartOutcome(line, docPart({ xml: { nodeType: "element" } }, idProperty)),
          ).toEqual(xmlPartRefused);
        });
      }

      if (line !== "3.0.4") {
        test(`XML-08: an XML body with a nullable property is opaque, so null handling is never applied and the file is sent byte for byte (${line})`, async () => {
          expect(await xmlUpload(line)).toEqual(uploadedAsGiven);
          expect(rowOutcome(fixtureRun(line), "XML-08")).toEqual(generatedClean);
        }, 60_000);

        test(`XML-08: a multipart part with contentType application/xml over a nullable property is refused as schema-driven XML at the media type (${line})`, async () => {
          expect(
            await xmlPartOutcome(line, docPart({}, { note: { type: ["string", "null"] } })),
          ).toEqual(xmlPartRefused);
        });
      }
    });
  }
});
