import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { DocumentUri } from "../../src/model/brands.ts";
import { normalizeParameter } from "../../src/normalize/parameters.ts";
import type { ParameterOutcome } from "../../src/normalize/parameters.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Json } from "../../src/resolve/pointer.ts";
import type { Line } from "../../src/validate/index.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const openapi: Record<Line, string> = { "3.0": "3.0.3", "3.1": "3.1.1", "3.2": "3.2.0" };

const specVersion: Record<Line, string> = { "3.0": "3.0.4", "3.1": "3.1.2", "3.2": "3.2.1" };

const lines: readonly Line[] = ["3.0", "3.1", "3.2"];

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

  return outcome;
};

const refused = (line: Line, parameter: Json) => {
  const outcome = normalize(line, parameter);
  if (outcome._tag !== "Refused") {
    throw new Error(`expected Refused, got ${outcome._tag}`);
  }

  return outcome;
};

const plain = (value: string | undefined): string | undefined => value;

const texts = (values: readonly string[]): string[] => values.map(String);

const codes = (outcome: ParameterOutcome): readonly string[] =>
  outcome.diagnostics.map((diagnostic) => diagnostic.code);

const styled = (line: Line, parameter: Json) => {
  const { serialization } = implemented(line, parameter).parameter;
  if (serialization.kind !== "style") {
    throw new Error("expected a style serialization");
  }

  return {
    allowReserved: serialization.allowReserved,
    explode: serialization.explode,
    rows: texts(serialization.rows),
    style: serialization.style,
  };
};

const string: Json = { type: "string" };

const query = (members: Members): Json => ({ in: "query", name: "q", schema: string, ...members });

const path = (members: Members): Json => ({
  in: "path",
  name: "q",
  required: true,
  schema: string,
  ...members,
});

const header = (members: Members): Json => ({
  in: "header",
  name: "X-Q",
  schema: string,
  ...members,
});

const cookie = (members: Members): Json => ({
  in: "cookie",
  name: "q",
  schema: string,
  ...members,
});

const content = (media: string, location: string): Json => ({
  content: { [media]: { schema: { $ref: "#/components/schemas/Point" } } },
  in: location,
  name: "where",
});

const querystring = (media: string): Json => ({
  content: { [media]: { schema: { type: "object" } } },
  in: "querystring",
  name: "qs",
  required: true,
});

const reasonOf = (line: Line, parameter: Json): string => {
  const value: Json = {
    info: { title: "t", version: "1" },
    openapi: openapi[line],
    paths: {
      "/a": { get: { parameters: [parameter], responses: { "200": { description: "ok" } } } },
    },
  };
  const resolution = Effect.runSync(resolve({ document: entry, line, value }));
  const failure = Effect.runSync(
    Effect.flip(normalizeParameter(resolution, { openapi: openapi[line], pointer: site })),
  );

  return `${failure._tag}:${failure.reason}`;
};

