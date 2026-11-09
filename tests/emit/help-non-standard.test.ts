import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Effect, Schema } from "effect";
import { emitCli } from "../../src/emit/cli.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { Api, Operation, SecurityScheme } from "../../src/model/entities.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { HelpFlag, HelpInput } from "../../src/emit/help.ts";
import { operationHelp } from "../../src/emit/help.ts";

// A directly marked model: the marker is set on the entries, as the author config would set it.

const origin = { document: "file:///spec.json", pointer: "/paths/~1search/post" };

const rows = ["OPR-01"];

const schema = { key: "S" };

const note = "non-standard: sent as name[a][b]=v (author config nonStandard.deepObjectBrackets)";

const parameter = (wireName: string, nonStandard?: "deepObjectBrackets") => {
  const serialization = {
    allowReserved: false,
    explode: true,
    kind: "style",
    objectValued: false,
    origin,
    rows,
    rules: "rfc3986-3.1+",
    style: "deepObject",
  };

  return {
    deprecated: false,
    docs: {},
    location: "query",
    origin,
    required: false,
    rows,
    schema,
    serialization: nonStandard === undefined ? serialization : { ...serialization, nonStandard },
    wireName,
  };
};

const rule = (name: string, nonStandard?: "deepObjectBrackets") => {
  const entry = {
    contentType: [],
    headers: [],
    origin,
    rows,
    target: { kind: "property", name },
  };

  return nonStandard === undefined ? entry : { ...entry, nonStandard };
};

const operationPlain = (marked: boolean) => ({
  body: {
    alternatives: [
      {
        codec: "form",
        encoding: [rule("filter", marked ? "deepObjectBrackets" : undefined), rule("sort")],
        mediaType: "application/x-www-form-urlencoded",
        origin,
        prefixEncoding: [],
        rows,
        schema,
      },
    ],
    docs: {},
    origin,
    required: false,
    rows,
  },
  deprecated: false,
  docs: {},
  key: { method: "POST", path: "/search" },
  origin,
  parameters: [parameter("q", marked ? "deepObjectBrackets" : undefined), parameter("plain")],
  responses: [
    {
      alternatives: [],
      docs: {},
      headers: [],
      key: { code: 200 },
      origin,
      rows,
    },
  ],
  rows,
  security: { alternatives: [], declared: true, origin, rows },
  servers: [],
  tags: [],
});

const inputFor = (marked: boolean, extra: Partial<HelpInput> = {}): HelpInput => {
  const operation = Schema.decodeUnknownSync(Operation)(operationPlain(marked));
  const parameterFlag = (name: string): HelpFlag => {
    const found = operation.parameters.find((candidate) => candidate.wireName === name);
    if (found === undefined) {
      throw new Error(`fixture parameter ${name} is missing`);
    }

    return { name, source: { _tag: "Parameter", negatable: false, parameter: found } };
  };

  return {
    credentials: [],
    diagnostics: [],
    flags: [
      parameterFlag("q"),
      parameterFlag("plain"),
      { name: "filter", source: { _tag: "Body", pointer: "/filter" } },
      { name: "filter.a", source: { _tag: "Body", pointer: "/filter/a" } },
      { name: "sort", source: { _tag: "Body", pointer: "/sort" } },
    ],
    operation,
    schemes: [],
    ...extra,
  };
};

const titles = (help: ReturnType<typeof operationHelp>) => help.sections.map(([title]) => title);

