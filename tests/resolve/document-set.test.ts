import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Effect, Option, Schema } from "effect";
import { loadBytes } from "../../src/load/index.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { keyOf } from "../../src/resolve/canonical.ts";
import type { CanonicalKey } from "../../src/resolve/canonical.ts";
import { implicitComponent, referenceAt, resolve } from "../../src/resolve/index.ts";
import type {
  Resolution,
  ResolvedReference,
  ResolveLimits,
  ResolveMember,
} from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";
import type { Line } from "../../src/validate/index.ts";

type Document = typeof DocumentUri.Type;

const uri = (value: string): Document => Schema.decodeUnknownSync(DocumentUri)(value);

const entry = uri("file:///spec/openapi.json");

const fixture = (name: string, document: Document): Json => {
  const bytes = new Uint8Array(
    readFileSync(new URL(`../fixtures/resolve/multi/${name}`, import.meta.url)),
  );

  return Effect.runSync(loadBytes(bytes, { document })).value;
};

const member = (name: string, document: string): ResolveMember => {
  const at = uri(document);

  return { document: at, value: fixture(name, at) };
};

const input = (line: Line, value: Json, members: readonly ResolveMember[]) => ({
  document: entry,
  line,
  members,
  value,
});

const resolved = (
  line: Line,
  value: Json,
  members: readonly ResolveMember[],
  limits: Partial<ResolveLimits> = {},
): Resolution => Effect.runSync(resolve(input(line, value, members), limits));

const refusal = (
  line: Line,
  value: Json,
  members: readonly ResolveMember[],
  limits: Partial<ResolveLimits> = {},
) => Effect.runSync(Effect.flip(resolve(input(line, value, members), limits))).diagnostic;

const at = (resolution: Resolution, site: CanonicalKey): ResolvedReference | undefined =>
  resolution.references.get(keyOf(site));

const openapi: Record<Line, string> = { "3.0": "3.0.3", "3.1": "3.1.1", "3.2": "3.2.0" };

const spec = (line: Line, members: Record<string, Json>): Json => ({
  info: { title: "t", version: "1" },
  openapi: openapi[line],
  paths: {},
  ...members,
});

const usesParameter = (ref: string) => ({
  paths: {
    "/a": { get: { parameters: [{ $ref: ref }], responses: { "200": { description: "ok" } } } },
  },
});

const parameterAt = "/paths/~1a/get/parameters/0";