describe("PRM-11 PRM-12 PRM-13 defaults come from the text of each location", () => {
  test("STY-13 a query parameter is form, exploded, not allowReserved, whatever the schema default says", () => {
    for (const line of lines) {
      expect(styled(line, query({ schema: { default: "pipeDelimited", type: "string" } }))).toEqual(
        {
          allowReserved: false,
          explode: true,
          rows: ["STY-13"],
          style: "form",
        },
      );
    }
  });

  test("STY-05 a path parameter is simple and not exploded", () => {
    expect(styled("3.1", path({}))).toEqual({
      allowReserved: false,
      explode: false,
      rows: ["STY-05"],
      style: "simple",
    });
  });

  test("STY-31 a header parameter is simple and not exploded", () => {
    expect(styled("3.1", header({}))).toEqual({
      allowReserved: false,
      explode: false,
      rows: ["STY-31"],
      style: "simple",
    });
  });

  const rowsOf: readonly (readonly [string, Json, string])[] = [
    ["STY-14", query({ explode: false }), "form"],
    ["STY-15", query({ allowReserved: true }), "form"],
    ["STY-16", query({ allowReserved: true, explode: false }), "form"],
    ["STY-17", query({ style: "spaceDelimited" }), "spaceDelimited"],
    ["STY-19", query({ allowReserved: true, style: "spaceDelimited" }), "spaceDelimited"],
    ["STY-21", query({ style: "pipeDelimited" }), "pipeDelimited"],
    ["STY-23", query({ allowReserved: true, style: "pipeDelimited" }), "pipeDelimited"],
    ["STY-01", path({ style: "matrix" }), "matrix"],
    ["STY-02", path({ explode: true, style: "matrix" }), "matrix"],
    ["STY-03", path({ style: "label" }), "label"],
    ["STY-04", path({ explode: true, style: "label" }), "label"],
    ["STY-06", path({ explode: true }), "simple"],
    ["STY-32", header({ explode: true }), "simple"],
  ];

  for (const [row, parameter, style] of rowsOf) {
    test(`${row} is the row of its location, style, explode and allowReserved`, () => {
      expect(styled("3.1", parameter).rows).toEqual([row]);
      expect(plain(styled("3.1", parameter).style)).toBe(style);
    });
  }

  test("STY-11 3.2 honors allowReserved on a path parameter", () => {
    expect(styled("3.2", path({ allowReserved: true }))).toEqual({
      allowReserved: true,
      explode: false,
      rows: ["STY-11"],
      style: "simple",
    });
  });

  test("STY-12 3.2 path allowReserved with explode", () => {
    expect(styled("3.2", path({ allowReserved: true, explode: true })).rows).toEqual(["STY-12"]);
  });

  for (const line of ["3.0", "3.1"] as const) {
    test(`PRM-35 ${line} ignores allowReserved on a path parameter and says so`, () => {
      const outcome = implemented(line, path({ allowReserved: true }));

      expect(styled(line, path({ allowReserved: true })).allowReserved).toBe(false);
      expect(codes(outcome)).toEqual(["PRM-35/allow-reserved-ignored"]);
      expect(outcome.diagnostics[0]?.severity).toBe("notice");
    });
  }

  test("PRM-35 a header parameter ignores allowReserved in every line", () => {
    for (const line of lines) {
      expect(codes(implemented(line, header({ allowReserved: true })))).toContain(
        "PRM-35/allow-reserved-ignored",
      );
    }
  });

  test("PRM-35 allowReserved false is not worth a notice", () => {
    expect(codes(implemented("3.1", header({ allowReserved: false })))).toEqual([]);
  });
});

describe("rules tag", () => {
  test("PRM-11 every serialization carries the tag of its line", () => {
    for (const line of lines) {
      expect(implemented(line, query({})).parameter.serialization.rules).toBe(`oas-${line}`);
    }
  });
});

describe("STY-26 deepObject explode is a later-line correction", () => {
  test("STY-25 an exploded deepObject needs no notice", () => {
    const outcome = implemented("3.1", query({ explode: true, style: "deepObject" }));

    expect(codes(outcome)).toEqual([]);
    expect(styled("3.1", query({ explode: true, style: "deepObject" })).rows).toEqual(["STY-25"]);
  });

  for (const line of ["3.0", "3.1"] as const) {
    test(`STY-26 ${line} deepObject without explode is exploded, with a notice`, () => {
      const parameter = query({ style: "deepObject" });
      const outcome = implemented(line, parameter);

      expect(styled(line, parameter)).toEqual({
        allowReserved: false,
        explode: true,
        rows: ["STY-26"],
        style: "deepObject",
      });
      expect(codes(outcome)).toEqual(["STY-26/explode-no-effect"]);
      expect(outcome.diagnostics[0]?.severity).toBe("notice");
      expect(plain(outcome.diagnostics[0]?.specSection)).toBe(
        `https://spec.openapis.org/oas/v${specVersion[line]}.html#parameter-explode`,
      );
    });
  }

  test("STY-26 explode false is corrected the same way", () => {
    expect(codes(implemented("3.1", query({ explode: false, style: "deepObject" })))).toEqual([
      "STY-26/explode-no-effect",
    ]);
  });

  test("STY-29 the allowReserved variant has its own row", () => {
    const parameter = query({ allowReserved: true, style: "deepObject" });

    expect(codes(implemented("3.0", parameter))).toEqual(["STY-29/explode-no-effect"]);
    expect(styled("3.0", parameter).rows).toEqual(["STY-29"]);
    expect(
      styled("3.0", query({ allowReserved: true, explode: true, style: "deepObject" })).rows,
    ).toEqual(["STY-28"]);
  });

  test("STY-27 3.2 says explode has no effect, so there is nothing to correct", () => {
    for (const explode of [true, false]) {
      const parameter = query({ explode, style: "deepObject" });

      expect(codes(implemented("3.2", parameter))).toEqual([]);
      expect(styled("3.2", parameter)).toEqual({
        allowReserved: false,
        explode: true,
        rows: ["STY-27"],
        style: "deepObject",
      });
    }

    expect(styled("3.2", query({ allowReserved: true, style: "deepObject" })).rows).toEqual([
      "STY-30",
    ]);
  });
});

