import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import type { EncodingRule, MediaAlternative } from "../../src/model/entities.ts";
import { normalizeBody } from "../../src/normalize/bodies.ts";
import type { BodyOutcome } from "../../src/normalize/bodies.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";

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

const formOf = (properties: Members): Json => ({
  encoding: Object.fromEntries(Object.keys(properties).map((name) => [name, deep])),
  schema: { properties, type: "object" },
});

const jsonMedia: Json = { schema: { type: "object" } };

const bodyOf = (properties: Members, required = true, json = false): Json => ({
  content: json
    ? { [formMedia]: formOf(properties), "application/json": jsonMedia }
    : { [formMedia]: formOf(properties) },
  required,
});

const documentOf = (requestBody: Json): Json => ({
  components,
  info: { title: "t", version: "1" },
  openapi,
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
