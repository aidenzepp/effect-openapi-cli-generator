import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { DocumentUri } from "../../src/model/brands.ts";
import type { EncodingRule } from "../../src/model/entities.ts";
import type { Json } from "../../src/model/pointer.ts";
import { normalizeBody } from "../../src/normalize/bodies.ts";
import type { BodyOutcome } from "../../src/normalize/bodies.ts";
import { resolve } from "../../src/resolve/index.ts";
import { diagnoseDocument } from "../../src/validate/index.ts";
import type { Line } from "../../src/validate/index.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const openapi: Record<Line, string> = { "3.0": "3.0.3", "3.1": "3.1.1", "3.2": "3.2.0" };

const site = "/paths/~1a/post/requestBody";

const media = `${site}/content/multipart~1form-data`;

const documentOf = (line: Line, requestBody: Json): Json => ({
  info: { title: "t", version: "1" },
  openapi: openapi[line],
  paths: { "/a": { post: { requestBody, responses: { "200": { description: "ok" } } } } },
});

const normalize = (line: Line, requestBody: Json): BodyOutcome => {
  const value = documentOf(line, requestBody);
  const resolution = Effect.runSync(resolve({ document: entry, line, value }));

  return Effect.runSync(normalizeBody(resolution, { openapi: openapi[line], pointer: site }));
};

const multipart = (
  properties: Record<string, Json>,
  encoding: Record<string, Json> = {},
): Json => ({
  content: { "multipart/form-data": { encoding, schema: { properties, type: "object" } } },
});

const rulesOf = (line: Line, body: Json): ReadonlyMap<string, EncodingRule> => {
  const outcome = normalize(line, body);
  if (outcome._tag !== "Implemented") {
    throw new Error(`expected Implemented, got ${outcome._tag}`);
  }

  const [alternative] = outcome.body.alternatives;

  return new Map(
    (alternative?.encoding ?? []).map((rule) => [
      rule.target.kind === "property" ? rule.target.name : `#${rule.target.index}`,
      rule,
    ]),
  );
};

const ruleOf = (line: Line, body: Json, name: string): EncodingRule => {
  const rule = rulesOf(line, body).get(name);
  if (rule === undefined) {
    throw new Error(`no rule for ${name}`);
  }

  return rule;
};

const refusalOf = (line: Line, body: Json) => {
  const outcome = normalize(line, body);
  if (outcome._tag !== "Refused") {
    throw new Error(`expected Refused, got ${outcome._tag}`);
  }

  return outcome.diagnostics
    .filter((diagnostic) => diagnostic.severity === "refusal")
    .map((diagnostic) => ({
      code: diagnostic.code,
      pointer: String(diagnostic.pointer),
      related: diagnostic.related?.map((related) => String(related.pointer)),
      row: diagnostic.row,
      scope: diagnostic.scope,
    }));
};

const byte: Json = { format: "byte", type: "string" };

const base64: Json = { contentEncoding: "base64", type: "string" };

const transferHeader = (schema: Json) => ({
  file: { headers: { "Content-Transfer-Encoding": { schema } } },
});

describe("ENC-38: format byte on a 3.0 multipart part is a base64 transfer encoding", () => {
  test("ENC-38: a format byte part carries the base64 rule", () => {
    const rule = ruleOf("3.0", multipart({ file: byte }), "file");

    expect(rule.contentEncoding).toBe("base64");
    expect(rule.rows.map(String)).toContain("ENC-38");
  });

  test("ENC-38: an array of format byte items sends every part base64", () => {
    const files: Json = { items: byte, type: "array" };

    expect(ruleOf("3.0", multipart({ files }), "files").contentEncoding).toBe("base64");
  });

  test("ENC-38: format binary and a plain string carry no transfer encoding", () => {
    const rules = rulesOf(
      "3.0",
      multipart({ bin: { format: "binary", type: "string" }, text: {} }),
    );

    expect(rules.get("bin")?.contentEncoding).toBeUndefined();
    expect(rules.get("text")?.contentEncoding).toBeUndefined();
  });
});

describe("ENC-37: contentEncoding on a 3.1 or 3.2 multipart part", () => {
  for (const line of ["3.1", "3.2"] as const) {
    test(`ENC-37: ${line} contentEncoding base64 carries the base64 rule`, () => {
      const rule = ruleOf(line, multipart({ file: base64 }), "file");

      expect(rule.contentEncoding).toBe("base64");
      expect(rule.rows.map(String)).toContain("ENC-37");
    });

    test(`ENC-37: ${line} format byte alone carries no transfer encoding`, () => {
      expect(ruleOf(line, multipart({ file: byte }), "file").contentEncoding).toBeUndefined();
    });

    for (const value of ["binary", "7bit", "8BIT"]) {
      test(`ENC-37: ${line} identity contentEncoding ${value} sends the part raw`, () => {
        const rule = ruleOf(line, multipart({ file: { contentEncoding: value } }), "file");

        expect(rule.contentEncoding).toBeUndefined();
        expect(rule.contentType.map(String)).toEqual(["application/octet-stream"]);
        expect(rule.rows.map(String)).toContain("ENC-37");
      });
    }

    test(`ENC-37: ${line} another contentEncoding refuses the media type it drops`, () => {
      const body = multipart({ file: { contentEncoding: "quoted-printable", type: "string" } });

      expect(refusalOf(line, body)).toEqual([
        {
          code: "ENC-37/unsupported-content-encoding",
          pointer: media,
          related: [`${media}/schema/properties/file/contentEncoding`],
          row: "ENC-37",
          scope: "element",
        },
      ]);
    });
  }
});

