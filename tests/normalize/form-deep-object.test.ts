import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { coverageOf } from "../../corpus/tools/coverage.ts";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import type { EncodingRule, MediaAlternative } from "../../src/model/entities.ts";
import { normalizeBody } from "../../src/normalize/bodies.ts";
import type { BodyOutcome } from "../../src/normalize/bodies.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";
import { Description } from "../../src/runtime-src/runtime/describe.ts";

// A Stripe-shaped 3.0.3 form body: `deepObject` Encoding entries over a nested `metadata` object
// and an `items` array of objects, both through `$ref` (design 6.1, D-OQ1).

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const configUri = Schema.decodeUnknownSync(DocumentUri)("file:///spec/author.json");

const openapi = "3.0.3";

const formMedia = "application/x-www-form-urlencoded";

const site = "/paths/~1v1~1customers/post/requestBody";

const media = `${site}/content/application~1x-www-form-urlencoded`;

interface Members {
  readonly [key: string]: Json;
}

const string: Json = { type: "string" };

const deep: Json = { explode: true, style: "deepObject" };

const components: Json = {
  schemas: {
    Item: { properties: { price: string, quantity: { type: "integer" } }, type: "object" },
    Metadata: {
      properties: { owner: { properties: { id: string }, type: "object" } },
      type: "object",
    },
  },
};

// Object members only, one of them untyped: not nested.
const address: Json = {
  additionalProperties: string,
  properties: { city: string, note: {} },
  type: "object",
};

const nestedProperties: Members = {
  items: { items: { $ref: "#/components/schemas/Item" }, type: "array" },
  metadata: { $ref: "#/components/schemas/Metadata" },
};

// Every property is required, so a refused entry drops the alternative (design 8.5 rule 3).
const formOf = (properties: Members): Json => ({
  encoding: Object.fromEntries(Object.keys(properties).map((name) => [name, deep])),
  schema: { properties, required: Object.keys(properties), type: "object" },
});

const jsonMedia: Json = { schema: { type: "object" } };

const bodyOf = (properties: Members, required = true, json = false): Json => ({
  content: json
    ? { [formMedia]: formOf(properties), "application/json": jsonMedia }
    : { [formMedia]: formOf(properties) },
  required,
});

const documentOf = (requestBody: Json, version = openapi, requestBodies?: Members): Json => ({
  components: requestBodies === undefined ? components : { ...components, requestBodies },
  info: { title: "t", version: "1" },
  openapi: version,
  paths: {
    "/v1/customers": { post: { requestBody, responses: { "200": { description: "ok" } } } },
  },
});

const resolutionOf = (requestBody: Json) =>
  Effect.runSync(resolve({ document: entry, line: "3.0", value: documentOf(requestBody) }));

const bodyWith = (requestBody: Json, deepObjectBrackets?: boolean): BodyOutcome =>
  Effect.runSync(
    normalizeBody(
      resolutionOf(requestBody),
      deepObjectBrackets === undefined
        ? { openapi, pointer: site }
        : { nonStandard: { deepObjectBrackets }, openapi, pointer: site },
    ),
  );

// The compared fields as plain strings: the expected rows are literals, not branded pointers.
interface Found {
  readonly code: string;
  readonly pointer: string;
  readonly related: readonly string[];
  readonly row: string;
  readonly scope: string;
  readonly severity: string;
}

const findings = (diagnostics: readonly Diagnostic[]): readonly Found[] =>
  diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    pointer: diagnostic.pointer,
    related: (diagnostic.related ?? []).map((related) => related.pointer),
    row: diagnostic.row,
    scope: diagnostic.scope,
    severity: diagnostic.severity,
  }));

const compoundNested = (name: string) => ({
  code: "PRM-27/compound-nested",
  pointer: media,
  related: [`${media}/encoding/${name}`],
  row: "PRM-27",
  scope: "element",
  severity: "refusal",
});

const bracketChoice = (name: string) => ({
  code: "PRM-27/bracket-author-choice",
  pointer: `${media}/encoding/${name}`,
  related: [],
  row: "PRM-27",
  scope: "element",
  severity: "notice",
});

const formAlternative = (outcome: BodyOutcome): MediaAlternative => {
  if (outcome._tag !== "Implemented") {
    throw new Error(`expected Implemented, got ${outcome._tag}`);
  }

  const found = outcome.body.alternatives.find((alternative) => alternative.codec === "form");
  if (found === undefined) {
    throw new Error("no form alternative");
  }

  return found;
};

