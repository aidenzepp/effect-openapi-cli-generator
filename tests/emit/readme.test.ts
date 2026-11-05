import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Effect, Schema } from "effect";
import { emitReadme } from "../../src/emit/readme.ts";
import type { ReadmeInput } from "../../src/emit/readme.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
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
    const { api } = yield* normalize(resolution, { config, configDocument });
    const plan = yield* planNames(api, { config, configDocument, strict: false });

    return { api, config, plan };
  });

const input = (value: Schema.Json = spec): Promise<ReadmeInput> =>
  Effect.runPromise(prepared(value).pipe(Effect.map((base) => ({ ...base, refused: [] }))));

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
      String.raw`"${"`".repeat(3)}\nrm\u202e"`,
      '"new-user"',
    ]);
    expect(readme).not.toContain("\u202E");
  });

  test("has no webhook section when the description lists none", async () => {
    expect(section(emitReadme(await input()).content, "Webhooks")).toBe("");
  });

  test("summarizes the refused operations without failing", async () => {
    const base = await input();
    const [first] = base.api.operations;
    expect(first).toBeDefined();

    const refused = first === undefined ? [] : [first.key, first.key];
    const refusals = section(emitReadme({ ...base, refused }).content, "Refusals");

    expect(fenced(refusals)).toEqual([`${first?.key.method} "${first?.key.path}"`]);
  });
});
