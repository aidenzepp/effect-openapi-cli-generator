import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import type { EncodingRule, MediaAlternative } from "../../src/model/entities.ts";
import { normalizeBody } from "../../src/normalize/bodies.ts";
import type { BodyOutcome } from "../../src/normalize/bodies.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";
import type { Line } from "../../src/validate/index.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const openapi: Record<Line, string> = { "3.0": "3.0.3", "3.1": "3.1.1", "3.2": "3.2.0" };

const lines: readonly Line[] = ["3.0", "3.1", "3.2"];

const formMedia = "application/x-www-form-urlencoded";

const media = "/paths/~1a/post/requestBody/content/application~1x-www-form-urlencoded";

interface Members {
  readonly [key: string]: Json;
}

const normalize = (line: Line, requestBody: Json): BodyOutcome => {
  const value: Json = {
    info: { title: "t", version: "1" },
    openapi: openapi[line],
    paths: { "/a": { post: { requestBody, responses: { "200": { description: "ok" } } } } },
  };
  const resolution = Effect.runSync(resolve({ document: entry, line, value }));

  return Effect.runSync(
    normalizeBody(resolution, { openapi: openapi[line], pointer: "/paths/~1a/post/requestBody" }),
  );
};

const form = (properties: Members, extra: Members = {}): Json => ({
  content: { [formMedia]: { schema: { properties, type: "object" }, ...extra } },
  required: true,
});

const implemented = (line: Line, requestBody: Json) => {
  const outcome = normalize(line, requestBody);
  if (outcome._tag !== "Implemented") {
    throw new Error(`expected Implemented, got ${outcome._tag}`);
  }

  return outcome;
};

const only = <T>(values: readonly T[]): T => {
  const [first] = values;
  if (first === undefined || values.length !== 1) {
    throw new Error(`expected exactly one value, got ${values.length}`);
  }

  return first;
};

const alternative = (line: Line, requestBody: Json): MediaAlternative =>
  only(implemented(line, requestBody).body.alternatives);

const ruleOf = (found: MediaAlternative, name: string): EncodingRule => {
  const rule = found.encoding.find(
    (candidate) => candidate.target.kind === "property" && candidate.target.name === name,
  );
  if (rule === undefined) {
    throw new Error(`no rule for ${name}`);
  }

  return rule;
};

const rowsOf = (rule: EncodingRule): readonly string[] => rule.rows.map(String);

// The expected rows a list lacks; empty when it holds them all.
const missing = (rows: readonly string[], expected: readonly string[]): readonly string[] =>
  expected.filter((row) => !rows.includes(row));

const targets = (found: MediaAlternative): readonly string[] =>
  found.encoding.map((rule) =>
    rule.target.kind === "property" ? rule.target.name : `#${rule.target.index}`,
  );

const typeOf = (rule: EncodingRule): readonly string[] => rule.contentType.map(String);

const findings = (diagnostics: readonly Diagnostic[]) =>
  diagnostics.map((diagnostic) => [
    String(diagnostic.pointer),
    diagnostic.code,
    diagnostic.scope,
    diagnostic.severity,
  ]);

const string: Json = { type: "string" };

const tags: Json = { items: string, type: "array" };

