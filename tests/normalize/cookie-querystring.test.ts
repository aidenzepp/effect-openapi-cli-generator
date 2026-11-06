import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { DocumentUri } from "../../src/model/brands.ts";
import { normalizeParameter } from "../../src/normalize/parameters.ts";
import type { ParameterOutcome } from "../../src/normalize/parameters.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";
import type { Line } from "../../src/validate/index.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const openapi: Record<Line, string> = { "3.0": "3.0.3", "3.1": "3.1.1", "3.2": "3.2.0" };

const specVersion: Record<Line, string> = { "3.0": "3.0.4", "3.1": "3.1.2", "3.2": "3.2.1" };

const site = "/paths/~1a/get/parameters/0";

interface Members {
  readonly [key: string]: Json;
}

const normalize = (line: Line, parameter: Json, components: Members = {}): ParameterOutcome => {
  const value: Json = {
    components,
    info: { title: "t", version: "1" },
    openapi: openapi[line],
    paths: {
      "/a": { get: { parameters: [parameter], responses: { "200": { description: "ok" } } } },
    },
  };
  const resolution = Effect.runSync(resolve({ document: entry, line, value }));

  return Effect.runSync(normalizeParameter(resolution, { openapi: openapi[line], pointer: site }));
};

const implemented = (line: Line, parameter: Json, components: Members = {}) => {
  const outcome = normalize(line, parameter, components);
  if (outcome._tag !== "Implemented") {
    throw new Error(`expected Implemented, got ${outcome._tag}`);
  }

  return outcome.parameter;
};

const refused = (line: Line, parameter: Json, components: Members = {}) => {
  const outcome = normalize(line, parameter, components);
  if (outcome._tag !== "Refused") {
    throw new Error(`expected Refused, got ${outcome._tag}`);
  }

  return outcome;
};

const texts = (values: readonly string[]): string[] => values.map(String);

const string: Json = { type: "string" };

const cookie = (members: Members): Json => ({
  in: "cookie",
  name: "sid",
  schema: string,
  ...members,
});

const styled = (line: Line, parameter: Json, components: Members = {}) => {
  const found = implemented(line, parameter, components);
  const { serialization } = found;
  if (serialization.kind !== "style") {
    throw new Error("expected a style serialization");
  }

  return {
    allowReserved: serialization.allowReserved,
    explode: serialization.explode,
    location: found.location,
    rows: texts(serialization.rows),
    style: serialization.style,
  };
};

const contentOf = (line: Line, parameter: Json) => {
  const found = implemented(line, parameter);
  const { serialization } = found;
  if (serialization.kind !== "content") {
    throw new Error("expected a content serialization");
  }

  return {
    location: found.location,
    mediaType: String(serialization.mediaType),
    required: found.required,
    rows: texts(serialization.rows),
  };
};

const refusalOf = (line: Line, parameter: Json, components: Members = {}) => {
  const outcome = refused(line, parameter, components);
  const [diagnostic] = outcome.diagnostics;

  return {
    code: diagnostic?.code,
    count: outcome.diagnostics.length,
    pointer: String(diagnostic?.pointer),
    row: String(diagnostic?.row),
    scope: diagnostic?.scope,
    severity: diagnostic?.severity,
    specSection: String(diagnostic?.specSection),
  };
};

describe("cookie parameters generate", () => {
  for (const line of ["3.0", "3.1", "3.2"] as const) {
    test(`STY-33: ${line} cookie form defaults to exploded form`, () => {
      expect(styled(line, cookie({}))).toEqual({
        allowReserved: false,
        explode: true,
        location: "cookie",
        rows: ["STY-33"],
        style: "form",
      });
    });
  }

  for (const line of ["3.0", "3.1"] as const) {
    test(`STY-34: ${line} cookie form with explode false`, () => {
      expect(styled(line, cookie({ explode: false }))).toEqual({
        allowReserved: false,
        explode: false,
        location: "cookie",
        rows: ["STY-34"],
        style: "form",
      });
    });
  }

  test("STY-36: 3.2 cookie form honors allowReserved", () => {
    expect(styled("3.2", cookie({ allowReserved: true }))).toEqual({
      allowReserved: true,
      explode: true,
      location: "cookie",
      rows: ["STY-36"],
      style: "form",
    });
  });

  test("STY-38: 3.2 cookie style cookie, exploded by default", () => {
    expect(styled("3.2", cookie({ style: "cookie" }))).toEqual({
      allowReserved: false,
      explode: true,
      location: "cookie",
      rows: ["STY-38"],
      style: "cookie",
    });
  });

  test("STY-38: 3.2 style cookie carries an array, which only form refuses", () => {
    expect(
      styled("3.2", cookie({ schema: { items: string, type: "array" }, style: "cookie" })).rows,
    ).toEqual(["STY-38"]);
  });

  test("PRM-24: a content-based cookie passes through its media type", () => {
    expect(
      contentOf("3.1", { content: { "text/plain": { schema: string } }, in: "cookie", name: "c" }),
    ).toEqual({
      location: "cookie",
      mediaType: "text/plain",
      required: false,
      rows: ["PRM-15", "PRM-24"],
    });
  });
});