describe("PRM-32 header percent-encoding is a later-line correction", () => {
  test("PRM-32 a 3.0 schema-based header gets one notice", () => {
    const outcome = implemented("3.0", header({}));

    expect(codes(outcome)).toEqual(["PRM-32/header-percent-encoding"]);
    expect(outcome.diagnostics[0]?.severity).toBe("notice");
    expect(outcome.diagnostics[0]?.scope).toBe("element");
  });

  test("PRM-33 3.1 and 3.2 headers already agree with the correction", () => {
    expect(codes(implemented("3.1", header({})))).toEqual([]);
    expect(codes(implemented("3.2", header({})))).toEqual([]);
  });

  test("PRM-24 a 3.0 content-based header was never percent-encoded", () => {
    const parameter: Json = {
      content: { "text/plain": { schema: string } },
      in: "header",
      name: "X-Q",
    };

    expect(codes(implemented("3.0", parameter))).toEqual([]);
  });
});

describe("PRM-15 content-based parameters", () => {
  const components: Members = { schemas: { Point: { type: "object" } } };

  test("PRM-23 a query parameter serializes by its media type", () => {
    const { parameter } = implemented("3.1", content("application/json", "query"), components);

    expect(parameter.serialization.kind).toBe("content");
    expect(texts(parameter.serialization.rows)).toEqual(["PRM-15", "PRM-23"]);
    expect(parameter.schema.key).toBe("Point");
    if (parameter.serialization.kind === "content") {
      expect(plain(parameter.serialization.mediaType)).toBe("application/json");
      expect(parameter.serialization.schema.key).toBe("Point");
    }
  });

  test("PRM-24 header content passes through", () => {
    const { parameter } = implemented("3.1", content("text/plain", "header"), components);

    expect(texts(parameter.serialization.rows)).toEqual(["PRM-15", "PRM-24"]);
  });

  test("PRM-15 an inline media schema is keyed by its own pointer", () => {
    const { parameter } = implemented("3.1", {
      content: { "application/json": { schema: { type: "object" } } },
      in: "query",
      name: "where",
    });

    expect(parameter.schema.key).toBe(`${site}/content/application~1json/schema`);
  });

  test("PRM-15 a media type without a schema is refused at element scope", () => {
    const outcome = refused("3.1", {
      content: { "application/json": {} },
      in: "query",
      name: "where",
    });

    expect(codes(outcome)).toEqual(["PRM-15/missing-schema"]);
    expect(outcome.diagnostics[0]?.scope).toBe("element");
    expect(outcome.required).toBe(false);
  });

  test("PRM-15 a wildcard media type is refused at element scope", () => {
    const outcome = refused("3.1", {
      content: { "*/*": { schema: string } },
      in: "query",
      name: "where",
      required: true,
    });

    expect(codes(outcome)).toEqual(["PRM-15/invalid-media-type"]);
    expect(outcome.required).toBe(true);
  });

  test("PRM-15 a content-based parameter has no style", () => {
    const { parameter } = implemented("3.1", {
      content: { "application/json": { schema: string } },
      in: "query",
      name: "where",
    });

    expect(parameter.serialization.kind).toBe("content");
  });
});

describe("PRM-19 PRM-21 reserved header names", () => {
  for (const name of ["Accept", "content-type", "AUTHORIZATION"]) {
    test(`PRM-19 header ${name} is ignored with a notice and has no entity`, () => {
      for (const line of lines) {
        const outcome = normalize(line, header({ name }));

        expect(outcome._tag).toBe("Ignored");
        expect(codes(outcome)).toEqual(["PRM-19/ignored-header"]);
        expect(outcome.diagnostics[0]?.severity).toBe("notice");
        expect(outcome.diagnostics[0]?.row).toBe("PRM-19");
        expect(plain(outcome.diagnostics[0]?.pointer)).toBe(site);
      }
    });
  }

  test("PRM-19 the same names are ordinary query parameters", () => {
    expect(normalize("3.1", query({ name: "Accept" }))._tag).toBe("Implemented");
  });

  for (const name of ["Cookie", "cookie", "COOKIE"]) {
    test(`PRM-21 header ${name} is refused at element scope`, () => {
      const outcome = refused("3.1", header({ name, required: true }));

      expect(codes(outcome)).toEqual(["PRM-21/cookie-header"]);
      expect(outcome.diagnostics[0]?.scope).toBe("element");
      expect(outcome.diagnostics[0]?.severity).toBe("refusal");
      expect(outcome.diagnostics[0]?.hint).toContain("in: cookie");
      expect(outcome.required).toBe(true);
    });
  }
});

