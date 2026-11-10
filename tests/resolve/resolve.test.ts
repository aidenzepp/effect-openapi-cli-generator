import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Effect, Option, Schema } from "effect";
import { loadBytes } from "../../src/load/index.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { defsKey, keyOf } from "../../src/resolve/canonical.ts";
import {
  allOfReferrers,
  implicitComponent,
  operationById,
  referenceAt,
  resolve,
} from "../../src/resolve/index.ts";
import type { Resolution, ResolveLimits } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";
import type { Line } from "../../src/validate/index.ts";

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const openapi: Record<Line, string> = { "3.0": "3.0.3", "3.1": "3.1.1", "3.2": "3.2.0" };

const lines: readonly Line[] = ["3.0", "3.1", "3.2"];

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

// One $id appears per round (D(i) reaches D(i + 1) by pointer) while `waiting` sites wait on an $id
// that never appears, so a resolver that retries every waiting site each round does rounds * waiting
// lookups.
const deferredFlood = (rounds: number, waiting: number) => {
  const revealed = Array.from({ length: rounds }, (_, index): [string, Json] => [
    `D${index}`,
    {
      $id: `https://example.com/d${index}.json`,
      allOf: [{ $ref: `${entry}#/x-defs/D${index + 1}` }],
    },
  ]);
  const stuck = Array.from({ length: waiting }, (_, index): [string, Json] => [
    `W${index}`,
    { $ref: "https://example.com/never.json" },
  ]);

  return {
    components: {
      schemas: Object.fromEntries([...stuck, ["Start", { $ref: "#/x-defs/D0" }]]),
    },
    "x-defs": Object.fromEntries([...revealed, [`D${rounds}`, { type: "string" }]]),
  };
};