describe("references across the document set", () => {
  test("3.0 resolves a relative file against the document URL, and member-local pointers in the member", () => {
    const common = member("common-3.0.json", "file:///spec/common.json");
    const pet = member("pet-3.0.json", "file:///spec/pet.json");
    const resolution = resolved("3.0", fixture("entry-3.0.json", entry), [common, pet]);
    const schemaAt = "/paths/~1pets/get/responses/200/content/application~1json/schema";

    expect(referenceAt(resolution, "/paths/~1pets/get/parameters/0")?.target).toEqual({
      document: common.document,
      pointer: "/parameters/Limit",
    });
    expect(
      at(resolution, { document: common.document, pointer: "/parameters/Limit/schema" })?.target,
    ).toEqual({ document: common.document, pointer: "/schemas/LimitValue" });

    const whole = referenceAt(resolution, schemaAt);

    expect(whole?.target).toEqual({ document: pet.document, pointer: "" });
    expect(whole?.defsKey).toBe(`${pet.document}#`);
    expect(resolution.documents.get(pet.document)).toBe(pet.value);
  });

  test("3.1 resolves a schema reference against the nearest $id into another member", () => {
    const owner = member("owner-3.1.json", "https://schemas.example.com/root/owner.json");
    const resolution = resolved("3.1", fixture("entry-3.1.json", entry), [owner]);
    const ownerKey = { document: owner.document, pointer: "/$defs/Owner" };

    expect(referenceAt(resolution, "/components/schemas/Pet/properties/owner")?.target).toEqual(
      ownerKey,
    );
    expect(resolution.defs.get(keyOf(ownerKey))).toBe(keyOf(ownerKey));
    expect(
      at(resolution, { document: owner.document, pointer: "/$defs/Owner/properties/name" })?.target,
    ).toEqual({ document: owner.document, pointer: "/$defs/Name" });
  });

  test("3.2 resolves against $self, not the retrieval URI, into another member", () => {
    const common = member("common-3.2.json", "https://api.example.com/v1/common.json");
    const resolution = resolved("3.2", fixture("entry-3.2.json", entry), [common]);

    expect(referenceAt(resolution, "/paths/~1pets/get/parameters/0")?.target).toEqual({
      document: common.document,
      pointer: "/components/parameters/Limit",
    });
    expect(
      at(resolution, {
        document: common.document,
        pointer: "/components/parameters/Limit/schema",
      })?.target,
    ).toEqual({ document: common.document, pointer: "/components/schemas/LimitValue" });
  });

  test("3.2 a relative reference that only the retrieval URI would place in the set is outside it", () => {
    const common = member("common-3.2.json", "file:///spec/common.json");
    const diagnostic = refusal("3.2", fixture("entry-3.2.json", entry), [common]);

    expect(diagnostic.code).toBe("REF-15/outside-set");
    expect<string>(diagnostic.pointer).toBe("/paths/~1pets/get/parameters/0");
  });

  test("REF-15 a relative file outside the set is refused with no request", () => {
    const common = member("common-3.0.json", "file:///spec/common.json");
    const diagnostic = refusal("3.0", spec("3.0", usesParameter("missing.json#/P")), [common]);

    expect(diagnostic.code).toBe("REF-15/outside-set");
    expect(diagnostic.scope).toBe("document");
    expect<string>(diagnostic.pointer).toBe(parameterAt);
  });

  test("REF-16 an absolute URI outside the set is refused with no request", () => {
    const common = member("common-3.0.json", "file:///spec/common.json");
    const diagnostic = refusal(
      "3.0",
      spec("3.0", usesParameter("https://elsewhere.example.com/common.json#/parameters/Limit")),
      [common],
    );

    expect(diagnostic.code).toBe("REF-16/outside-set");
    expect<string>(diagnostic.pointer).toBe(parameterAt);
  });

  test("a missing target inside a member names the member in related and in its pointer key", () => {
    const common = member("common-3.0.json", "file:///spec/common.json");
    const diagnostic = refusal(
      "3.0",
      spec("3.0", usesParameter("common.json#/parameters/Absent")),
      [common],
    );

    expect(diagnostic.code).toBe("REF-18/unresolvable");
    expect<readonly { document: string; pointer: string }[] | undefined>(
      diagnostic.related,
    ).toEqual([{ document: common.document, pointer: "/parameters/Absent" }]);
  });

  test("a refusal found inside a member names that member", () => {
    const broken = { document: uri("file:///spec/broken.json"), value: { P: { $ref: "#/Q" } } };
    const diagnostic = refusal("3.1", spec("3.1", usesParameter("broken.json#/P")), [broken]);

    expect(diagnostic.code).toBe("REF-18/unresolvable");
    expect<string>(diagnostic.pointer).toBe(parameterAt);
    expect<readonly { document: string; pointer: string }[] | undefined>(
      diagnostic.related,
    ).toEqual([{ document: broken.document, pointer: "/Q" }]);
  });

  test("with a set of one, the entry resolves as before and documents holds the entry", () => {
    const value = spec("3.1", {
      ...usesParameter("#/components/parameters/P"),
      components: { parameters: { P: { in: "query", name: "p" } } },
    });
    const resolution = resolved("3.1", value, []);

    expect(referenceAt(resolution, parameterAt)?.target).toEqual({
      document: entry,
      pointer: "/components/parameters/P",
    });
    expect([...resolution.documents.keys()]).toEqual([entry]);
  });

  test("REF-14 a member whose $self names another document of the set is refused", () => {
    const twin = {
      document: uri("https://api.example.com/v1/twin.json"),
      line: "3.2" as const,
      value: spec("3.2", { $self: "file:///spec/openapi.json" }),
    };
    const diagnostic = refusal("3.2", spec("3.2", {}), [twin]);

    expect(diagnostic.code).toBe("REF-14/duplicate-id");
    expect(diagnostic.document).toBe(twin.document);
  });
});

describe("implicit connections across the document set", () => {
  test("a security scheme name defined only in a non-entry member is not found", () => {
    const common = member("common-3.2.json", "https://api.example.com/v1/common.json");
    const resolution = resolved("3.2", fixture("entry-3.2.json", entry), [common]);

    expect(Option.isNone(implicitComponent(resolution, "securitySchemes", "MemberKey"))).toBe(true);
  });

  test("an operationId found only in a member is not recorded", () => {
    const paths = {
      document: uri("file:///spec/paths.json"),
      value: { Item: { get: { operationId: "inMember", responses: {} } } },
    };
    const resolution = resolved(
      "3.1",
      spec("3.1", { paths: { "/a": { $ref: "paths.json#/Item" } } }),
      [paths],
    );

    expect(referenceAt(resolution, "/paths/~1a")?.target.document).toBe(paths.document);
    expect(resolution.operationIds.has("inMember")).toBe(false);
  });
});

