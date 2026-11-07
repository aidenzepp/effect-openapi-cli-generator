import { describe, expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { emitCli } from "../../src/emit/cli.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { planNames } from "../../src/names/index.ts";
import { flattenBody } from "../../src/names/flatten.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";

// The format fixes of m2-fmtfx: a 3.1 or 3.2 `format: byte` property is a plain string flag sent
// as given, base64 handling staying with 3.0 `format: byte` and `contentEncoding` (FMT-10); and the
// integer body fields FMT-04 asked about.

type Line = "3.0" | "3.1" | "3.2";

const versions: Record<Line, string> = { "3.0": "3.0.4", "3.1": "3.1.1", "3.2": "3.2.0" };

const document = Schema.decodeUnknownSync(DocumentUri)("file:///fmt/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///fmt/author-config.json");

const config: Schema.Json = {
  binName: "fmt",
  envPrefix: "FMT",
  package: { name: "fmt-cli", version: "1.0.0" },
  servers: { accepted: ["https://api.example.com"] },
};

type Properties = Readonly<Record<string, Schema.Json>>;

const spec = (line: Line, properties: Properties): Schema.Json => ({
  info: { title: "Fmt", version: "1.0.0" },
  openapi: versions[line],
  paths: {
    "/items": {
      post: {
        operationId: "items-create",
        requestBody: {
          content: { "application/json": { schema: { properties, type: "object" } } },
          required: true,
        },
        responses: { "204": { description: "Created." } },
        tags: ["items"],
      },
    },
  },
});

// The formatter may break lines; the structure is what the test pins.
const squeezed = (text: string): string => text.replaceAll(/\s+/gu, " ");

// The emitted `items` module, squeezed, and the emit refusals.
const emitted = (line: Line, properties: Properties) =>
  Effect.runPromise(
    Effect.gen(function* generate() {
      const author = yield* decodeAuthorConfig(config, { document: configDocument });
      const resolution = yield* resolve({ document, line, value: spec(line, properties) });
      const { api } = yield* normalize(resolution, { config: author, configDocument });
      const plan = yield* planNames(api, { config: author, configDocument, strict: false });
      const output = yield* emitCli({ api, config: author, plan });
      const content = output.files.find((file) => file.path === "src/cli/items.ts")?.content;

      return { content: squeezed(content ?? ""), refusals: output.refusals };
    }),
  );

const kinds = (line: Line, properties: Properties) => {
  const result = flattenBody(
    { Root: { properties, type: "object" } },
    { codec: "json", schema: { key: "Root" } },
    line,
  );
  if (Result.isFailure(result)) {
    throw new Error(`flattenBody failed with ${result.failure._tag}`);
  }

  return Object.fromEntries(result.success.flags.map((flag) => [flag.name, flag.kind]));
};

describe("FMT-04 number and integer JSON body fields", () => {
  // Blocked outside this slice: `Input.mergeBody` refuses a field `JsonNumber` whose text is not a
  // digit string ("an integer field is not a digit string"), so a number flag mapped to one is
  // refused at merge. The runtime change comes first; the emit side then follows.
  test.todo("--ratio 0.10000000000000000001 is sent with every digit", () => Promise.resolve());

  test("an int64 integer keeps its digits through Input.int64Flag; a safe one stays Flag.Int", async () => {
    const { content } = await emitted("3.1", {
      count: { type: "integer" },
      total: { format: "int64", type: "integer" },
    });
    expect(content).toContain('total: Input.int64Flag("total").pipe(Flag.optional)');
    expect(content).toContain('count: Flag.Int("count").pipe(Flag.optional)');
  });
});

describe("FMT-10 format: byte on 3.1 and 3.2 is a plain string", () => {
  const properties = {
    encoded: { format: "byte", type: "string" },
    tagged: { contentEncoding: "base64", type: "string" },
  } satisfies Properties;

  test("3.0 byte is a file flag; 3.1 and 3.2 byte is a string flag", () => {
    expect(kinds("3.0", properties)).toMatchObject({ encoded: "file", tagged: "file" });
    expect(kinds("3.1", properties)).toMatchObject({ encoded: "string", tagged: "file" });
    expect(kinds("3.2", properties)).toMatchObject({ encoded: "string", tagged: "file" });
  });

  test.each(["3.1", "3.2"] as const)(
    "%s byte is Flag.String sent as given; contentEncoding base64 stays a FileField",
    async (line) => {
      const { content, refusals } = await emitted(line, properties);
      expect(refusals).toEqual([]);
      expect(content).toContain('Flag.String("encoded")');
      expect(content).toContain('"/encoded": flags.encoded');
      expect(content).not.toContain('flag: "encoded"');
      expect(content).toContain('new Input.FileField({ encoding: "base64", flag: "tagged"');
    },
  );

  test("3.0 byte stays a base64 FileField", async () => {
    const { content } = await emitted("3.0", { encoded: { format: "byte", type: "string" } });
    expect(content).toContain('new Input.FileField({ encoding: "base64", flag: "encoded"');
  });

  test("format: binary on 3.1 is unchanged (BIN-05)", () => {
    expect(kinds("3.1", { blob: { format: "binary", type: "string" } })).toMatchObject({
      blob: "string",
    });
  });
});