describe("cookie parameters refused", () => {
  const multiple: readonly (readonly [string, Line, Json, Members])[] = [
    ["an array", "3.0", { items: string, type: "array" }, {}],
    ["an object", "3.1", { type: "object" }, {}],
    ["a 3.1 type list with array", "3.1", { type: ["array", "null"] }, {}],
    [
      "an array through $ref",
      "3.2",
      { $ref: "#/components/schemas/Ids" },
      {
        schemas: { Ids: { items: string, type: "array" } },
      },
    ],
  ];

  for (const [label, line, schema, components] of multiple) {
    test(`PRM-34: ${line} cookie form over ${label} is refused`, () => {
      expect(refusalOf(line, cookie({ schema }), components)).toEqual({
        code: "PRM-34/cookie-form-multiple",
        count: 1,
        pointer: site,
        row: "PRM-34",
        scope: "element",
        severity: "refusal",
        specSection: `https://spec.openapis.org/oas/v${specVersion[line]}.html#appendix-d-serializing-headers-and-cookies`,
      });
    });
  }

  for (const line of ["3.0", "3.1"] as const) {
    test(`PRM-34: ${line} cookie form with explode false over an array is refused too`, () => {
      const schema = { items: string, type: "array" };
      expect(refusalOf(line, cookie({ explode: false, schema })).code).toBe(
        "PRM-34/cookie-form-multiple",
      );
    });
  }

  test("STY-35: a 3.2 explode false form cookie over an object reports the STY row alone", () => {
    const outcome = refusalOf("3.2", cookie({ explode: false, schema: { type: "object" } }));
    expect([outcome.code, outcome.count]).toEqual(["STY-35/cookie-explode-false", 1]);
  });

  for (const name of ["a b", "a;b", "a=b", "sé"]) {
    test(`PRM-02: cookie name ${JSON.stringify(name)} is not an RFC 6265 token`, () => {
      expect(refusalOf("3.1", cookie({ name }))).toEqual({
        code: "PRM-02/invalid-cookie-name",
        count: 1,
        pointer: site,
        row: "PRM-02",
        scope: "element",
        severity: "refusal",
        specSection: "https://spec.openapis.org/oas/v3.1.2.html#parameter-name",
      });
    });
  }

  test("PRM-02: a content-based cookie name is checked too", () => {
    expect(
      refusalOf("3.2", { content: { "text/plain": { schema: string } }, in: "cookie", name: "a,b" })
        .code,
    ).toBe("PRM-02/invalid-cookie-name");
  });

  test("STY-35: 3.2 explode false stays refused for good", () => {
    expect(refusalOf("3.2", cookie({ explode: false })).code).toBe("STY-35/cookie-explode-false");
  });
});

const querystring = (media: string, members: Members = {}): Json => ({
  content: { [media]: { schema: { type: "object" } } },
  in: "querystring",
  name: "qs",
  required: true,
  ...members,
});

describe("querystring parameters generate", () => {
  test("STY-42: a JSON querystring is one content value", () => {
    expect(contentOf("3.2", querystring("application/json"))).toEqual({
      location: "querystring",
      mediaType: "application/json",
      required: true,
      rows: ["PRM-15", "STY-42", "STY-43"],
    });
  });

  test("STY-43: a form-urlencoded querystring is one content value", () => {
    for (const media of [
      "application/x-www-form-urlencoded",
      "Application/X-WWW-Form-Urlencoded; charset=utf-8",
    ]) {
      expect(contentOf("3.2", querystring(media))).toEqual({
        location: "querystring",
        mediaType: media,
        required: true,
        rows: ["PRM-15", "STY-42", "STY-43"],
      });
    }
  });
});

describe("querystring parameters refused", () => {
  const forbidden: readonly (readonly [string, Json])[] = [
    ["schema", { in: "querystring", name: "qs", schema: { type: "object" } }],
    ["schema beside content", querystring("application/json", { schema: { type: "object" } })],
    ["style", querystring("application/json", { style: "form" })],
    ["explode", querystring("application/json", { explode: true })],
    ["allowReserved", querystring("application/json", { allowReserved: false })],
  ];

  for (const [label, parameter] of forbidden) {
    test(`STY-45: a querystring with ${label} is refused`, () => {
      expect(refusalOf("3.2", parameter)).toEqual({
        code: "STY-45/querystring-schema-fields",
        count: 1,
        pointer: site,
        row: "STY-45",
        scope: "element",
        severity: "refusal",
        specSection: "https://spec.openapis.org/oas/v3.2.1.html#fixed-fields-for-use-with-schema",
      });
    });
  }
});
