import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Json } from "../../src/model/pointer.ts";
import { emitCli } from "../../src/emit/cli.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { normalizeSchemas } from "../../src/normalize/schemas.ts";
import { resolve } from "../../src/resolve/index.ts";

// The 3.0 schema fixes of m2-s30fx and m2-s30ro, in process: a `default` that does not conform to
// its schema's type is refused at element scope (S30-27, D-OC3, D-SCH4), the operation is still
// assembled and help omits that default; a 3.0 read-only body property is not offered as a flag
// (S30-31, D-SCH2).

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const config = {
  config: Schema.decodeUnknownSync(AuthorConfig)({
    binName: "s30",
    package: { name: "s30-fixes-cli", version: "0.1.0" },
  }),
  configDocument: Schema.decodeUnknownSync(DocumentUri)("file:///spec/author.json"),
};

type Line = "3.0" | "3.1" | "3.2";

const openapi: Record<Line, string> = { "3.0": "3.0.4", "3.1": "3.1.2", "3.2": "3.2.0" };

// One operation whose JSON body has `properties`, with `components.schemas` beside it.
const documentOf = (line: Line, properties: Json, schemas: Json = {}): Json => ({
  components: { schemas },
  info: { title: "t", version: "1" },
  openapi: openapi[line],
  paths: {
    "/a": {
      post: {
        operationId: "create",
        requestBody: {
          content: { "application/json": { schema: { properties, type: "object" } } },
          required: true,
        },
        responses: { "204": { description: "done" } },
      },
    },
  },
});

const normalizedApi = (line: Line, properties: Json, schemas?: Json) => {
  const value = documentOf(line, properties, schemas);
  const resolution = Effect.runSync(resolve({ document: entry, line, value }));

  return {
    resolution,
    result: Effect.runSync(normalize(resolution, { ...config, checkFindings: [] })),
  };
};

// The refusals of one 3.0 operation whose JSON body property `size` has `size`, and whether the
// operation was assembled with its body.
const normalized = (size: Json) => {
  const { resolution, result } = normalizedApi("3.0", { size });

  return {
    assembled: result.api.operations.map((operation) => operation.body !== undefined),
    refusals: [...resolution.diagnostics, ...result.diagnostics]
      .filter((diagnostic) => diagnostic.severity === "refusal")
      .map((diagnostic) => `${diagnostic.code} ${diagnostic.scope} ${diagnostic.pointer}`),
  };
};

describe("S30-27 a 3.0 default that does not conform to its type", () => {
  const at = "/paths/~1a/post/requestBody/content/application~1json/schema/properties/size";

  test("is refused at element scope; the operation keeps its body", () => {
    expect(normalized({ default: "x", type: "integer" })).toEqual({
      assembled: [true],
      refusals: [`S30-27/nonconforming-default element ${at}`],
    });
  });

  test("a conforming default is not refused", () => {
    expect(normalized({ default: 10, type: "integer" })).toEqual({
      assembled: [true],
      refusals: [],
    });
  });
});

// The flag names of the one planned command, and the plan's diagnostic codes.
const planned = (line: Line, properties: Json, schemas?: Json) => {
  const { api } = normalizedApi(line, properties, schemas).result;
  const plan = Effect.runSync(planNames(api, { ...config, strict: false }));

  return {
    codes: plan.diagnostics.map((diagnostic) => diagnostic.code),
    flags: [...plan.root, ...plan.groups.flatMap((group) => group.commands)].flatMap((command) =>
      command.flags.map((flag) => flag.name),
    ),
  };
};

describe("S30-31 a 3.0 read-only body property", () => {
  const properties: Json = {
    id: { readOnly: true, type: "string" },
    name: { type: "string" },
    owner: { $ref: "#/components/schemas/Owner" },
  };
  const schemas: Json = { Owner: { readOnly: true, type: "string" } };

  test("is not offered as a flag, directly or through one $ref; --body stays", () => {
    expect(planned("3.0", properties, schemas)).toEqual({
      codes: [],
      flags: ["body", "body-file", "name"],
    });
  });

  test("3.1 keeps the flag (SCH-51)", () => {
    expect(planned("3.1", properties, schemas).flags).toEqual([
      "body",
      "body-file",
      "id",
      "name",
      "owner",
    ]);
  });
});

// The emitted CLI module text of the one operation, given the validation copy's edits as
// generation passes them.
const emitted = (line: Line, properties: Json): string => {
  const { resolution, result } = normalizedApi(line, properties);
  const { api } = result;
  const plan = Effect.runSync(planNames(api, { ...config, strict: false }));
  const { validation } = Effect.runSync(normalizeSchemas(resolution));
  const output = Effect.runSync(
    emitCli({ api, config: config.config, plan, validationEdits: validation.edits }),
  );

  return output.files.map((file) => file.content).join("\n");
};

describe("S30-27 help and a refused 3.0 default", () => {
  test("a refused default is not shown in help", () => {
    const text = emitted("3.0", { size: { default: "x", type: "integer" } });
    expect(text).toContain('flags: { size: "body /size" }');
  });

  test("a conforming default is shown", () => {
    expect(emitted("3.0", { size: { default: 10, type: "integer" } })).toContain(
      'flags: { size: "body /size; default: 10" }',
    );
  });

  test("3.1 keeps a default outside its type as an annotation (SCH-49)", () => {
    expect(emitted("3.1", { size: { default: "x", type: "integer" } })).toContain(
      'flags: { size: "body /size; default: x" }',
    );
  });
});