describe("help marks non-standard flags", () => {
  test("a marked parameter and body property carry the note, unmarked siblings do not", () => {
    const help = operationHelp(inputFor(true));

    expect(help.flags).toEqual({
      filter: `body /filter; ${note}`,
      "filter.a": `body /filter/a; ${note}`,
      plain: "query plain",
      q: `query q; ${note}`,
      sort: "body /sort",
    });
  });

  test("the command carries one NON-STANDARD line naming the marked flags", () => {
    const help = operationHelp(inputFor(true));

    // Every command has an AUTH line; `security: []` reads "no authentication".
    expect(titles(help)).toEqual(["REQUEST", "AUTH", "RESPONSES", "NON-STANDARD"]);
    expect(help.sections[1]?.[1]).toBe("no authentication");
    expect(help.sections.at(-1)?.[1]).toBe("--q, --filter, --filter.a (deepObjectBrackets)");
  });

  test("an unmarked command renders the unmarked text", () => {
    const help = operationHelp(inputFor(false));

    expect(titles(help)).toEqual(["REQUEST", "AUTH", "RESPONSES"]);
    expect(help.flags).toEqual({
      filter: "body /filter",
      "filter.a": "body /filter/a",
      plain: "query plain",
      q: "query q",
      sort: "body /sort",
    });
  });

  test("a deprecated scheme keeps its marker in the AUTH line", () => {
    const scheme = Schema.decodeUnknownSync(SecurityScheme)({
      credentialSources: ["flag"],
      deprecated: true,
      kind: { scheme: "bearer", type: "http" },
      name: "bearerAuth",
      origin,
      rows,
      source: "spec",
    });
    const base = inputFor(false);
    const operation = Schema.decodeUnknownSync(Operation)({
      ...operationPlain(false),
      security: {
        alternatives: [{ uses: [{ scheme: "bearerAuth", scopes: [] }] }],
        declared: true,
        origin,
        rows,
      },
    });
    const help = operationHelp({ ...base, operation, schemes: [scheme] });
    const auth = help.sections.find(([title]) => title === "AUTH")?.[1];

    expect(auth).toBe("bearerAuth (http bearer) [deprecated]");
  });
});

// A 3.2 `querystring` parameter whose form content carries Encoding rules: the marker sits on a
// rule, not on the serialization, and still marks the flag (design 6.1, D-OQ1).
const querystringOperation = (marked: boolean) => {
  const { body: _body, ...bodiless } = operationPlain(false);

  return {
    ...bodiless,
    parameters: [
      {
        deprecated: false,
        docs: {},
        location: "querystring",
        origin,
        required: false,
        rows,
        schema,
        serialization: {
          encoding: [rule("filter", marked ? "deepObjectBrackets" : undefined), rule("sort")],
          kind: "content",
          mediaType: "application/x-www-form-urlencoded",
          origin,
          rows,
          rules: "rfc3986-3.1+",
          schema,
        },
        wireName: "qs",
      },
    ],
  };
};

const querystringHelp = (marked: boolean) => {
  const operation = Schema.decodeUnknownSync(Operation)(querystringOperation(marked));
  const [qs] = operation.parameters;
  if (qs === undefined) {
    throw new Error("fixture parameter qs is missing");
  }

  return operationHelp({
    credentials: [],
    diagnostics: [],
    flags: [{ name: "qs", source: { _tag: "Parameter", negatable: false, parameter: qs } }],
    operation,
    schemes: [],
  });
};

describe("help marks a querystring parameter by its form Encoding rules", () => {
  test("a bracket-marked Encoding rule marks the flag and adds the NON-STANDARD line", () => {
    const help = querystringHelp(true);

    expect(help.flags).toEqual({ qs: `querystring qs; ${note}` });
    expect(titles(help)).toEqual(["REQUEST", "AUTH", "RESPONSES", "NON-STANDARD"]);
    expect(help.sections.at(-1)?.[1]).toBe("--qs (deepObjectBrackets)");
  });

  test("unmarked Encoding rules leave the flag and the sections unmarked", () => {
    const help = querystringHelp(false);

    expect(help.flags).toEqual({ qs: "querystring qs" });
    expect(titles(help)).toEqual(["REQUEST", "AUTH", "RESPONSES"]);
  });
});

// The scalar switch (design 6.1 Scalar switch): its marker sits beside the bracket marker, and a
// flag marked by both carries both notes.
const scalarNote =
  "non-standard: a scalar value is sent as name=value (author config nonStandard.deepObjectScalars)";