describe("ENC-12 ENC-13 a form-urlencoded body with explicit style rules", () => {
  const body = form(
    { q: string, tags },
    {
      encoding: {
        q: { allowReserved: true },
        tags: { explode: false, style: "pipeDelimited" },
      },
    },
  );

  test("each property's rule keeps the fields it sets, on every line, with no diagnostics", () => {
    for (const line of lines) {
      const outcome = implemented(line, body);
      const found = only(outcome.body.alternatives);

      expect(found.codec).toBe("form");
      expect(found.schema).toBeDefined();
      expect(outcome.diagnostics).toEqual([]);
      expect(targets(found)).toEqual(["q", "tags"]);
      expect(ruleOf(found, "q").serialization).toEqual({ allowReserved: true });
      expect(ruleOf(found, "tags").serialization).toEqual({
        explode: false,
        style: "pipeDelimited",
      });
      expect(typeOf(ruleOf(found, "tags"))).toEqual([]);
      expect(missing(rowsOf(ruleOf(found, "tags")), ["ENC-12", "ENC-13"])).toEqual([]);
      expect(String(ruleOf(found, "q").origin.pointer)).toBe(`${media}/encoding/q`);
    }
  });

  test("the alternative names the line's form row and the property order row", () => {
    expect(missing(alternative("3.1", body).rows.map(String), ["ENC-27", "ENC-29"])).toEqual([]);
    expect(missing(alternative("3.2", body).rows.map(String), ["ENC-28", "ENC-29"])).toEqual([]);
  });

  test("a contentType beside a style field is ignored with an ENC-13 notice", () => {
    const outcome = implemented(
      "3.1",
      form({ q: string }, { encoding: { q: { contentType: "image/png", style: "form" } } }),
    );

    expect(findings(outcome.diagnostics)).toEqual([
      [`${media}/encoding/q`, "ENC-13/content-type-ignored", "element", "notice"],
    ]);
    expect(typeOf(ruleOf(only(outcome.body.alternatives), "q"))).toEqual([]);
  });
});

describe("ENC-17 to ENC-26 the default contentType table when no style field is set", () => {
  test("an object is JSON, a contentEncoding string is octet-stream and null is text", () => {
    for (const line of ["3.1", "3.2"] as const) {
      const found = alternative(
        line,
        form({
          file: { contentEncoding: "base64", type: "string" },
          meta: { type: "object" },
          nothing: { type: "null" },
        }),
      );

      expect(typeOf(ruleOf(found, "meta"))).toEqual(["application/json"]);
      expect(typeOf(ruleOf(found, "file"))).toEqual(["application/octet-stream"]);
      expect(typeOf(ruleOf(found, "nothing"))).toEqual(["text/plain"]);
      expect(rowsOf(ruleOf(found, "file"))).toContain("ENC-19");
      expect(ruleOf(found, "meta").serialization).toBeUndefined();
    }
  });

  test("3.0.4 types a format byte string as octet-stream", () => {
    const found = alternative("3.0", form({ file: { format: "byte", type: "string" } }));

    expect(typeOf(ruleOf(found, "file"))).toEqual(["application/octet-stream"]);
    expect(rowsOf(ruleOf(found, "file"))).toContain("ENC-18");
  });

  test("ENC-02 an explicit contentType equal to the table value is kept", () => {
    const found = alternative(
      "3.1",
      form(
        { meta: { type: "object" } },
        { encoding: { meta: { contentType: "application/json" } } },
      ),
    );

    expect(typeOf(ruleOf(found, "meta"))).toEqual(["application/json"]);
    expect(rowsOf(ruleOf(found, "meta"))).toContain("ENC-02");
  });

  test("ENC-02 any other explicit contentType is refused at element scope, never dropped", () => {
    for (const line of lines) {
      const outcome = normalize(
        line,
        form({ meta: { type: "object" } }, { encoding: { meta: { contentType: "text/plain" } } }),
      );

      expect(outcome._tag).toBe("Refused");
      expect(findings(outcome.diagnostics)).toEqual([
        [`${media}/encoding/meta/contentType`, "ENC-02/form-content-type", "element", "refusal"],
      ]);
    }
  });
});

