import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Effect, Option, Schema } from "effect";
import { loadBytes } from "../../src/load/index.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { defsKey } from "../../src/resolve/canonical.ts";
import { implicitComponent, operationById, referenceAt, resolve } from "../../src/resolve/index.ts";
import type { Resolution, ResolveLimits } from "../../src/resolve/index.ts";
import type { Json } from "../../src/resolve/pointer.ts";
import type { Line } from "../../src/validate/index.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const openapi: Record<Line, string> = { "3.0": "3.0.3", "3.1": "3.1.1", "3.2": "3.2.0" };

interface Members {
  readonly [key: string]: Json;
}

const spec = (line: Line, members: Members): Json => ({
  info: { title: "t", version: "1" },
  openapi: openapi[line],
  paths: {},
  ...members,
});

const run = (
  line: Line,
  value: Json,
  limits: Partial<ResolveLimits> = {},
): Effect.Effect<Resolution, unknown> => resolve({ document: entry, line, value }, limits);

const resolved = (line: Line, value: Json, limits: Partial<ResolveLimits> = {}): Resolution =>
  Effect.runSync(run(line, value, limits));

const refusal = (line: Line, value: Json, limits: Partial<ResolveLimits> = {}) =>
  Effect.runSync(Effect.flip(resolve({ document: entry, line, value }, limits))).diagnostic;

const fixture = (name: string): Json => {
  const bytes = new Uint8Array(
    readFileSync(new URL(`../fixtures/resolve/${name}`, import.meta.url)),
  );

  return Effect.runSync(loadBytes(bytes, { document: entry })).value;
};

const targetOf = (resolution: Resolution, pointer: string): string | undefined =>
  referenceAt(resolution, pointer)?.target.pointer;

const codes = (resolution: Resolution): readonly string[] =>
  resolution.diagnostics.map((diagnostic) => diagnostic.code);

const parameter: Json = { in: "query", name: "q", schema: { type: "string" } };

const usesParameter = (ref: Members) => ({
  paths: { "/a": { get: { parameters: [ref], responses: { "200": { description: "ok" } } } } },
});

// P0 to P(links - 1) each refer to the next; P(links) is the parameter.
const chain = (links: number) => {
  const hops = Array.from({ length: links }, (_, index): [string, Json] => [
    `P${index}`,
    { $ref: `#/components/parameters/P${index + 1}` },
  ]);

  return { components: { parameters: Object.fromEntries([...hops, [`P${links}`, parameter]]) } };
};

// S0 to S(levels - 1) each refer to the next twice, so S0 has 2^levels paths to S(levels).
const dag = (levels: number) => {
  const nodes = Array.from({ length: levels }, (_, index): [string, Json] => {
    const next = { $ref: `#/components/schemas/S${index + 1}` };

    return [`S${index}`, { allOf: [next, next] }];
  });

  return {
    components: { schemas: Object.fromEntries([...nodes, [`S${levels}`, { type: "string" }]]) },
  };
};

const siblingSchemas = (inner: string): Json =>
  spec("3.1", {
    components: {
      schemas: {
        A: { $ref: "#/components/schemas/B", properties: { x: { $ref: inner } } },
        B: { type: "string" },
      },
    },
  });

const uriLikeScheme = (line: Line): Json =>
  spec(line, {
    components: {
      securitySchemes: { "https://evil.example/s": { scheme: "bearer", type: "http" } },
    },
  });

describe("canonical keys", () => {
  test("a local target is keyed by document and decoded pointer", () => {
    const resolution = resolved("3.0", fixture("base-3.0.json"));

    expect(referenceAt(resolution, "/components/schemas/Local")?.target).toEqual({
      document: entry,
      pointer: "/components/schemas/A",
    });
    expect(targetOf(resolution, "/components/schemas/Escaped")).toBe("/components/schemas/c%d");
  });

  test("$defs keys use the component name, else the pointer", () => {
    expect(defsKey(entry, { document: entry, pointer: "/components/schemas/Pet" })).toBe("Pet");
    expect(defsKey(entry, { document: entry, pointer: "/components/schemas/a b" })).toBe(
      "/components/schemas/a b",
    );
    expect(defsKey(entry, { document: entry, pointer: "/x-defs/Pet" })).toBe("/x-defs/Pet");

    const resolution = resolved(
      "3.1",
      spec("3.1", {
        components: { schemas: { Pet: { type: "string" } } },
        paths: {
          "/a": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: { items: { $ref: "#/components/schemas/Pet" }, type: "array" },
                    },
                  },
                  description: "ok",
                },
                "201": {
                  content: {
                    "application/json": {
                      schema: {
                        $ref: "#/paths/~1a/get/responses/200/content/application~1json/schema",
                      },
                    },
                  },
                  description: "ok",
                },
              },
            },
          },
        },
      }),
    );
    const inline = "/paths/~1a/get/responses/200/content/application~1json/schema";

    expect(resolution.defs.get(`${entry}#/components/schemas/Pet`)).toBe("Pet");
    expect(resolution.defs.get(`${entry}#${inline}`)).toBe(inline);
    expect(referenceAt(resolution, `${inline}/items`)?.defsKey).toBe("Pet");
  });
});