const markers = (found: MediaAlternative): Record<string, string | undefined> =>
  Object.fromEntries(
    found.encoding.map((rule: EncodingRule) => [
      rule.target.kind === "property" ? rule.target.name : `#${rule.target.index}`,
      rule.nonStandard,
    ]),
  );

describe("PRM-27 strict: a form deepObject over a nested property refuses its alternative", () => {
  for (const name of ["metadata", "items"]) {
    test(`PRM-27: ${name} refuses the form alternative at the media type, the entry related`, () => {
      for (const switched of [undefined, false]) {
        const outcome = bodyWith(bodyOf({ [name]: nestedProperties[name] ?? {} }), switched);

        expect(outcome._tag).toBe("Refused");
        expect(outcome._tag === "Refused" && outcome.required).toBe(true);
        expect(findings(outcome.diagnostics)).toEqual([compoundNested(name)]);
      }
    });
  }

  test("PRM-27: another alternative survives and the body stays", () => {
    const outcome = bodyWith(bodyOf(nestedProperties, true, true));
    if (outcome._tag !== "Implemented") {
      throw new Error(`expected Implemented, got ${outcome._tag}`);
    }

    expect(outcome.body.alternatives.map((found) => found.codec)).toEqual(["json"]);
    expect(findings(outcome.diagnostics)).toEqual([compoundNested("items")]);
  });

  test("PRM-27: the required body's only alternative raises OPR-09 at operation scope", () => {
    const config = Schema.decodeUnknownSync(AuthorConfig)({
      binName: "example",
      package: { name: "example-cli", version: "1.0.0" },
    });
    const { api, diagnostics } = Effect.runSync(
      normalize(resolutionOf(bodyOf(nestedProperties)), {
        checkFindings: [],
        config,
        configDocument: configUri,
      }),
    );

    expect(api.operations).toEqual([]);
    expect(
      findings(diagnostics).filter((found) => found.code !== "PRM-27/compound-nested"),
    ).toEqual([
      {
        code: "OPR-09/required-body-refused",
        pointer: "/paths/~1v1~1customers/post",
        related: [site],
        row: "OPR-09",
        scope: "operation",
        severity: "refusal",
      },
    ]);
    expect(findings(diagnostics).filter((found) => found.row === "PRM-27")).toEqual([
      compoundNested("items"),
    ]);
  });
});

describe("PRM-27 switch: nonStandard.deepObjectBrackets marks the rule", () => {
  test("PRM-27: both nested rules are marked, each with one notice at its Encoding entry", () => {
    const outcome = bodyWith(bodyOf({ ...nestedProperties, address }), true);
    const found = formAlternative(outcome);

    expect(markers(found)).toEqual({
      address: undefined,
      items: "deepObjectBrackets",
      metadata: "deepObjectBrackets",
    });
    expect(findings(outcome._tag === "Implemented" ? outcome.diagnostics : [])).toEqual([
      bracketChoice("items"),
      bracketChoice("metadata"),
    ]);
  });
});

describe("PRM-27 scalar members: a deepObject over a flat object is unchanged", () => {
  test("PRM-27: no marker and no diagnostic, switch absent, false or true", () => {
    for (const switched of [undefined, false, true]) {
      const outcome = bodyWith(bodyOf({ address }), switched);

      expect(markers(formAlternative(outcome))).toEqual({ address: undefined });
      expect(outcome._tag === "Implemented" && outcome.diagnostics).toEqual([]);
    }
  });
});

// Audit NF2 (design 8.4): a refused alternative sends nothing, so its marked entries are not sent
// in the bracket convention and keep no notice, whichever property comes first.
const nonObject = (name: string) => ({
  code: "PRM-27/non-object-schema",
  pointer: media,
  related: [`${media}/encoding/${name}`],
  row: "PRM-27",
  scope: "element",
  severity: "refusal",
});

const metadata: Members = { metadata: nestedProperties.metadata ?? {} };

// The same two properties, the marked entry first and then the refusing one first.
const orders: readonly (readonly [string, Members])[] = [
  ["marked entry first", Object.fromEntries([...Object.entries(metadata), ["tag", string]])],
  ["refusing entry first", Object.fromEntries([["tag", string], ...Object.entries(metadata)])],
];