describe("ENC-14 3.0.4 back-compatibility", () => {
  test("3.0 applies style fields to form-urlencoded and tags each rule ENC-14", () => {
    const found = alternative(
      "3.0",
      form({ q: string, tags }, { encoding: { tags: { style: "spaceDelimited" } } }),
    );

    expect(ruleOf(found, "tags").serialization).toEqual({ style: "spaceDelimited" });
    expect(missing(rowsOf(ruleOf(found, "tags")), ["ENC-12", "ENC-14"])).toEqual([]);
    expect(ruleOf(found, "q").serialization).toBeUndefined();
    expect(typeOf(ruleOf(found, "q"))).toEqual(["text/plain"]);
    expect(rowsOf(ruleOf(found, "q"))).toContain("ENC-14");
  });

  test("3.1 and 3.2 rules carry no ENC-14", () => {
    for (const line of ["3.1", "3.2"] as const) {
      const found = alternative(line, form({ q: string }, { encoding: { q: { style: "form" } } }));

      expect(rowsOf(ruleOf(found, "q"))).not.toContain("ENC-14");
    }
  });
});

describe("MED-11 MED-12 an encoding key that names no schema property", () => {
  const body = form({ q: string }, { encoding: { ghost: { style: "form" } } });

  test("3.0 and 3.1 refuse the alternative with MED-11", () => {
    for (const line of ["3.0", "3.1"] as const) {
      const outcome = normalize(line, body);

      expect(outcome._tag).toBe("Refused");
      expect(findings(outcome.diagnostics)).toEqual([
        [`${media}/encoding/ghost`, "MED-11/unknown-property", "element", "refusal"],
      ]);
    }
  });

  test("3.2 ignores the key with a MED-12 notice and sends no part for it", () => {
    const outcome = implemented("3.2", body);
    const found = only(outcome.body.alternatives);

    expect(findings(outcome.diagnostics)).toEqual([
      [`${media}/encoding/ghost`, "MED-12/absent-property-ignored", "element", "notice"],
    ]);
    expect(targets(found)).toEqual(["q"]);
  });
});

describe("multipart-only Encoding fields under a form alternative yield notices", () => {
  test("ENC-11 headers are ignored and the rule keeps none", () => {
    for (const line of lines) {
      const outcome = implemented(
        line,
        form({ q: string }, { encoding: { q: { headers: { "X-Part": { schema: string } } } } }),
      );

      expect(findings(outcome.diagnostics)).toEqual([
        [`${media}/encoding/q/headers`, "ENC-11/headers-ignored", "element", "notice"],
      ]);
      expect(ruleOf(only(outcome.body.alternatives), "q").headers).toEqual([]);
    }
  });

  test("3.2 nested encoding, prefixEncoding and itemEncoding are ignored per field", () => {
    const outcome = implemented(
      "3.2",
      form(
        { q: { type: "object" } },
        {
          encoding: {
            q: {
              encoding: { a: { contentType: "text/plain" } },
              itemEncoding: { contentType: "text/plain" },
              prefixEncoding: [{ contentType: "text/plain" }],
            },
          },
        },
      ),
    );

    expect(findings(outcome.diagnostics)).toEqual([
      [`${media}/encoding/q/encoding`, "ENC-07/nested-encoding-ignored", "element", "notice"],
      [`${media}/encoding/q/itemEncoding`, "ENC-09/item-encoding-ignored", "element", "notice"],
      [`${media}/encoding/q/prefixEncoding`, "ENC-08/prefix-encoding-ignored", "element", "notice"],
    ]);
    expect(ruleOf(only(outcome.body.alternatives), "q").nested).toBeUndefined();
  });

  test("3.2 media-level prefixEncoding and itemEncoding are ignored, encoding beside them is not MED-13", () => {
    const outcome = implemented(
      "3.2",
      form(
        { q: string },
        {
          encoding: { q: { style: "form" } },
          itemEncoding: { contentType: "text/plain" },
          prefixEncoding: [{ contentType: "text/plain" }],
        },
      ),
    );
    const found = only(outcome.body.alternatives);

    expect(findings(outcome.diagnostics)).toEqual([
      [`${media}/itemEncoding`, "MED-08/item-encoding-ignored", "element", "notice"],
      [`${media}/prefixEncoding`, "MED-07/prefix-encoding-ignored", "element", "notice"],
    ]);
    expect(found.prefixEncoding).toEqual([]);
    expect(found.itemEncoding).toBeUndefined();
  });
});