describe("PRM-08 allowEmptyValue", () => {
  test("PRM-08 a query parameter honors it and records the row", () => {
    const { parameter, diagnostics } = implemented("3.1", query({ allowEmptyValue: true }));

    expect(diagnostics).toEqual([]);
    expect(texts(parameter.rows)).toContain("PRM-08");
    expect(texts(parameter.serialization.rows)).toContain("PRM-08");
  });

  test("PRM-08 without it, or false, the row is not recorded", () => {
    expect(texts(implemented("3.1", query({})).parameter.rows)).not.toContain("PRM-08");
    expect(
      texts(implemented("3.1", query({ allowEmptyValue: false })).parameter.rows),
    ).not.toContain("PRM-08");
  });

  const elsewhere: readonly (readonly [string, Json])[] = [
    ["path", path({ allowEmptyValue: true })],
    ["header", header({ allowEmptyValue: true })],
  ];

  for (const [where, parameter] of elsewhere) {
    test(`PRM-08 on a ${where} parameter it is ignored with a notice`, () => {
      const outcome = implemented("3.1", parameter);

      expect(codes(outcome)).toEqual(["PRM-08/allow-empty-value-ignored"]);
      expect(texts(outcome.parameter.rows)).not.toContain("PRM-08");
    });
  }

  test("PRM-08 a content-based query parameter ignores it with a notice", () => {
    const outcome = implemented("3.1", {
      allowEmptyValue: true,
      content: { "application/json": { schema: string } },
      in: "query",
      name: "q",
    });

    expect(codes(outcome)).toEqual(["PRM-08/allow-empty-value-ignored"]);
  });
});

describe("the entity", () => {
  test("PRM-01 carries name, location, required, deprecated, docs and origin", () => {
    const { parameter } = implemented(
      "3.1",
      query({ deprecated: true, description: "Find things", name: "weird name", required: true }),
    );

    expect(plain(parameter.wireName)).toBe("weird name");
    expect(parameter.location).toBe("query");
    expect(parameter.required).toBe(true);
    expect(parameter.deprecated).toBe(true);
    expect(plain(parameter.docs.description)).toBe("Find things");
    expect({
      document: plain(parameter.origin.document),
      pointer: plain(parameter.origin.pointer),
    }).toEqual({ document: entry, pointer: site });
    expect(texts(parameter.rows)).toContain("PRM-01");
  });

  test("PRM-05 required and deprecated default to false", () => {
    const { parameter } = implemented("3.1", query({}));

    expect(parameter.required).toBe(false);
    expect(parameter.deprecated).toBe(false);
    expect(parameter.docs).toEqual({});
  });

  test("PRM-14 a schema reference is keyed by its component name, an inline schema by its pointer", () => {
    const components: Members = { schemas: { Pet: { type: "string" } } };

    expect(
      implemented("3.1", query({ schema: { $ref: "#/components/schemas/Pet" } }), components)
        .parameter.schema.key,
    ).toBe("Pet");
    expect(implemented("3.1", query({})).parameter.schema.key).toBe(`${site}/schema`);
  });

  test("PRM-01 a referenced parameter keeps the use site as origin and the summary of the reference", () => {
    const outcome = implemented(
      "3.1",
      { $ref: "#/components/parameters/Q", description: "At use" },
      {
        parameters: { Q: query({ description: "At home" }) },
      },
    );

    expect(plain(outcome.parameter.origin.pointer)).toBe(site);
    expect(plain(outcome.parameter.docs.description)).toBe("At use");
  });

  test("PRM-04 help text loses characters the help-safe brand rejects", () => {
    const { parameter } = implemented("3.1", query({ description: "a\u0000b‮c\nd" }));

    expect(plain(parameter.docs.description)).toBe("abc\nd");
  });

  test("PRM-02 a name with control characters is refused at element scope", () => {
    const outcome = refused("3.1", query({ name: "a\u0001b", required: true }));

    expect(codes(outcome)).toEqual(["PRM-02/invalid-name"]);
    expect(outcome.required).toBe(true);
  });

  test("PRM-16 the diagnostic names the document, the operation and the line's spec section", () => {
    const outcome = normalize("3.2", header({ name: "Accept" }));
    const [diagnostic] = outcome.diagnostics;

    expect(diagnostic?.document).toBe(entry);
    expect(diagnostic?.openapi).toBe("3.2.0");
    expect(plain(diagnostic?.specSection)).toBe(
      "https://spec.openapis.org/oas/v3.2.1.html#parameter-name",
    );
  });
});

