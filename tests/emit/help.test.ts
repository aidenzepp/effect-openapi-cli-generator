import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Schema } from "effect";
import hostileSeeds from "../fixtures/seeds/hostile.json" with { type: "json" };
import { SafeText } from "../../src/model/brands.ts";
import { Diagnostic } from "../../src/model/diagnostic.ts";
import { Operation, SecurityScheme } from "../../src/model/entities.ts";
import type { HelpInput } from "../../src/emit/help.ts";
import { operationHelp, sanitizeProse } from "../../src/emit/help.ts";

const root = nodePath.resolve(import.meta.dir, "../..");

const golden = nodeFs.readFileSync(
  nodePath.join(root, "tests/fixtures/golden/users-update/expected/help.txt"),
  "utf-8",
);

const isSafe = Schema.is(SafeText);

const isString = Schema.is(Schema.String);

const hasUnits = Schema.is(Schema.Struct({ codeUnits: Schema.Array(Schema.Number) }));

const origin = { document: "file:///spec.json", pointer: "/paths/~1users~1{id}/patch" };

const rows = ["OPR-01"];

const schema = { key: "S" };

const serialization = (style: string) => ({
  allowReserved: false,
  explode: false,
  kind: "style",
  origin,
  rows,
  rules: "rfc3986-3.1+",
  style,
});

const parameter = (
  wireName: string,
  location: string,
  style: string,
  docs: Record<string, string> = {},
) => ({
  deprecated: false,
  docs,
  location,
  origin,
  required: location === "path",
  rows,
  schema,
  serialization: serialization(style),
  wireName,
});

const media = (mediaType: string) => ({
  codec: "json",
  encoding: [],
  mediaType,
  origin,
  prefixEncoding: [],
  rows,
  schema,
});

const response = (key: Schema.Json, types: readonly string[]) => ({
  alternatives: types.map(media),
  docs: {},
  headers: [],
  key,
  origin,
  rows,
});

const schemePlain = {
  credentialSources: ["flag", "env"],
  deprecated: false,
  kind: { scheme: "bearer", type: "http" },
  name: "bearerAuth",
  origin,
  rows,
};

const scheme = Schema.decodeUnknownSync(SecurityScheme)(schemePlain);

const operationPlain = {
  body: {
    alternatives: [media("application/json")],
    docs: {},
    origin,
    required: true,
    rows,
  },
  deprecated: false,
  docs: { description: "Update a user." },
  key: { method: "PATCH", path: "/users/{id}" },
  operationId: "users-update",
  origin,
  parameters: [
    parameter("id", "path", "simple", { description: "User id." }),
    parameter("notify", "query", "form", { description: "Send a notification email." }),
    parameter("If-Match", "header", "simple"),
  ],
  responses: [
    response({ code: 200 }, ["application/json"]),
    response({ code: 404 }, []),
    response("default", ["application/json"]),
  ],
  rows,
  security: {
    alternatives: [{ uses: [{ scheme: "bearerAuth", scopes: [] }] }],
    declared: true,
    origin,
    rows,
  },
  servers: [],
};

const operation = Schema.decodeUnknownSync(Operation)(operationPlain);

const parameterOf = (name: string) => {
  const found = operation.parameters.find((candidate) => candidate.wireName === name);
  if (found === undefined) {
    throw new Error(`fixture parameter ${name} is missing`);
  }

  return found;
};

const input: HelpInput = {
  credentials: [{ env: "EXAMPLE_BEARER_AUTH", flag: "bearer-auth-file", scheme: "bearerAuth" }],
  diagnostics: [],
  flags: [
    { name: "id", source: { _tag: "Parameter", negatable: false, parameter: parameterOf("id") } },
    { name: "address.city", source: { _tag: "Body", pointer: "/address/city" } },
    {
      name: "if-match",
      source: { _tag: "Parameter", negatable: false, parameter: parameterOf("If-Match") },
    },
    { name: "name", source: { _tag: "Body", pointer: "/name" } },
    {
      name: "notify",
      source: { _tag: "Parameter", negatable: true, parameter: parameterOf("notify") },
    },
  ],
  operation,
  schemes: [scheme],
};

// The golden file's generated lines, read back from the fixture: the notes column and the three
// section lines.
const goldenSection = (name: string): string => {
  const line = golden.split("\n").find((candidate) => candidate.startsWith(`${name} `));
  if (line === undefined) {
    throw new Error(`golden help.txt has no ${name} line`);
  }

  return line.slice(name.length).trim();
};

