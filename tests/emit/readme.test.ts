import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Effect, Schema } from "effect";
import { emitReadme } from "../../src/emit/readme.ts";
import type { ReadmeInput } from "../../src/emit/readme.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { Diagnostic } from "../../src/model/diagnostic.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";

const root = nodePath.resolve(import.meta.dir, "../..");

const fixture = nodePath.join(root, "tests/fixtures/golden/users-update");

const vp = nodePath.join(root, "node_modules/.bin/vp");

const JsonRecord = Schema.Record(Schema.String, Schema.Json);

const decodeRecord = Schema.decodeUnknownSync(JsonRecord);

const read = (relative: string) =>
  decodeRecord(JSON.parse(nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8")));

const spec = read("openapi.json");

const configJson = read("author-config.json");

const document = Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///golden/author-config.json");

const webhook: Schema.Json = { post: { responses: { "200": { description: "ok" } } } };

// A hostile webhook name: a backtick fence, a newline and a bidi override.
const hostile = "```\nrm\u202E";

const prepared = (value: Schema.Json) =>
  Effect.gen(function* prepare() {
    const config = yield* decodeAuthorConfig(configJson, { document: configDocument });
    const resolution = yield* resolve({ document, line: "3.1", value });
    const { api, diagnostics } = yield* normalize(resolution, {
      checkFindings: [],
      config,
      configDocument,
    });
    const plan = yield* planNames(api, { config, configDocument, strict: false });

    return { api, config, diagnostics: [...diagnostics, ...plan.diagnostics], plan };
  });

const input = (value: Schema.Json = spec): Promise<ReadmeInput> =>
  Effect.runPromise(prepared(value));

const withWebhooks = { ...spec, webhooks: { [hostile]: webhook, "new-user": webhook } };

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const formatted = (text: string) =>
  decoder.decode(
    Bun.spawnSync([vp, "fmt", "--stdin-filepath=README.md"], {
      cwd: root,
      stdin: encoder.encode(text),
    }).stdout,
  );

const section = (text: string, heading: string): string => {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start === -1) {
    return "";
  }

  const end = text.indexOf("\n## ", start + 1);

  return end === -1 ? text.slice(start) : text.slice(start, end);
};

const fenced = (text: string): readonly string[] => {
  const match = /\n(?<marks>`{3,})text\n(?<body>[^]*?)\n\k<marks>\n/u.exec(text);

  return match?.groups?.body?.split("\n") ?? [];
};

const refusing = (
  scope: "element" | "operation",
  code: string,
  operation?: { readonly method: string; readonly path: string },
): Diagnostic => {
  const fields = {
    code,
    document: "file:///golden/openapi.json",
    element: "Element",
    message: "Refused.",
    openapi: "3.1.0",
    pointer: "",
    row: code.split("/")[0],
    scope,
    severity: "refusal",
    specSection: "https://spec.openapis.org/oas/v3.1.0",
  };

  return Schema.decodeUnknownSync(Diagnostic)(operation ? { ...fields, operation } : fields);
};

describe("emitReadme", () => {
  test("is README.md in the layout vp fmt accepts", async () => {
    const readme = emitReadme(await input(withWebhooks));

    expect(readme.path).toBe("README.md");
    expect(formatted(readme.content)).toBe(readme.content);
  });

  test("names every planned credential's environment variable and file flag", async () => {
    const base = await input();
    const credentials = section(emitReadme(base).content, "Credentials");

    expect(base.plan.credentials.map((credential) => credential.env)).toEqual([
      "EXAMPLE_BEARER_AUTH",
    ]);
    for (const credential of base.plan.credentials) {
      expect(credentials).toContain(`\`${credential.env}\``);
      expect(credentials).toContain(`\`--${credential.flag} <path|->\``);
    }
  });

  test("lists the generated CLI's exit codes", async () => {
    const exits = section(emitReadme(await input()).content, "Exit codes");
    const codes = [...exits.matchAll(/^- `(?<code>\d+)`/gmu)].map((match) => match.groups?.code);

    expect(codes).toEqual(["0", "1", "2", "3", "4", "5", "70", "130"]);
  });

  test("lists webhooks as informational, in document order, as escaped literals", async () => {
    const readme = emitReadme(await input(withWebhooks)).content;

    expect(fenced(section(readme, "Webhooks"))).toEqual([
      String.raw`"${"`".repeat(3)}\nrm\u202E"`,
      '"new-user"',
    ]);
    expect(readme).not.toContain("\u202E");
  });

  test("has no webhook section when the description lists none", async () => {
    expect(section(emitReadme(await input()).content, "Webhooks")).toBe("");
  });

  test("says nothing was refused only when no stage refused anything", async () => {
    const base = await input();
    const refusals = section(emitReadme(base).content, "Refusals");

    expect(base.diagnostics.filter((diagnostic) => diagnostic.severity === "refusal")).toEqual([]);
    expect(refusals).toContain("Nothing in the description was refused.");
  });

  test("lists an operation refused at normalize, which is absent from the model", async () => {
    const components = Schema.decodeUnknownSync(JsonRecord)(spec.components);
    const schemes = Schema.decodeUnknownSync(JsonRecord)(components.securitySchemes);
    const oauthOnly = {
      ...spec,
      components: {
        ...components,
        securitySchemes: {
          ...schemes,
          oauth: {
            flows: { implicit: { authorizationUrl: "https://example.com/auth", scopes: {} } },
            type: "oauth2",
          },
        },
      },
      paths: {
        ...Schema.decodeUnknownSync(JsonRecord)(spec.paths),
        "/oauth-only": {
          get: { responses: { "200": { description: "ok" } }, security: [{ oauth: [] }] },
        },
      },
    };
    const base = await input(oauthOnly);
    const refusals = section(emitReadme(base).content, "Refusals");

    expect(base.api.operations.map((operation) => operation.key.path)).not.toContain("/oauth-only");
    expect(base.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "SEC-06/no-satisfiable-alternative",
    );
    expect(refusals).not.toContain("Nothing in the description was refused.");
    expect(fenced(refusals)).toEqual(['GET "/oauth-only"']);
  });

  test("lists an operation refused at the plan once, with other stages' refusals", async () => {
    const base = await input();
    const [first] = base.api.operations;
    const operation = { method: first?.key.method ?? "", path: first?.key.path ?? "" };
    const refusal = (scope: "element" | "operation", code: string) =>
      refusing(scope, code, operation);
    const diagnostics = [
      ...base.diagnostics,
      refusal("operation", "NAM-01/plan"),
      refusal("operation", "EMT-01/emit"),
    ];
    const refusals = section(emitReadme({ ...base, diagnostics }).content, "Refusals");

    expect(fenced(refusals)).toEqual([`${operation.method} "${operation.path}"`]);
    expect(refusals).toContain("Generation refused 1 operation,");
    expect(refusals).not.toContain("element");
  });

  test("counts element refusals of commands that still exist, not of refused operations", async () => {
    const base = await input();
    const [first] = base.api.operations;
    const operation = { method: first?.key.method ?? "", path: first?.key.path ?? "" };
    const gone = { method: "GET", path: "/gone" };
    const diagnostics = [
      ...base.diagnostics,
      refusing("element", "OPR-01/one", operation),
      refusing("element", "OPR-02/two"),
      refusing("operation", "OPR-08/gone", gone),
      refusing("element", "OPR-03/three", gone),
    ];
    const refusals = section(emitReadme({ ...base, diagnostics }).content, "Refusals");

    expect(refusals).toContain("Generation refused 2 elements of generated commands;");
    expect(fenced(refusals)).toEqual(['GET "/gone"']);
  });

  test("tells users to write a value that starts with a dash as --flag=-value", async () => {
    const usage = section(emitReadme(await input()).content, "Usage");

    expect(usage).toContain("Write a flag value that starts with `-` as `--flag=-value`");
    expect(usage).toContain("no `-h` or `-v` short form");
  });

  test("publishes the reserved CLI names in the usage section", async () => {
    const usage = section(emitReadme(await input()).content, "Usage");

    for (const name of ["help", "dry-run", "no-dry-run", "log-level", "base-url"]) {
      expect(usage).toContain(`\`${name}\``);
    }
  });
});