describe("PRM-27 switch: a refused alternative keeps no bracket notice", () => {
  for (const [order, properties] of orders) {
    test(`PRM-27: ${order}, only the refusal remains`, () => {
      const outcome = bodyWith(bodyOf(properties), true);

      expect(outcome._tag).toBe("Refused");
      expect(findings(outcome.diagnostics)).toEqual([nonObject("tag")]);
    });
  }

  test("PRM-27: both property orders give the same diagnostics", () => {
    const [first, second] = orders.map(([, properties]) => bodyWith(bodyOf(properties), true));

    expect(findings(first?.diagnostics ?? [])).toEqual(findings(second?.diagnostics ?? []));
  });

  test("PRM-27: an alternative that is kept still carries its bracket notice", () => {
    const outcome = bodyWith(bodyOf(metadata), true);

    expect(markers(formAlternative(outcome))).toEqual({ metadata: "deepObjectBrackets" });
    expect(findings(outcome._tag === "Implemented" ? outcome.diagnostics : [])).toEqual([
      bracketChoice("metadata"),
    ]);
  });
});

// Design 8.5 rules 2, 3 and 11: a refused optional form property is refused at `field` scope at its
// Encoding entry and the alternative stays; a refused required one drops the alternative, and a
// dropped alternative keeps no `field` record.

// A deepObject value over `anyOf` of an object and "": PRM-27/non-object-schema.
const objectOrEmpty: Json = {
  anyOf: [
    { properties: { a: string }, type: "object" },
    { enum: [""], type: "string" },
  ],
};

// An optional form body whose `deepObject` entries are `encoded`, its schema `extra` merged in.
const fieldBody = (properties: Members, encoded: readonly string[], extra: Members = {}): Json => ({
  content: {
    [formMedia]: {
      encoding: Object.fromEntries(encoded.map((name) => [name, deep])),
      schema: { properties, type: "object", ...extra },
    },
  },
  required: false,
});

const config = Schema.decodeUnknownSync(AuthorConfig)({
  binName: "example",
  package: { name: "example-cli", version: "1.0.0" },
});

// The coverage join over a normalized document, with `--describe` read off the normalized model:
// each operation's kept request media and their refused fields.
const joined = (resolution: ReturnType<typeof resolutionOf>, settings = config) => {
  const { api, diagnostics } = Effect.runSync(
    normalize(resolution, { checkFindings: [], config: settings, configDocument: configUri }),
  );
  const commands = api.operations.map((operation) => {
    const alternatives = operation.body?.alternatives ?? [];

    return {
      document: "openapi.json",
      flags: [],
      method: operation.key.method,
      path: ["customers", "create"],
      pathTemplate: operation.key.path,
      pointer: operation.origin.pointer,
      refusedFields: alternatives.flatMap((alternative) =>
        (alternative.refusedFields ?? []).map((name) => ({
          mediaType: alternative.mediaType,
          name,
        })),
      ),
      requestMedia: alternatives.map((alternative) => alternative.mediaType),
      responses: ["200"],
      security: [],
      servers: [],
    };
  });
  const report = {
    notices: diagnostics.filter((diagnostic) => diagnostic.severity === "notice"),
    refusals: diagnostics.filter((diagnostic) => diagnostic.severity === "refusal"),
  };

  return Effect.runSync(
    coverageOf({
      describe: JSON.stringify(Schema.encodeSync(Description)({ commands, describeVersion: 1 })),
      report: JSON.stringify(report),
      resolution,
    }).pipe(Effect.orDie),
  );
};

const scopes = (outcome: BodyOutcome): readonly string[] =>
  outcome.diagnostics.map((diagnostic) => diagnostic.scope);