describe("ENC-37: a nested part has no place for a transfer encoding", () => {
  test("ENC-37: a 3.2 nested base64 part is refused rather than sent unencoded", () => {
    const meta: Json = { properties: { blob: base64 }, type: "object" };
    const body = multipart(
      { meta },
      { meta: { contentType: "multipart/mixed", encoding: { blob: {} } } },
    );

    expect(refusalOf("3.2", body)).toEqual([
      {
        code: "ENC-37/nested-transfer-encoding",
        pointer: media,
        related: [`${media}/encoding/meta/encoding/blob`],
        row: "ENC-37",
        scope: "element",
      },
    ]);
  });

  test("ENC-37: a 3.2 nested identity part is sent raw", () => {
    const meta: Json = { properties: { blob: { contentEncoding: "binary" } }, type: "object" };
    const body = multipart(
      { meta },
      { meta: { contentType: "multipart/mixed", encoding: { blob: {} } } },
    );

    expect(ruleOf("3.2", body, "meta").nested?.length).toBe(1);
  });
});

describe("ENC-39: a Content-Transfer-Encoding header schema against the part's encoding", () => {
  test("ENC-39: a 3.0 enum without base64 is refused at the header schema", () => {
    const body = multipart({ file: byte }, transferHeader({ enum: ["7bit"], type: "string" }));

    expect(refusalOf("3.0", body)).toEqual([
      {
        code: "ENC-39/conflicting-transfer-encoding",
        pointer: media,
        related: [`${media}/encoding/file/headers/Content-Transfer-Encoding/schema/enum`],
        row: "ENC-39",
        scope: "element",
      },
    ]);
  });

  test("ENC-39: a 3.1 const other than base64 is refused at the header schema", () => {
    const body = multipart({ file: base64 }, transferHeader({ const: "binary", type: "string" }));

    expect(refusalOf("3.1", body)).toEqual([
      {
        code: "ENC-39/conflicting-transfer-encoding",
        pointer: media,
        related: [`${media}/encoding/file/headers/Content-Transfer-Encoding/schema/const`],
        row: "ENC-39",
        scope: "element",
      },
    ]);
  });

  test("ENC-39: a header schema that admits base64 is accepted", () => {
    const enumBody = multipart(
      { file: byte },
      transferHeader({ enum: ["base64"], type: "string" }),
    );
    const constBody = multipart({ file: base64 }, transferHeader({ const: "BASE64" }));

    expect(ruleOf("3.0", enumBody, "file").contentEncoding).toBe("base64");
    expect(ruleOf("3.2", constBody, "file").contentEncoding).toBe("base64");
  });
});

describe("ENC-41: 3.1 keywords in a 3.0 multipart schema", () => {
  test("ENC-41: contentEncoding in a 3.0 part schema stays refused by 3.0 schema validation", async () => {
    const body = multipart({ file: { contentEncoding: "identity", type: "string" } });
    const diagnosis = await Effect.runPromise(diagnoseDocument(documentOf("3.0", body), entry));

    expect(
      diagnosis.refusals.map(({ diagnostic }) => ({
        code: diagnostic.code,
        pointer: String(diagnostic.pointer),
        scope: diagnostic.scope,
      })),
    ).toEqual([
      {
        code: "VAL-02/schema-invalid",
        pointer: `${media}/schema/properties/file/contentEncoding`,
        scope: "document",
      },
    ]);
  });
});

// Design 8.5 rule 2: ENC-40 on a named part follows the form property rules (field scope when the
// part is optional, the alternative dropped when it is required); a 3.2 positional entry is not a
// field and keeps element scope.
const tagsBody = (required: readonly string[]): Json => ({
  content: {
    "multipart/form-data": {
      encoding: { tags: { style: "spaceDelimited" } },
      schema: {
        properties: {
          note: { type: "string" },
          tags: { items: { type: "string" }, type: "array" },
        },
        required,
        type: "object",
      },
    },
  },
});

const implemented = (line: Line, body: Json) => {
  const outcome = normalize(line, body);
  if (outcome._tag !== "Implemented") {
    throw new Error(`expected Implemented, got ${outcome._tag}`);
  }

  return outcome;
};

const located = (outcome: BodyOutcome) =>
  outcome.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    pointer: String(diagnostic.pointer),
    scope: diagnostic.scope,
  }));

describe("ENC-40: a part style the writer cannot send", () => {
  for (const line of ["3.1", "3.2"] as const) {
    test(`ENC-40: ${line} an optional named part is refused at field scope and the alternative stays`, () => {
      const outcome = implemented(line, tagsBody([]));

      expect(outcome.body.alternatives[0]?.refusedFields?.map(String)).toEqual(["tags"]);
      expect(located(outcome)).toEqual([
        {
          code: "ENC-40/unsupported-part-style",
          pointer: `${media}/encoding/tags`,
          scope: "field",
        },
      ]);
    });

    test(`ENC-40: ${line} a required named part drops the alternative`, () => {
      expect(refusalOf(line, tagsBody(["tags"]))).toEqual([
        {
          code: "ENC-40/unsupported-part-style",
          pointer: media,
          related: [`${media}/encoding/tags`],
          row: "ENC-40",
          scope: "element",
        },
      ]);
    });
  }

  test("ENC-40: a 3.2 positional entry keeps element scope and is no field", () => {
    const outcome = implemented("3.2", {
      content: { "multipart/form-data": { prefixEncoding: [{ style: "spaceDelimited" }] } },
    });

    expect(outcome.body.alternatives[0]?.refusedFields).toBeUndefined();
    expect(located(outcome)).toEqual([
      {
        code: "ENC-40/unsupported-part-style",
        pointer: `${media}/prefixEncoding/0`,
        scope: "element",
      },
    ]);
  });
});
