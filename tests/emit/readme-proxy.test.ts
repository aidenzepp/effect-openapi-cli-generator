import { describe, expect, test } from "bun:test";
import nodePath from "node:path";
import { Effect, Schema } from "effect";
import { emitReadme } from "../../src/emit/readme.ts";
import type { ReadmeInput } from "../../src/emit/readme.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { planNames } from "../../src/names/index.ts";
import { envPrefixOf } from "../../src/names/plan.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";

// The README's Proxies section (design 6.5 Proxy environment and Loopback hosts, D-SEC8, operator
// ruling 71514c79): emitted for every package, it names the platform's proxy variables, the
// loopback hosts that always go direct and the untested cases. Names and tokens, never the prose.

const vp = nodePath.join(nodePath.resolve(import.meta.dir, "../.."), "node_modules/.bin/vp");

const formatted = (text: string): string =>
  new TextDecoder().decode(
    Bun.spawnSync([vp, "fmt", "--stdin-filepath=README.md"], {
      stdin: new TextEncoder().encode(text),
    }).stdout,
  );

const document = Schema.decodeUnknownSync(DocumentUri)("file:///readme/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///readme/author-config.json");

const ok = { "200": { description: "ok" } };

const withCredentials: Schema.Json = {
  components: { securitySchemes: { bearerAuth: { scheme: "bearer", type: "http" } } },
  info: { title: "Secured", version: "1.0.0" },
  openapi: "3.1.0",
  paths: {
    "/things": {
      get: { operationId: "things-list", responses: ok, security: [{ bearerAuth: [] }] },
    },
  },
  servers: [{ url: "https://api.acme.example" }],
};

const withoutCredentials: Schema.Json = {
  info: { title: "Open", version: "1.0.0" },
  openapi: "3.1.0",
  paths: { "/things": { get: { operationId: "things-list", responses: ok } } },
  servers: [{ url: "https://api.acme.example" }],
};

const config = {
  binName: "acme-pay",
  package: { name: "acme-pay", version: "1.0.0" },
  servers: { accepted: ["https://api.acme.example"] },
};

const input = (value: Schema.Json): Promise<ReadmeInput> =>
  Effect.runPromise(
    Effect.gen(function* prepare() {
      const authorConfig = yield* decodeAuthorConfig(config, { document: configDocument });
      const resolution = yield* resolve({ document, line: "3.1", value });
      const { api, diagnostics } = yield* normalize(resolution, {
        checkFindings: [],
        config: authorConfig,
        configDocument,
      });
      const plan = yield* planNames(api, {
        config: authorConfig,
        configDocument,
        strict: false,
      });

      return {
        api,
        config: authorConfig,
        diagnostics: [...diagnostics, ...plan.diagnostics],
        plan,
      };
    }),
  );

// The text from `## Proxies` to the next second-level heading.
const proxies = (text: string): string => {
  const start = text.indexOf("\n## Proxies\n");
  if (start === -1) {
    return "";
  }

  const next = text.indexOf("\n## ", start + 1);

  return next === -1 ? text.slice(start) : text.slice(start, next);
};

const bullets = (text: string): readonly string[] =>
  text.split("\n").filter((line) => line.startsWith("- "));

const variables = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "all_proxy",
  "no_proxy",
  "NO_PROXY",
];

const loopbackHosts = ["`127.0.0.0/8`", "`::1`", "`localhost`", "`.localhost`"];

const cases = [
  { name: "a spec with credentials", spec: withCredentials },
  { name: "a spec without credentials", spec: withoutCredentials },
];

describe("emitReadme, Proxies section", () => {
  for (const { name, spec } of cases) {
    test(`${name} has the section with every proxy variable, unprefixed`, async () => {
      const base = await input(spec);
      const section = proxies(emitReadme(base).content);
      const prefix = envPrefixOf(base.config);

      expect(section).not.toBe("");
      for (const variable of variables) {
        expect(section).toContain(`\`${variable}\``);
        expect(section).not.toContain(`${prefix}_${variable}`);
      }
    });

    test(`${name} states the loopback hosts that always go direct`, async () => {
      const section = proxies(emitReadme(await input(spec)).content);
      const loopback = section
        .split("\n\n")
        .find((paragraph) => paragraph.includes("`127.0.0.0/8`"));

      expect(loopback).toBeDefined();
      for (const host of loopbackHosts) {
        expect(loopback).toContain(host);
      }
      expect(loopback).toContain("`no_proxy`");
      expect(section).toContain("`127.0.0.1`");
    });

    test(`${name} lists the untested cases`, async () => {
      const untested = bullets(proxies(emitReadme(await input(spec)).content));

      expect(untested.length).toBe(4);
      expect(untested.some((line) => line.includes("`https://`"))).toBe(true);
      expect(untested.some((line) => line.includes("SOCKS"))).toBe(true);
      expect(
        untested.some((line) => line.includes("`NO_PROXY`") && line.includes("`host:port`")),
      ).toBe(true);
      expect(
        untested.some((line) => line.includes("`ALL_PROXY`") && line.includes("`all_proxy`")),
      ).toBe(true);
    });
  }

  test("sits after Output and before Exit codes, in the layout vp fmt accepts", async () => {
    const readme = emitReadme(await input(withCredentials)).content;
    const titles = [...readme.matchAll(/^## (?<title>.+)$/gmu)].map(
      (match) => match.groups?.title ?? "",
    );

    expect(titles.indexOf("Proxies")).toBe(titles.indexOf("Output") + 1);
    expect(titles.indexOf("Exit codes")).toBe(titles.indexOf("Proxies") + 1);
    expect(formatted(readme)).toBe(readme);
  });
});