describe("field scope: one refused optional form property", () => {
  test('PRM-27: an optional deepObject over anyOf of an object and "" is refused at field scope and the alternative stays', () => {
    const outcome = bodyWith(fieldBody({ expand: objectOrEmpty, name: string }, ["expand"]));
    const found = formAlternative(outcome);

    expect(found.refusedFields?.map(String)).toEqual(["expand"]);
    expect(markers(found)).toEqual({ name: undefined });
    expect(findings(outcome.diagnostics)).toEqual([
      {
        code: "PRM-27/non-object-schema",
        pointer: `${media}/encoding/expand`,
        related: [],
        row: "PRM-27",
        scope: "field",
        severity: "refusal",
      },
    ]);
    // The field refusal names the property by its wire name, which the help REFUSED line shows.
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.wire)).toEqual(["expand"]);
  });

  test("PRM-27: optional refused properties before a required one drop the alternative with no field record", () => {
    const requestBody = fieldBody(
      { a: objectOrEmpty, b: objectOrEmpty, c: objectOrEmpty },
      ["a", "b", "c"],
      { required: ["c"] },
    );
    const outcome = bodyWith(requestBody);

    expect(outcome._tag).toBe("Refused");
    expect(scopes(outcome)).not.toContain("field");
    expect([...new Set(findings(outcome.diagnostics).map((found) => found.pointer))]).toEqual([
      media,
    ]);

    const coverage = joined(resolutionOf(requestBody));

    expect(coverage.missing).toEqual([]);
    expect(coverage.invented).toEqual([]);
  });

  test("PRM-27: a property required only through allOf drops the alternative with no field record", () => {
    const outcome = bodyWith(
      fieldBody({ expand: objectOrEmpty }, ["expand"], { allOf: [{ required: ["expand"] }] }),
    );

    expect(outcome._tag).toBe("Refused");
    expect(scopes(outcome)).not.toContain("field");
    expect(findings(outcome.diagnostics).map((found) => found.pointer)).toEqual([media]);
  });

  test("PRM-27: a composition the walk does not resolve counts the property as required", () => {
    const outcome = bodyWith(
      fieldBody({ expand: objectOrEmpty }, ["expand"], {
        oneOf: [{ required: ["expand"] }, { required: ["other"] }],
      }),
    );

    expect(outcome._tag).toBe("Refused");
    expect(scopes(outcome)).not.toContain("field");
  });
});

// Design 8.5 rule 4 under a `$ref` body: a 3.1 operation whose request body is `$ref` to
// `components/requestBodies`. The field refusal is placed as an element refusal of that body is,
// at the use site with its Encoding entry in the target as `related[0]` (design 8.1), and the
// coverage join credits it there.

const openapi31 = "3.1.0";

const target = "/components/requestBodies/Create";

const resolution31 = (requestBody: Json, requestBodies?: Members) =>
  Effect.runSync(
    resolve({
      document: entry,
      line: "3.1",
      value: documentOf(requestBody, openapi31, requestBodies),
    }),
  );

const switchedConfig = Schema.decodeUnknownSync(AuthorConfig)({
  binName: "example",
  nonStandard: { deepObjectBrackets: true },
  package: { name: "example-cli", version: "1.0.0" },
});

const createBody = fieldBody({ expand: objectOrEmpty, name: string }, ["expand"]);

describe("field scope under a $ref request body", () => {
  test("PRM-27: the field refusal sits at the use site, its Encoding entry in the target related", () => {
    const outcome = Effect.runSync(
      normalizeBody(resolution31({ $ref: `#${target}` }, { Create: createBody }), {
        nonStandard: { deepObjectBrackets: true },
        openapi: openapi31,
        pointer: site,
      }),
    );

    expect(formAlternative(outcome).refusedFields?.map(String)).toEqual(["expand"]);
    expect(findings(outcome.diagnostics)).toEqual([
      {
        code: "PRM-27/non-object-schema",
        pointer: site,
        related: [`${target}/content/application~1x-www-form-urlencoded/encoding/expand`],
        row: "PRM-27",
        scope: "field",
        severity: "refusal",
      },
    ]);
  });

  test("PRM-27: the coverage join reports nothing missing or invented", () => {
    const coverage = joined(
      resolution31({ $ref: `#${target}` }, { Create: createBody }),
      switchedConfig,
    );

    expect(coverage.missing).toEqual([]);
    expect(coverage.invented).toEqual([]);
  });

  test("PRM-27: the same body inline joins with nothing missing or invented", () => {
    const coverage = joined(resolution31(createBody), switchedConfig);

    expect(coverage.missing).toEqual([]);
    expect(coverage.invented).toEqual([]);
  });
});

// Design 6.1 Scalar switch (M3-D92 C; R86): a form deepObject Encoding entry follows the query
// parameter rule. With `nonStandard.deepObjectScalars`, an entry whose every branch is covered is
// generated with the scalar marker and its notice; an uncovered branch keeps today's refusal.
interface Switches {
  readonly deepObjectBrackets?: boolean;
  readonly deepObjectScalars?: boolean;
}