describe("REF-10, REF-11, REF-12, REF-17 base URIs per line", () => {
  test("3.0 resolves against the document URL and ignores $id", () => {
    const resolution = resolved("3.0", fixture("base-3.0.json"));

    expect(targetOf(resolution, "/components/schemas/Retrieval")).toBe("/components/schemas/A");
    expect(targetOf(resolution, "/components/schemas/Relative")).toBe("/components/schemas/A");

    const viaId = spec("3.0", {
      components: {
        schemas: {
          ById: { $ref: "https://example.com/with-id.json" },
          WithId: { $id: "https://example.com/with-id.json", type: "object" },
        },
      },
    });

    expect(refusal("3.0", viaId).code).toBe("REF-16/outside-set");
  });

  test("3.1 resolves schema references against the nearest $id, by pointer and by $anchor", () => {
    const resolution = resolved("3.1", fixture("base-3.1.json"));
    const tag = "/components/schemas/Pet/$defs/Tag";

    expect(targetOf(resolution, "/components/schemas/Pet/properties/tag")).toBe(tag);
    expect(targetOf(resolution, "/components/schemas/Pet/properties/owner")).toBe(
      "/components/schemas/Owner",
    );
    expect(targetOf(resolution, "/components/schemas/ByAnchor")).toBe(tag);
    expect(targetOf(resolution, "/components/schemas/ByPointer")).toBe(tag);
    expect(targetOf(resolution, "/components/schemas/Late/allOf/1")).toBe("/x-defs/Late");
  });

  test("3.2 resolves against $self with its fragment stripped, and the retrieval URI", () => {
    const resolution = resolved("3.2", fixture("base-3.2.json"));

    expect(resolution.base).toBe("https://api.example.com/v1/openapi.json");
    expect(targetOf(resolution, "/components/schemas/BySelf")).toBe("/components/schemas/A");
    expect(targetOf(resolution, "/components/schemas/Relative")).toBe("/components/schemas/A");
    expect(targetOf(resolution, "/components/schemas/Retrieval")).toBe("/components/schemas/A");
  });

  test("3.2 refuses a $self that is not a URI", () => {
    expect(refusal("3.2", spec("3.2", { $self: "http://[" })).code).toBe("REF-12/invalid-base");
  });

  test("a relative reference under 3.2 resolves against $self, outside the set", () => {
    const value = spec("3.2", {
      $self: "https://api.example.com/v1/openapi.json",
      components: { schemas: { A: { $ref: "other.json#/A" } } },
    });

    expect(refusal("3.2", value).code).toBe("REF-15/outside-set");
  });
});