// One $anchor appears in the document resource per round while `waiting` sites wait on an anchor of
// that resource that never appears, so every round retries every waiting site.
const anchorFlood = (rounds: number, waiting: number) => {
  const revealed = Array.from({ length: rounds }, (_, index): [string, Json] => [
    `A${index}`,
    { $anchor: `a${index}`, allOf: [{ $ref: `#/x-defs/A${index + 1}` }] },
  ]);
  const stuck = Array.from({ length: waiting }, (_, index): [string, Json] => [
    `W${index}`,
    { $ref: "#never" },
  ]);

  return {
    components: {
      schemas: Object.fromEntries([...stuck, ["Start", { $ref: "#/x-defs/A0" }]]),
    },
    "x-defs": Object.fromEntries([...revealed, [`A${rounds}`, { type: "string" }]]),
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

const usesSchema = (ref: string) =>
  usesParameter({ in: "query", name: "q", schema: { $ref: ref } });

// One reference used as an operation Parameter and as a response Header.
const parameterAndHeader = (ref: string) => ({
  paths: {
    "/a": {
      get: {
        parameters: [{ $ref: ref }],
        responses: { "200": { description: "ok", headers: { "X-A": { $ref: ref } } } },
      },
    },
  },
});

describe("REF-14 a JSON Pointer crossing a schema $id", () => {
  const withId = {
    schemas: {
      S: { $defs: { T: { type: "string" } }, $id: "https://example.com/s.json", type: "object" },
    },
  };

  for (const line of ["3.1", "3.2"] as const) {
    test(`a pointer into a schema below its $id resolves with a notice naming the $id (${line})`, () => {
      const resolution = resolved(
        line,
        spec(line, { components: withId, ...usesSchema("#/components/schemas/S/$defs/T") }),
      );

      expect(targetOf(resolution, "/paths/~1a/get/parameters/0/schema")).toBe(
        "/components/schemas/S/$defs/T",
      );
      expect(
        resolution.diagnostics.map((diagnostic) => [
          diagnostic.code,
          diagnostic.severity,
          diagnostic.scope,
          diagnostic.pointer,
        ]),
      ).toEqual([
        ["REF-14/pointer-crosses-id", "notice", "element", "/paths/~1a/get/parameters/0/schema"],
      ]);
      expect<readonly { document: string; pointer: string }[] | undefined>(
        resolution.diagnostics[0]?.related,
      ).toEqual([{ document: entry, pointer: "/components/schemas/S" }]);
    });

    test(`a pointer to the $id schema itself, or from its $id, raises nothing (${line})`, () => {
      const atRoot = resolved(
        line,
        spec(line, { components: withId, ...usesSchema("#/components/schemas/S") }),
      );
      const fromId = resolved(
        line,
        spec(line, { components: withId, ...usesSchema("https://example.com/s.json#/$defs/T") }),
      );

      expect([codes(atRoot), codes(fromId)]).toEqual([[], []]);
    });
  }
});

describe("DOC-19 one node as two object types", () => {
  const header = { in: "header", name: "X-A", schema: { type: "string" } };
  const headerSite = "/paths/~1a/get/responses/200/headers/X-A";

  for (const line of lines) {
    test(`a component Parameter referenced as a response Header is refused naming both pointers (${line})`, () => {
      const diagnostic = refusal(
        line,
        spec(line, {
          components: { parameters: { P: header } },
          ...parameterAndHeader("#/components/parameters/P"),
        }),
      );

      expect([diagnostic.code, diagnostic.scope, diagnostic.severity, diagnostic.pointer]).toEqual([
        "DOC-19/two-object-types",
        "document",
        "refusal",
        headerSite,
      ]);
      expect<readonly { document: string; pointer: string }[] | undefined>(
        diagnostic.related,
      ).toEqual([{ document: entry, pointer: "/components/parameters/P" }]);
    });
  }

  test("an untyped node referenced as two types names both reference sites", () => {
    const diagnostic = refusal(
      "3.1",
      spec("3.1", { "x-shared": header, ...parameterAndHeader("#/x-shared") }),
    );

    // Settled targets are walked last-in first, so the Header use is walked before the Parameter.
    expect([diagnostic.code, diagnostic.pointer]).toEqual([
      "DOC-19/two-object-types",
      "/paths/~1a/get/parameters/0",
    ]);
    expect<readonly { document: string; pointer: string }[] | undefined>(
      diagnostic.related,
    ).toEqual([{ document: entry, pointer: headerSite }]);
  });

  test("a node referenced twice as one type is not refused", () => {
    const value = spec("3.1", {
      components: { parameters: { P: header } },
      paths: {
        "/a": {
          get: {
            parameters: [{ $ref: "#/components/parameters/P" }],
            responses: { "200": { description: "ok" } },
          },
          parameters: [{ $ref: "#/components/parameters/P" }],
        },
      },
    });

    expect(codes(resolved("3.1", value))).toEqual([]);
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

  test("REF-18 deferred retries are charged to the node budget", () => {
    const value = spec("3.1", anchorFlood(2000, 2000));

    expect(refusal("3.1", value, { maxNodes: 50_000 }).code).toBe("REF-18/node-budget");
  });

  test("deferred sites retry only when their resource gains an $id or $anchor", () => {
    const value = spec("3.1", deferredFlood(2000, 2000));

    expect(refusal("3.1", value, { maxNodes: 50_000 }).code).toBe("REF-16/outside-set");
  });

  test("references to one unknown resource cost linear work", () => {
    const value = spec("3.1", {
      components: {
        schemas: { S: { allOf: Array.from({ length: 200_000 }, () => ({ $ref: "x:y" })) } },
      },
    });

    expect(refusal("3.1", value).code).toBe("REF-16/outside-set");
  }, 10_000);

  test("REF-18 a walk past the node budget is refused", () => {
    expect(refusal("3.1", spec("3.1", dag(30)), { maxNodes: 20 }).code).toBe("REF-18/node-budget");
  });
});

// Path items A and B each reach themselves through a callback. Components precede paths here, so
// the walk meets A's reference first: A is the first name and the first owner of an edge.
const selfCycles = (paths: Json): Json => ({
  components: {
    pathItems: {
      A: {
        get: {
          callbacks: { cb: { "{$u}": { $ref: "#/components/pathItems/A" } } },
          responses: { "200": { description: "ok" } },
        },
      },
      B: {
        get: {
          callbacks: { cb: { "{$u}": { $ref: "#/components/pathItems/B" } } },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  },
  info: { title: "t", version: "1" },
  openapi: openapi["3.1"],
  paths,
});

type ClosingEdge = readonly [
  code: string,
  pointer: string,
  related: readonly { document: string; pointer: string }[] | undefined,
];

const closingEdge = (value: Json): ClosingEdge => {
  const diagnostic = refusal("3.1", value);

  return [diagnostic.code, diagnostic.pointer, diagnostic.related];
};

const closedBy = (name: string): ClosingEdge => [
  "DOC-23/non-schema-cycle",
  `/components/pathItems/${name}/get/callbacks/cb/{$u}`,
  [{ document: entry, pointer: `/components/pathItems/${name}` }],
];

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

  test("a cycle through a target nested inside another target is a document refusal", () => {
    const value = spec("3.1", {
      components: {
        pathItems: {
          P: {
            get: {
              callbacks: { cb: { "{$u}": { $ref: "#/components/pathItems/P" } } },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      },
      paths: {
        "/a": { $ref: "#/components/pathItems/P" },
        "/b": {
          get: {
            callbacks: { c2: { $ref: "#/components/pathItems/P/get/callbacks/cb" } },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });

    expect(refusal("3.1", value).code).toBe("DOC-23/non-schema-cycle");
  });

  test("DOC-23 names the edge that closes the first cycle", () => {
    // Only B is reachable from the root. The root is visited before every name, so B's cycle is
    // reported though A comes first in reference order and owns the first edge.
    expect(closingEdge(selfCycles({ "/b": { $ref: "#/components/pathItems/B" } }))).toEqual(
      closedBy("B"),
    );
  });

  test("DOC-23 visits names in reference order when the root reaches no cycle", () => {
    // Neither cycle is reachable from the root, so the first name in reference order, A, decides.
    expect(closingEdge(selfCycles({}))).toEqual(closedBy("A"));
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

const scoped = (diagnostic: { code: string; scope: string; severity: string }) => [
  diagnostic.code,
  diagnostic.scope,
  diagnostic.severity,
];

describe("rule scope and severity", () => {
  const elements: readonly (readonly [Line, Json])[] = [
    [
      "3.0",
      spec("3.0", {
        components: { parameters: { P: parameter } },
        ...usesParameter({ $ref: "#/components/parameters/P", description: "ignored" }),
      }),
    ],
    [
      "3.1",
      spec("3.1", {
        components: { parameters: { P: parameter } },
        ...usesParameter({ $ref: "#/components/parameters/P", "x-other": true }),
      }),
    ],
    [
      "3.0",
      spec("3.0", {
        components: {
          schemas: { A: { $ref: "#/components/schemas/B", nullable: true }, B: { type: "string" } },
        },
      }),
    ],
    [
      "3.1",
      spec("3.1", {
        components: {
          schemas: {
            S: { $defs: { T: { type: "string" } }, $id: "https://example.com/s.json" },
          },
        },
        ...usesSchema("#/components/schemas/S/$defs/T"),
      }),
    ],
    ["3.1", spec("3.1", { components: { schemas: { A: { $dynamicRef: "#meta" } } } })],
    ["3.2", uriLikeScheme("3.2")],
  ];

  test("scope and severity of every resolve rule", () => {
    expect(
      elements.flatMap(([line, value]) => resolved(line, value).diagnostics.map(scoped)),
    ).toEqual([
      ["REF-05/sibling-ignored", "element", "notice"],
      ["REF-06/sibling-ignored", "element", "notice"],
      ["REF-07/sibling-ignored", "element", "notice"],
      ["REF-14/pointer-crosses-id", "element", "notice"],
      ["SCH-05/dynamic-ref", "element", "refusal"],
      ["SEC-10/uri-like-name", "element", "refusal"],
    ]);
    expect(
      scoped(refusal("3.1", spec("3.1", usesParameter({ $ref: "#/components/parameters/X" })))),
    ).toEqual(["REF-18/unresolvable", "document", "refusal"]);
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

  test("DSC-03 DSC-08 a schema name that is not a component name is a URI resolved inside the set on every line", () => {
    const inSet = "./openapi.json#/components/schemas/Pet";
    const outside = "./other.json#/components/schemas/Pet";

    expect(
      lines.map((line) => implicitComponent(resolved(line, spec(line, members)), "schemas", inSet)),
    ).toEqual(
      lines.map(() => Option.some({ document: entry, pointer: "/components/schemas/Pet" })),
    );
    expect(
      lines.map((line) =>
        Option.isNone(implicitComponent(resolved(line, spec(line, members)), "schemas", outside)),
      ),
    ).toEqual(lines.map(() => true));
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

const schemaRef = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });

describe("DSC-05 DSC-11 allOf referrers", () => {
  const members: Members = {
    components: {
      schemas: {
        Cat: { allOf: [schemaRef("Pet"), { type: "object" }] },
        Dog: { allOf: [{ type: "object" }, schemaRef("Pet")] },
        Either: { oneOf: [schemaRef("Pet"), schemaRef("Cat")] },
        Pet: { type: "object" },
      },
    },
  };

  test("maps each schema to the allOf members that reference it, from every component", () => {
    const resolution = resolved("3.1", spec("3.1", members));
    const referrers = allOfReferrers(resolution);
    const sites = (name: string) =>
      new Set(
        (
          referrers.get(keyOf({ document: entry, pointer: `/components/schemas/${name}` })) ?? []
        ).map((site) => site.pointer),
      );

    expect([sites("Pet"), sites("Cat")]).toEqual([
      new Set(["/components/schemas/Cat/allOf/0", "/components/schemas/Dog/allOf/1"]),
      new Set(),
    ]);
    expect(allOfReferrers(resolution)).toBe(referrers);
  });
});