describe("diagnostic wire name", () => {
  test("a refused cookie parameter carries its own name as wire", () => {
    expect(refused("3.1", cookie({ name: "session" })).diagnostics.map((d) => d.wire)).toEqual([
      "session",
    ]);
  });

  test("the Cookie header refusal carries the name as written", () => {
    expect(refused("3.1", header({ name: "Cookie" })).diagnostics[0]?.wire).toBe("Cookie");
  });

  test("an ignored Accept header carries its name", () => {
    const outcome = normalize("3.1", header({ name: "Accept" }));
    expect(outcome.diagnostics[0]?.wire).toBe("Accept");
  });

  test("an invalid name is sanitized in wire", () => {
    const outcome = refused("3.1", query({ name: "a\u0001b" }));
    expect(codes(outcome)).toEqual(["PRM-02/invalid-name"]);
    expect(outcome.diagnostics[0]?.wire).toBe("ab");
  });
});

describe("STY-33 in: cookie is refused until Milestone 2", () => {
  const staged: readonly (readonly [string, Line, Json])[] = [
    ["STY-33", "3.0", cookie({})],
    ["STY-33", "3.1", cookie({ explode: true })],
    ["STY-33", "3.2", cookie({})],
    ["STY-34", "3.0", cookie({ explode: false })],
    ["STY-34", "3.1", cookie({ explode: false })],
    ["STY-36", "3.2", cookie({ allowReserved: true })],
    ["STY-38", "3.2", cookie({ style: "cookie" })],
    ["STY-38", "3.2", cookie({ allowReserved: true, style: "cookie" })],
  ];

  for (const [row, line, parameter] of staged) {
    test(`${row} ${line} is not-implemented at element scope with a Milestone 2 hint`, () => {
      const outcome = refused(line, parameter);
      const [diagnostic] = outcome.diagnostics;

      expect(codes(outcome)).toEqual([`${row}/not-implemented`]);
      expect(diagnostic?.row).toBe(row);
      expect(diagnostic?.scope).toBe("element");
      expect(diagnostic?.severity).toBe("refusal");
      expect(diagnostic?.hint).toContain("Milestone 2");
      expect(diagnostic?.specSection).toMatch(
        new RegExp(`^https://spec.openapis.org/oas/v${specVersion[line]}.html#.+`, "u"),
      );
    });
  }

  test("STY-33 3.0 and 3.1 ignore allowReserved on a cookie, so the row stays STY-33", () => {
    expect(codes(refused("3.1", cookie({ allowReserved: true })))).toEqual([
      "STY-33/not-implemented",
    ]);
  });

  test("PRM-24 a content-based cookie is not implemented either", () => {
    const outcome = refused("3.1", {
      content: { "text/plain": { schema: string } },
      in: "cookie",
      name: "c",
    });

    expect(codes(outcome)).toEqual(["PRM-24/not-implemented"]);
    expect(outcome.diagnostics[0]?.hint).toContain("Milestone 2");
  });

  test("STY-33 a required cookie parameter reports it for the operation-scope raise", () => {
    expect(refused("3.1", cookie({ required: true })).required).toBe(true);
    expect(refused("3.1", cookie({})).required).toBe(false);
  });
});

describe("STY-35 cookie explode false is refused for good in 3.2", () => {
  const permanent: readonly (readonly [string, Json])[] = [
    ["STY-35", cookie({ explode: false })],
    ["STY-35", cookie({ explode: false, style: "form" })],
    ["STY-37", cookie({ allowReserved: true, explode: false })],
    ["STY-39", cookie({ explode: false, style: "cookie" })],
  ];

  for (const [row, parameter] of permanent) {
    test(`${row} is cookie-explode-false with a permanent hint and no milestone`, () => {
      const outcome = refused("3.2", parameter);
      const [diagnostic] = outcome.diagnostics;

      expect(codes(outcome)).toEqual([`${row}/cookie-explode-false`]);
      expect(diagnostic?.scope).toBe("element");
      expect(diagnostic?.severity).toBe("refusal");
      expect(diagnostic?.hint).toMatch(/^refused \(permanent\): /u);
      expect(diagnostic?.hint).not.toContain("Milestone");
      expect(diagnostic?.specSection).toMatch(
        /^https:\/\/spec\.openapis\.org\/oas\/v3\.2\.1\.html#.+/u,
      );
    });
  }
});