const scalars = { nonStandardScalars: "deepObjectScalars" } as const;

const bothMarks = { nonStandard: "deepObjectBrackets", ...scalars } as const;

const scalarOperation = () => {
  const plain = operationPlain(false);
  const [alternative] = plain.body.alternatives;
  const [q, other] = plain.parameters;

  return {
    ...plain,
    body: {
      ...plain.body,
      alternatives: [
        {
          ...alternative,
          encoding: [
            { ...rule("filter"), ...scalars },
            { ...rule("both"), ...bothMarks },
            rule("sort"),
          ],
        },
      ],
    },
    parameters: [{ ...q, serialization: { ...q?.serialization, ...scalars } }, other],
  };
};

const scalarHelp = () => {
  const operation = Schema.decodeUnknownSync(Operation)(scalarOperation());
  const parameterFlag = (name: string): HelpFlag => {
    const found = operation.parameters.find((candidate) => candidate.wireName === name);
    if (found === undefined) {
      throw new Error(`fixture parameter ${name} is missing`);
    }

    return { name, source: { _tag: "Parameter", negatable: false, parameter: found } };
  };

  return operationHelp({
    credentials: [],
    diagnostics: [],
    flags: [
      parameterFlag("q"),
      parameterFlag("plain"),
      { name: "filter", source: { _tag: "Body", pointer: "/filter" } },
      { name: "both", source: { _tag: "Body", pointer: "/both" } },
      { name: "sort", source: { _tag: "Body", pointer: "/sort" } },
    ],
    operation,
    schemes: [],
  });
};

describe("help marks the scalar switch's flags", () => {
  test("a scalar-marked flag carries the scalar note, a doubly marked one carries both", () => {
    expect(scalarHelp().flags).toEqual({
      both: `body /both; ${note}; ${scalarNote}`,
      filter: `body /filter; ${scalarNote}`,
      plain: "query plain",
      q: `query q; ${scalarNote}`,
      sort: "body /sort",
    });
  });

  test("the NON-STANDARD line names each choice beside its flags", () => {
    const help = scalarHelp();

    expect(titles(help)).toEqual(["REQUEST", "AUTH", "RESPONSES", "NON-STANDARD"]);
    expect(help.sections.at(-1)?.[1]).toBe(
      "--both (deepObjectBrackets); --q, --filter, --both (deepObjectScalars)",
    );
  });
});

const fixture = nodePath.resolve(import.meta.dir, "../fixtures/golden/users-update");

const readJson = (relative: string) =>
  Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
    JSON.parse(nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8")),
  );

describe("the emitted help of a deprecated scheme", () => {
  test("the generated command's AUTH line carries the deprecated marker", async () => {
    const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///golden/config.json");
    const document = Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json");
    const output = await Effect.runPromise(
      Effect.gen(function* generate() {
        const config = yield* decodeAuthorConfig(readJson("author-config.json"), {
          document: configDocument,
        });
        const resolution = yield* resolve({
          document,
          line: "3.1",
          value: readJson("openapi.json"),
        });
        const { api } = yield* normalize(resolution, { checkFindings: [], config, configDocument });
        const deprecated = Schema.decodeUnknownSync(Api)({
          ...Schema.encodeSync(Api)(api),
          securitySchemes: api.securitySchemes.map((scheme) => ({
            ...Schema.encodeSync(SecurityScheme)(scheme),
            deprecated: true,
          })),
        });
        const plan = yield* planNames(deprecated, { config, configDocument, strict: false });

        return yield* emitCli({ api: deprecated, config, plan, validationEdits: [] });
      }),
    );
    const users = output.files.find((file) => file.path === "src/cli/users.ts")?.content ?? "";

    expect(users).toContain("bearerAuth (http bearer) [deprecated]: --bearer-auth-file");
  });
});