const bodyUnder = (requestBody: Json, nonStandard: Switches): BodyOutcome =>
  Effect.runSync(normalizeBody(resolutionOf(requestBody), { nonStandard, openapi, pointer: site }));

const ruleMarkers = (found: MediaAlternative): Record<string, readonly (string | undefined)[]> =>
  Object.fromEntries(
    found.encoding.map((rule: EncodingRule) => [
      rule.target.kind === "property" ? rule.target.name : `#${rule.target.index}`,
      [rule.nonStandard, rule.nonStandardScalars],
    ]),
  );

const scalarChoice = (name: string) => ({
  code: "PRM-27/scalar-author-choice",
  pointer: `${media}/encoding/${name}`,
  related: [],
  row: "PRM-27",
  scope: "element",
  severity: "notice",
});

const nestedOrEmpty: Json = {
  anyOf: [nestedProperties.metadata ?? {}, { enum: [""], type: "string" }],
};

describe("PRM-27 scalar switch: a covered form deepObject union is generated and marked", () => {
  test('PRM-27: anyOf of a one-level object and "" is generated, marked and noticed', () => {
    const outcome = bodyUnder(fieldBody({ expand: objectOrEmpty, name: string }, ["expand"]), {
      deepObjectScalars: true,
    });
    const found = formAlternative(outcome);

    expect(found.refusedFields ?? []).toEqual([]);
    expect(ruleMarkers(found)).toEqual({
      expand: [undefined, "deepObjectScalars"],
      name: [undefined, undefined],
    });
    expect(findings(outcome.diagnostics)).toEqual([scalarChoice("expand")]);
  });

  test('PRM-27: with both switches, anyOf of a nested object and "" carries both markers', () => {
    const outcome = bodyUnder(fieldBody({ expand: nestedOrEmpty }, ["expand"]), {
      deepObjectBrackets: true,
      deepObjectScalars: true,
    });

    expect(ruleMarkers(formAlternative(outcome))).toEqual({
      expand: ["deepObjectBrackets", "deepObjectScalars"],
    });
    expect(findings(outcome.diagnostics)).toEqual([
      bracketChoice("expand"),
      scalarChoice("expand"),
    ]);
  });

  test('PRM-27: with the scalar switch alone, anyOf of a nested object and "" is refused at field scope', () => {
    const outcome = bodyUnder(fieldBody({ expand: nestedOrEmpty, name: string }, ["expand"]), {
      deepObjectScalars: true,
    });

    expect(formAlternative(outcome).refusedFields?.map(String)).toEqual(["expand"]);
    expect(findings(outcome.diagnostics).map((found) => [found.code, found.scope])).toEqual([
      ["PRM-27/compound-nested", "field"],
    ]);
  });

  test("PRM-27: a null or untyped branch stays refused under either switch", () => {
    for (const schema of [{ anyOf: [nestedProperties.metadata ?? {}, { type: "null" }] }, {}]) {
      for (const deepObjectBrackets of [false, true]) {
        const outcome = bodyUnder(fieldBody({ expand: schema, name: string }, ["expand"]), {
          deepObjectBrackets,
          deepObjectScalars: true,
        });

        expect(findings(outcome.diagnostics).map((found) => [found.code, found.scope])).toEqual([
          ["PRM-27/non-object-schema", "field"],
        ]);
      }
    }
  });

  test("PRM-27: a refused alternative keeps no scalar notice", () => {
    const outcome = bodyUnder(
      bodyOf({ expand: objectOrEmpty, items: nestedProperties.items ?? {} }),
      {
        deepObjectScalars: true,
      },
    );

    expect(outcome._tag).toBe("Refused");
    expect(findings(outcome.diagnostics)).toEqual([compoundNested("items")]);
  });

  test("PRM-27: without the scalar switch every case refuses as today", () => {
    for (const nonStandard of [{}, { deepObjectBrackets: true }, { deepObjectScalars: false }]) {
      for (const schema of [objectOrEmpty, nestedOrEmpty]) {
        const outcome = bodyUnder(
          fieldBody({ expand: schema, name: string }, ["expand"]),
          nonStandard,
        );

        expect(findings(outcome.diagnostics).map((found) => found.code)).toEqual([
          "PRM-27/non-object-schema",
        ]);
      }
    }
  });
});