describe("REF-15, REF-16 no URI outside the document set (I6)", () => {
  afterEach(() => {
    mock.restore();
  });

  test("REF-15 a relative file reference is refused with its use site", () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const diagnostic = refusal("3.0", spec("3.0", usesParameter({ $ref: "other.yaml#/P" })));

    expect(diagnostic.code).toBe("REF-15/outside-set");
    expect(diagnostic.scope).toBe("document");
    expect<string>(diagnostic.pointer).toBe("/paths/~1a/get/parameters/0");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("REF-16 an absolute URI outside the set is refused without a request", () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const value = spec("3.1", {
      components: { schemas: { A: { $ref: "https://example.com/schemas/a.json" } } },
    });

    expect(refusal("3.1", value).code).toBe("REF-16/outside-set");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("REF-18 unresolvable references", () => {
  test("a missing pointer target names the target in related", () => {
    const diagnostic = refusal(
      "3.1",
      spec("3.1", usesParameter({ $ref: "#/components/parameters/Missing" })),
    );

    expect(diagnostic.code).toBe("REF-18/unresolvable");
    expect<readonly { document: string; pointer: string }[] | undefined>(
      diagnostic.related,
    ).toEqual([{ document: entry, pointer: "/components/parameters/Missing" }]);
  });

  test("a plain-name fragment resolves only as a schema $anchor", () => {
    const value = spec("3.1", {
      components: { parameters: { P: { $anchor: "p", ...parameter } } },
      ...usesParameter({ $ref: "#p" }),
    });

    expect(refusal("3.1", value).code).toBe("REF-18/unresolvable");
  });

  test("REF-14 two schemas with one $id are refused", () => {
    const value = spec("3.1", {
      components: {
        schemas: {
          A: { $id: "https://example.com/same.json" },
          B: { $id: "https://example.com/same.json" },
        },
      },
    });

    expect(refusal("3.1", value).code).toBe("REF-14/duplicate-id");
  });
});

describe("REF-05, REF-06, REF-07, REF-08 siblings per line", () => {
  test("REF-05 3.0 Reference Object siblings are ignored with a notice", () => {
    const value = spec("3.0", {
      components: { parameters: { P: parameter } },
      ...usesParameter({ $ref: "#/components/parameters/P", description: "ignored" }),
    });
    const resolution = resolved("3.0", value);

    expect(codes(resolution)).toEqual(["REF-05/sibling-ignored"]);
    expect<string | undefined>(resolution.diagnostics[0]?.pointer).toBe(
      "/paths/~1a/get/parameters/0",
    );
    expect(referenceAt(resolution, "/paths/~1a/get/parameters/0")?.description).toBeUndefined();
  });

  test("REF-07 3.0 schema $ref siblings are ignored and not walked", () => {
    const value = spec("3.0", {
      components: {
        schemas: {
          A: {
            $ref: "#/components/schemas/B",
            nullable: true,
            properties: { x: { $ref: "#/no" } },
          },
          B: { type: "string" },
        },
      },
    });

    expect(codes(resolved("3.0", value))).toEqual(["REF-07/sibling-ignored"]);
  });

  test("REF-06 3.1 summary and description override; other siblings are ignored", () => {
    const value = spec("3.1", {
      components: { parameters: { P: parameter } },
      ...usesParameter({
        $ref: "#/components/parameters/P",
        description: "use-site description",
        summary: "use-site summary",
        "x-other": true,
      }),
    });
    const resolution = resolved("3.1", value);
    const reference = referenceAt(resolution, "/paths/~1a/get/parameters/0");

    expect(reference?.description).toBe("use-site description");
    expect(reference?.summary).toBe("use-site summary");
    expect(codes(resolution)).toEqual(["REF-06/sibling-ignored"]);
  });

  test("REF-08 3.1 schema $ref siblings apply and are walked", () => {
    const resolution = resolved("3.1", siblingSchemas("#/components/schemas/B"));

    expect(targetOf(resolution, "/components/schemas/A/properties/x")).toBe(
      "/components/schemas/B",
    );
    expect(refusal("3.1", siblingSchemas("#/no")).code).toBe("REF-18/unresolvable");
  });

  test("$ref inside example, const, enum, default and extensions is data", () => {
    const data = { $ref: "#/nowhere" };
    const value = spec("3.1", {
      components: {
        schemas: {
          A: { const: data, default: data, enum: [data], example: data, examples: [data] },
        },
      },
      paths: {
        "/a": {
          get: {
            requestBody: {
              content: { "application/json": { example: data, examples: { e: { value: data } } } },
            },
            responses: { "200": { description: "ok" } },
            "x-ext": data,
          },
        },
      },
    });

    expect(resolved("3.1", value).references.size).toBe(0);
  });
});

describe("I5 hop and node budgets", () => {
  test("a 64-hop chain resolves to its final target", () => {
    const reference = referenceAt(
      resolved(
        "3.0",
        spec("3.0", { ...chain(63), ...usesParameter({ $ref: "#/components/parameters/P0" }) }),
      ),
      "/paths/~1a/get/parameters/0",
    );

    expect(reference?.target.pointer).toBe("/components/parameters/P63");
    expect(reference?.via).toHaveLength(63);
  });

  test("REF-18 a 65-hop chain is refused", () => {
    const value = spec("3.0", {
      ...chain(64),
      ...usesParameter({ $ref: "#/components/parameters/P0" }),
    });

    expect(refusal("3.0", value).code).toBe("REF-18/hop-limit");
  });

  test("REF-18 a 10k-hop chain is refused inside the hop budget", () => {
    const value = spec("3.0", {
      ...chain(10_000),
      ...usesParameter({ $ref: "#/components/parameters/P0" }),
    });

    expect(refusal("3.0", value).code).toBe("REF-18/hop-limit");
  });

  test("a 2^30-path schema DAG resolves inside a small node budget", () => {
    const resolution = resolved("3.1", spec("3.1", dag(30)), { maxNodes: 1000 });

    expect(resolution.defs.size).toBe(30);
    expect(resolution.references.size).toBe(60);
  });

  test("REF-18 a walk past the node budget is refused", () => {
    expect(refusal("3.1", spec("3.1", dag(30)), { maxNodes: 20 }).code).toBe("REF-18/node-budget");
  });
});

describe("DOC-23 reference cycles", () => {
  test("a non-schema reference chain cycle is a document refusal", () => {
    const value = spec("3.0", {
      components: {
        parameters: {
          P: { $ref: "#/components/parameters/Q" },
          Q: { $ref: "#/components/parameters/P" },
        },
      },
    });
    const diagnostic = refusal("3.0", value);

    expect(diagnostic.code).toBe("DOC-23/non-schema-cycle");
    expect(diagnostic.scope).toBe("document");
  });

  test("a self-reference is a document refusal", () => {
    const value = spec("3.1", {
      components: { responses: { R: { $ref: "#/components/responses/R" } } },
    });

    expect(refusal("3.1", value).code).toBe("DOC-23/non-schema-cycle");
  });

  test("a path item that reaches itself through a callback is a document refusal", () => {
    const value = spec("3.1", {
      components: {
        pathItems: {
          A: {
            get: {
              callbacks: { cb: { "{$request.body#/url}": { $ref: "#/components/pathItems/A" } } },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      },
      paths: { "/a": { $ref: "#/components/pathItems/A" } },
    });

    expect(refusal("3.1", value).code).toBe("DOC-23/non-schema-cycle");
  });

  test("schema cycles are allowed", () => {
    const value = spec("3.1", {
      components: {
        schemas: {
          B: { properties: { c: { $ref: "#/components/schemas/C" } } },
          C: { properties: { b: { $ref: "#/components/schemas/B" } } },
          Node: { properties: { next: { $ref: "#/components/schemas/Node" } } },
        },
      },
    });
    const resolution = resolved("3.1", value);

    expect(targetOf(resolution, "/components/schemas/Node/properties/next")).toBe(
      "/components/schemas/Node",
    );
    expect(resolution.defs.size).toBe(3);
  });
});

describe("SCH-05 $dynamicRef", () => {
  test("is refused at element scope at the referencing site", () => {
    const resolution = resolved(
      "3.1",
      spec("3.1", { components: { schemas: { A: { $dynamicRef: "#meta" } } } }),
    );

    expect(codes(resolution)).toEqual(["SCH-05/dynamic-ref"]);
    expect(resolution.diagnostics[0]?.scope).toBe("element");
    expect<string | undefined>(resolution.diagnostics[0]?.pointer).toBe("/components/schemas/A");
  });
});

describe("DOC-20, SEC-10 implicit connections from the entry document", () => {
  const members: Members = {
    components: {
      schemas: { Pet: { type: "string" } },
      securitySchemes: { api_key: { in: "header", name: "X-Key", type: "apiKey" } },
    },
    paths: {
      "/a": { get: { operationId: "getA", responses: { "200": { description: "ok" } } } },
    },
  };

  test("component names and operationIds resolve from the entry document", () => {
    const resolution = resolved("3.1", spec("3.1", members));

    expect(implicitComponent(resolution, "securitySchemes", "api_key")).toEqual(
      Option.some({ document: entry, pointer: "/components/securitySchemes/api_key" }),
    );
    expect(implicitComponent(resolution, "schemas", "Pet")).toEqual(
      Option.some({ document: entry, pointer: "/components/schemas/Pet" }),
    );
    expect(Option.isNone(implicitComponent(resolution, "securitySchemes", "missing"))).toBe(true);
    expect(operationById(resolution, "getA")).toEqual(
      Option.some({ document: entry, pointer: "/paths/~1a/get" }),
    );
    expect(Option.isNone(operationById(resolution, "missing"))).toBe(true);
  });

  test("3.2 resolves a security scheme URI; 3.1 does not", () => {
    const name = "./openapi.json#/components/securitySchemes/api_key";

    expect(
      implicitComponent(resolved("3.2", spec("3.2", members)), "securitySchemes", name),
    ).toEqual(Option.some({ document: entry, pointer: "/components/securitySchemes/api_key" }));
    expect(
      Option.isNone(
        implicitComponent(resolved("3.1", spec("3.1", members)), "securitySchemes", name),
      ),
    ).toBe(true);
  });

  test("SEC-10 3.2 refuses scheme component names that parse as URIs", () => {
    const resolution = resolved("3.2", uriLikeScheme("3.2"));

    expect(codes(resolution)).toEqual(["SEC-10/uri-like-name"]);
    expect<string | undefined>(resolution.diagnostics[0]?.pointer).toBe(
      "/components/securitySchemes/https:~1~1evil.example~1s",
    );
    expect(codes(resolved("3.1", uriLikeScheme("3.1")))).toEqual([]);
  });
});