const goldenNote = (label: string): string => {
  const line = golden
    .split("\n")
    .find((candidate) => candidate.trimStart().startsWith(`${label} `));
  const note = line?.match(/\((?<note>[^)]*)\)\s*$/u)?.groups?.note;
  if (note === undefined) {
    throw new Error(`golden help.txt has no note for ${label}`);
  }

  return note;
};

const sectionText = (help: ReturnType<typeof operationHelp>, name: string) =>
  help.sections.find(([title]) => title === name)?.[1];

describe("sanitizeProse", () => {
  test("removes ANSI escapes and controls but keeps LF, TAB and printable text", () => {
    const text = sanitizeProse(
      "a\u001B[31mred\u001B[0m\r\nb\tc\u0000\u007F\u0085 caf\u00E9 \uD83D\uDE00",
    );

    expect<string>(text).toBe("a[31mred[0m\nb\tc café 😀");
    expect(isSafe(text)).toBe(true);
  });

  test("removes format characters, line and paragraph separators and lone surrogates", () => {
    const text = sanitizeProse("a\u200Bb\u202Ec\u2028d\u2029e\uD800f\uDC00g");

    expect<string>(text).toBe("abcdefg");
  });

  test("keeps a fake section header as plain prose inside the description", () => {
    const text = sanitizeProse("Real.\nREQUEST   GET /pwned\u001B[2J");

    expect<string>(text).toBe("Real.\nREQUEST   GET /pwned[2J");
    expect(isSafe(text)).toBe(true);
  });

  test("caps the length at whole code points", () => {
    const text = sanitizeProse("😀".repeat(5000));

    // 2000 code points, each a surrogate pair
    expect(text.length).toBe(4000);
    expect(isSafe(text)).toBe(true);
  });

  test("every hostile.json input sanitizes to text that decodes as SafeText", () => {
    const strings = hostileSeeds.cases.flatMap((entry) => {
      const value: unknown = entry.input;
      if (isString(value)) {
        return [value];
      }

      return hasUnits(value) ? [String.fromCodePoint(...value.codeUnits)] : [];
    });

    expect(strings.length).toBeGreaterThan(10);
    for (const raw of strings) {
      expect(isSafe(sanitizeProse(raw))).toBe(true);
    }
  });
});

const withDocs = (docs: Record<string, string>) =>
  operationHelp({
    ...input,
    operation: Schema.decodeUnknownSync(Operation)({ ...operationPlain, docs }),
  }).description;