describe("budgets span the document set", () => {
  const a = uri("file:///spec/a.json");
  const b = uri("file:///spec/b.json");

  test("a non-schema reference cycle across two documents is a document refusal", () => {
    const value = spec("3.1", {
      ...usesParameter("b.json#/P"),
      components: { parameters: { P: { $ref: "b.json#/P" } } },
    });
    const other = { document: b, value: { P: { $ref: "openapi.json#/components/parameters/P" } } };
    const diagnostic = refusal("3.1", value, [other]);

    expect(diagnostic.code).toBe("DOC-23/non-schema-cycle");
    expect(diagnostic.scope).toBe("document");
  });

  test("REF-18 a chain alternating between documents counts every hop", () => {
    const hops = 8;
    const link = (index: number, here: Document): Json =>
      index === hops
        ? { in: "query", name: "p" }
        : { $ref: `${here === a ? b : a}#/P${index + 1}` };
    const doc = (here: Document) =>
      Object.fromEntries(
        Array.from({ length: hops + 1 }, (_, index) => [`P${index}`, link(index, here)]),
      );
    const members = [
      { document: a, value: doc(a) },
      { document: b, value: doc(b) },
    ];
    const value = spec("3.1", usesParameter("a.json#/P0"));

    expect(referenceAt(resolved("3.1", value, members), parameterAt)?.via).toHaveLength(hops);
    expect(refusal("3.1", value, members, { maxHops: hops }).code).toBe("REF-18/hop-limit");
  });

  test("a schema cycle across two documents resolves; the node budget counts both", () => {
    const levels = 2000;
    const schemas = (here: Document) =>
      Object.fromEntries(
        Array.from({ length: levels }, (_, index) => [
          `S${index}`,
          {
            allOf: [
              { $ref: `${here === a ? b : a}#/S${(index + 1) % levels}` },
              { $ref: `${here === a ? b : a}#/S${(index + 1) % levels}` },
            ],
          },
        ]),
      );
    const members = [
      { document: a, value: schemas(a) },
      { document: b, value: schemas(b) },
    ];
    const value = spec("3.1", { components: { schemas: { Root: { $ref: "a.json#/S0" } } } });
    const resolution = resolved("3.1", value, members);

    expect(resolution.defs.get(keyOf({ document: b, pointer: "/S1" }))).toBe(`${b}#/S1`);
    expect(resolution.defs.get(keyOf({ document: a, pointer: "/S0" }))).toBe(`${a}#/S0`);
    expect(refusal("3.1", value, members, { maxNodes: levels }).code).toBe("REF-18/node-budget");
  });
});

const usesSchema = (ref: string) => ({ components: { schemas: { Root: { $ref: ref } } } });

describe("every member's $id and $anchor is indexed before a reference is judged (B10)", () => {
  const unreached = uri("https://example.com/unreached.json");
  const rootAt = { document: entry, pointer: "/components/schemas/Root" };

  test("DOC-17 a $ref to a $id declared in a member no reference reaches resolves", () => {
    const fragment = { $defs: { Pet: { $id: "https://example.com/schemas/pet", type: "object" } } };
    const members = [{ document: unreached, value: fragment }];
    const resolution = resolved(
      "3.1",
      spec("3.1", usesSchema("https://example.com/schemas/pet")),
      members,
    );

    expect(at(resolution, rootAt)?.target).toEqual({ document: unreached, pointer: "/$defs/Pet" });
  });

  test("REF-14 a $ref to a $id in another supplied OpenAPI document's components resolves", () => {
    const other = spec("3.2", {
      components: { schemas: { Pet: { $id: "https://example.com/schemas/pet", type: "object" } } },
    });
    const members = [{ document: unreached, line: "3.2" as const, value: other }];
    const resolution = resolved(
      "3.2",
      spec("3.2", usesSchema("https://example.com/schemas/pet")),
      members,
    );

    expect(at(resolution, rootAt)?.target).toEqual({
      document: unreached,
      pointer: "/components/schemas/Pet",
    });
  });

  test("a $ref to an $anchor under a member's root $id resolves", () => {
    const fragment = { $defs: { Pet: { $anchor: "pet" } }, $id: "https://example.com/s.json" };
    const members = [{ document: unreached, value: fragment }];
    const resolution = resolved(
      "3.1",
      spec("3.1", usesSchema("https://example.com/s.json#pet")),
      members,
    );

    expect(at(resolution, rootAt)?.target).toEqual({ document: unreached, pointer: "/$defs/Pet" });
  });

  test("REF-14 a $id declared in the entry and again in an unreached member is refused", () => {
    const pet = { $id: "https://example.com/schemas/pet", type: "object" };
    const members = [{ document: unreached, value: { $defs: { Pet: pet } } }];
    const diagnostic = refusal(
      "3.1",
      spec("3.1", { components: { schemas: { Pet: pet } } }),
      members,
    );

    expect(diagnostic.code).toBe("REF-14/duplicate-id");
    expect<readonly string[]>([diagnostic.document, diagnostic.pointer]).toEqual([
      unreached,
      "/$defs/Pet",
    ]);
  });

  test("REF-18 the node budget counts an unreached member's nodes", () => {
    const wide = { $defs: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`S${i}`, {}])) };
    const members = [{ document: unreached, value: wide }];
    const value = spec("3.1", {});

    expect(resolved("3.1", value, members, { maxNodes: 60 }).diagnostics).toEqual([]);
    expect(refusal("3.1", value, members, { maxNodes: 40 }).code).toBe("REF-18/node-budget");
  });
});