describe("STY-42 in: querystring is refused until Milestone 2", () => {
  test("STY-42 a JSON querystring is not-implemented at element scope", () => {
    const outcome = refused("3.2", querystring("application/json"));
    const [diagnostic] = outcome.diagnostics;

    expect(codes(outcome)).toEqual(["STY-42/not-implemented"]);
    expect(diagnostic?.scope).toBe("element");
    expect(diagnostic?.hint).toContain("Milestone 2");
    expect(diagnostic?.specSection).toMatch(
      /^https:\/\/spec\.openapis\.org\/oas\/v3\.2\.1\.html#.+/u,
    );
    expect(outcome.required).toBe(true);
  });

  test("STY-43 a form-urlencoded querystring is not-implemented under its own row", () => {
    for (const media of [
      "application/x-www-form-urlencoded",
      "Application/X-WWW-Form-Urlencoded; charset=utf-8",
    ]) {
      const outcome = refused("3.2", querystring(media));

      expect(codes(outcome)).toEqual(["STY-43/not-implemented"]);
      expect(outcome.diagnostics[0]?.hint).toContain("Milestone 2");
    }
  });
});

describe("STY-40 STY-18 combinations outside the style table", () => {
  test("STY-40 a style the location does not define is refused at element scope", () => {
    const outcome = refused("3.1", query({ style: "matrix" }));

    expect(codes(outcome)).toEqual(["STY-40/style-location"]);
    expect(outcome.diagnostics[0]?.scope).toBe("element");
    expect(refused("3.1", path({ style: "form" })).diagnostics[0]?.row).toBe("STY-40");
    expect(refused("3.1", header({ style: "label" })).diagnostics[0]?.row).toBe("STY-40");
    expect(refused("3.1", cookie({ style: "cookie" })).diagnostics[0]?.code).toBe(
      "STY-40/style-location",
    );
  });

  const exploded: readonly (readonly [string, Json])[] = [
    ["STY-18", query({ explode: true, style: "spaceDelimited" })],
    ["STY-20", query({ allowReserved: true, explode: true, style: "spaceDelimited" })],
    ["STY-22", query({ explode: true, style: "pipeDelimited" })],
    ["STY-24", query({ allowReserved: true, explode: true, style: "pipeDelimited" })],
  ];

  for (const [row, parameter] of exploded) {
    test(`${row} explode true is not defined for the style`, () => {
      const outcome = refused("3.1", parameter);

      expect(codes(outcome)).toEqual([`${row}/explode-not-applicable`]);
      expect(outcome.diagnostics[0]?.scope).toBe("element");
    });
  }
});

describe("ParameterNotReadable is what the earlier stages should have stopped", () => {
  test("PRM-06 a path parameter that is not required", () => {
    expect(reasonOf("3.1", path({ required: false }))).toBe(
      "ParameterNotReadable:path-not-required",
    );
  });

  test("PRM-17 both or neither of schema and content", () => {
    expect(reasonOf("3.1", { in: "query", name: "q" })).toBe(
      "ParameterNotReadable:schema-xor-content",
    );
    expect(
      reasonOf("3.1", {
        content: { "text/plain": { schema: string } },
        in: "query",
        name: "q",
        schema: string,
      }),
    ).toBe("ParameterNotReadable:schema-xor-content");
  });

  test("PRM-18 a content map with other than one entry", () => {
    expect(
      reasonOf("3.1", {
        content: { "application/json": { schema: string }, "text/plain": { schema: string } },
        in: "query",
        name: "q",
      }),
    ).toBe("ParameterNotReadable:content-entry-count");
  });

  test("PRM-03 a location the line does not have", () => {
    expect(
      reasonOf("3.1", {
        content: { "text/plain": { schema: string } },
        in: "querystring",
        name: "q",
      }),
    ).toBe("ParameterNotReadable:line-mismatch");
  });

  test("PRM-01 a site that is not a parameter", () => {
    expect(reasonOf("3.1", "nope")).toBe("ParameterNotReadable:not-a-parameter");
    expect(reasonOf("3.1", { in: "elsewhere", name: "q", schema: string })).toBe(
      "ParameterNotReadable:not-a-parameter",
    );
  });
});