describe("operationHelp", () => {
  test("description is the source description, else the summary, an empty one staying empty", () => {
    expect<string>(withDocs({ description: "Update a user." })).toBe("Update a user.");
    expect<string>(withDocs({ summary: "Sum." })).toBe("Sum.");
    expect<string>(withDocs({ description: "", summary: "Sum." })).toBe("");
    expect<string>(withDocs({})).toBe("");
  });

  test("an over-long description is capped and still decodes as SafeText", () => {
    const help = operationHelp({
      ...input,
      operation: Schema.decodeUnknownSync(Operation)({
        ...operationPlain,
        docs: { description: "x".repeat(5000) },
      }),
    });

    expect(help.description.length).toBe(2000);
    expect(isSafe(help.description)).toBe(true);
  });

  test("sections for the golden users update operation match expected/help.txt", () => {
    const help = operationHelp(input);

    expect<string>(help.description).toBe("Update a user.");
    expect(sectionText(help, "REQUEST")).toBe(goldenSection("REQUEST"));
    expect(sectionText(help, "AUTH")).toBe(goldenSection("AUTH"));
    expect(sectionText(help, "RESPONSES")).toBe(goldenSection("RESPONSES"));
    expect(help.sections.map(([title]) => title)).toEqual(["REQUEST", "AUTH", "RESPONSES"]);
  });

  test("notes name each argument and flag's wire name and location as expected/help.txt does", () => {
    const help = operationHelp(input);

    expect(help.arguments).toEqual({ id: goldenNote("id") });
    expect(help.flags).toEqual({
      "address.city": goldenNote("--address.city"),
      "if-match": goldenNote("--if-match"),
      name: goldenNote("--name"),
      notify: goldenNote("--notify"),
    });
  });

  test("a parameter wire name carrying a format character is sanitized in its note", () => {
    const weird = Schema.decodeUnknownSync(Operation)({
      ...operationPlain,
      parameters: [parameter("X-\u202ERate", "header", "simple")],
    });
    const [weirdParameter] = weird.parameters;
    if (weirdParameter === undefined) {
      throw new Error("fixture parameter is missing");
    }

    const help = operationHelp({
      ...input,
      flags: [
        {
          name: "x-rate",
          source: { _tag: "Parameter", negatable: false, parameter: weirdParameter },
        },
      ],
      operation: weird,
    });

    expect(help.flags["x-rate"]).toBe("header X-Rate");
  });

  test("a refused cookie parameter is listed by wire name and reason", () => {
    const diagnostic = Schema.decodeUnknownSync(Diagnostic)({
      code: "PRM-12/cookie-unsupported",
      document: origin.document,
      element: "session\u202E",
      message: "Cookie parameters are not supported.",
      openapi: "3.1.0",
      operation: { method: "PATCH", operationId: "users-update", path: "/users/{id}" },
      pointer: origin.pointer,
      row: "PRM-12",
      scope: "element",
      severity: "refusal",
      specSection: "https://spec.openapis.org/oas/v3.1.0#parameter-object",
    });
    const help = operationHelp({ ...input, diagnostics: [diagnostic] });
    const refused = sectionText(help, "REFUSED");

    expect(refused).toBe("session: Cookie parameters are not supported.");
    expect(help.sections.map(([title]) => title)).toEqual([
      "REQUEST",
      "AUTH",
      "RESPONSES",
      "REFUSED",
    ]);
  });

  test("notices and other operations' refusals are not listed", () => {
    const base = {
      code: "PRM-12/cookie-unsupported",
      document: origin.document,
      element: "session",
      message: "No.",
      openapi: "3.1.0",
      pointer: origin.pointer,
      row: "PRM-12",
      scope: "element",
      severity: "refusal",
      specSection: "https://spec.openapis.org/oas/v3.1.0#parameter-object",
    };
    const decode = Schema.decodeUnknownSync(Diagnostic);
    const help = operationHelp({
      ...input,
      diagnostics: [
        decode({ ...base, operation: { method: "GET", path: "/other" } }),
        decode({
          ...base,
          operation: { method: "PATCH", path: "/users/{id}" },
          severity: "notice",
        }),
      ],
    });

    expect(sectionText(help, "REFUSED")).toBeUndefined();
  });

  test("an optional body, no body and an unauthenticated operation shorten the lines", () => {
    const { operationId: _operationId, ...unnamed } = operationPlain;
    const plain = {
      ...unnamed,
      body: { ...operationPlain.body, required: false },
      security: { ...operationPlain.security, alternatives: [] },
    };
    const optional = operationHelp({
      ...input,
      operation: Schema.decodeUnknownSync(Operation)(plain),
    });

    expect(sectionText(optional, "REQUEST")).toBe("PATCH /users/{id}, body application/json");
    expect(sectionText(optional, "AUTH")).toBeUndefined();

    const { body: _body, ...bodiless } = plain;
    const none = operationHelp({
      ...input,
      operation: Schema.decodeUnknownSync(Operation)(bodiless),
    });

    expect(sectionText(none, "REQUEST")).toBe("PATCH /users/{id}");
  });
  test("renders a 50k-name alternative in linear time", () => {
    const count = 50_000;
    const names = Array.from({ length: count }, (_, index) => `scheme${index}`);
    const uses = names.map((name) => ({ scheme: name, scopes: [] }));
    const big = Schema.decodeUnknownSync(Operation)({
      ...operationPlain,
      security: { ...operationPlain.security, alternatives: [{ uses }] },
    });

    const started = performance.now();
    const help = operationHelp({
      ...input,
      credentials: names.map((name) => ({
        env: `ENV_${name}`,
        flag: `${name}-file`,
        scheme: name,
      })),
      operation: big,
      schemes: names.map((name) =>
        Schema.decodeUnknownSync(SecurityScheme)({ ...schemePlain, name }),
      ),
    });
    const elapsed = performance.now() - started;

    expect(sectionText(help, "AUTH")?.startsWith("scheme0 (http bearer): --scheme0-file")).toBe(
      true,
    );
    expect(elapsed).toBeLessThan(1000);
  }, 10_000);
});
