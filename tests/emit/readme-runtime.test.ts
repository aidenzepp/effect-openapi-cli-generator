import { describe, expect, test } from "bun:test";
import nodePath from "node:path";
import { Array as Arr, Effect, Order, Schema } from "effect";
import { emitReadme } from "../../src/emit/readme.ts";
import type { ReadmeInput } from "../../src/emit/readme.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { planNames } from "../../src/names/index.ts";
import { envPrefixOf } from "../../src/names/plan.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";

// The README sections for the Milestone 3 runtime (design 4.6, 6.5, 7.4, D-AD7; ruling X7):
// headings, names and table rows, read from the plan and config, never the prose.

const vp = nodePath.join(nodePath.resolve(import.meta.dir, "../.."), "node_modules/.bin/vp");

const formatted = (text: string): string =>
  new TextDecoder().decode(
    Bun.spawnSync([vp, "fmt", "--stdin-filepath=README.md"], {
      stdin: new TextEncoder().encode(text),
    }).stdout,
  );

const document = Schema.decodeUnknownSync(DocumentUri)("file:///readme/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///readme/author-config.json");

// A hostile title: a backtick fence, a heading on a new line, a bidi override and a BEL.
const hostileTitle = `Pay${"`".repeat(3)}\n## Injected${String.fromCodePoint(0x20_2e, 0x07)}`;

// The characters help sanitizing removes (design 4.6): C0 except LF and TAB, DEL, C1, and the
// bidi embedding, override and isolate controls.
const isUnsafe = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;

  return (
    (code < 0x20 && code !== 0x0a && code !== 0x09) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x20_2a && code <= 0x20_2e) ||
    (code >= 0x20_66 && code <= 0x20_69)
  );
};

const ok = { "200": { description: "ok" } };

const runtimeSpec: Schema.Json = {
  components: {
    securitySchemes: {
      mtls: { type: "mutualTLS" },
      oauth: {
        flows: { clientCredentials: { scopes: {}, tokenUrl: "https://auth.acme.example/token" } },
        type: "oauth2",
      },
      oidc: {
        openIdConnectUrl: "https://auth.acme.example/.well-known/openid-configuration",
        type: "openIdConnect",
      },
    },
  },
  info: { title: hostileTitle, version: "1.0.0" },
  openapi: "3.1.0",
  paths: {
    "/charges": {
      post: {
        operationId: "charges-create",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                properties: {
                  amount: { type: "integer" },
                  pin: { format: "password", type: "string" },
                },
                type: "object",
              },
            },
          },
          required: true,
        },
        responses: ok,
        security: [{ oauth: [] }],
        tags: ["charges"],
      },
    },
    "/events": {
      get: {
        operationId: "events-stream",
        responses: {
          "200": {
            content: { "application/x-ndjson": { schema: { type: "object" } } },
            description: "Events, one per line.",
          },
        },
        security: [{ mtls: [] }, { oidc: [] }],
        tags: ["events"],
      },
    },
  },
  servers: [{ url: "https://api.acme.example" }],
};

const plainSpec: Schema.Json = {
  components: { securitySchemes: { bearerAuth: { scheme: "bearer", type: "http" } } },
  info: { title: "Plain", version: "1.0.0" },
  openapi: "3.1.0",
  paths: {
    "/things": {
      get: { operationId: "things-list", responses: ok, security: [{ bearerAuth: [] }] },
    },
  },
  servers: [{ url: "https://api.acme.example" }],
};

const baseConfig = {
  binName: "acme-pay",
  package: { name: "acme-pay", version: "1.0.0" },
  servers: { accepted: ["https://api.acme.example"] },
};

const input = (value: Schema.Json, configJson: Schema.Json = baseConfig): Promise<ReadmeInput> =>
  Effect.runPromise(
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
    }),
  );

const headings = (text: string): readonly string[] =>
  [...text.matchAll(/^#{2,3} (?<title>.+)$/gmu)].map((match) => match.groups?.title ?? "");

// The text from a heading line to the next heading of the same or a higher level.
const section = (text: string, heading: string): string => {
  const level = /^#+/u.exec(heading)?.[0] ?? "";
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) {
    return "";
  }

  const next = [...text.slice(start + 1).matchAll(/^(?<marks>#+) /gmu)].find(
    (match) => (match.index ?? 0) > 0 && (match.groups?.marks?.length ?? 0) <= level.length,
  );

  return next === undefined ? text.slice(start) : text.slice(start, start + 1 + (next.index ?? 0));
};

const tableRows = (text: string): readonly (readonly string[])[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("| "))
    .slice(2)
    .map((line) =>
      line
        .slice(2, -2)
        .split(" | ")
        .map((cell) => cell.trim()),
    );

const exitCodes = [
  "- `0`: success, including `--help`, `--version`, `--describe` and `--dry-run`.",
  "- `1`: the API answered with an error status.",
  "- `2`: usage: an unknown command or flag, or a value the command refuses.",
  "- `3`: authentication: no configured credential fits, or the server answered 401 or 403.",
  "- `4`: transport: DNS, connect, TLS, timeout, or a refused redirect.",
  "- `5`: response or output handling failed.",
  "- `70`: internal defect.",
  "- `130`: interrupted.",
].join("\n");

const runtimeHeadings = ["How a command runs", "Settings", "Retries", "Timeouts", "Output"];

describe("emitReadme, Milestone 3 runtime sections", () => {
  test("has every runtime section and each scheme-specific section the spec needs", async () => {
    const readme = emitReadme(await input(runtimeSpec)).content;
    const titles = headings(readme);

    for (const title of [
      ...runtimeHeadings,
      "Credentials",
      "OAuth2 and OpenID Connect",
      "Client certificates",
      "Secret fields",
      "Exit codes",
    ]) {
      expect(titles).toContain(title);
    }
  });

  test("is in the layout vp fmt accepts with every section present", async () => {
    const readme = emitReadme(await input(runtimeSpec, { ...baseConfig, runtime: { retries: 4 } }));

    expect(formatted(readme.content)).toBe(readme.content);
  });

  test("omits the scheme-specific sections when the spec has none of them", async () => {
    const titles = headings(emitReadme(await input(plainSpec)).content);

    for (const title of runtimeHeadings) {
      expect(titles).toContain(title);
    }
    for (const title of ["OAuth2 and OpenID Connect", "Client certificates", "Secret fields"]) {
      expect(titles).not.toContain(title);
    }
  });

  test("names the runtime environment variables with the package prefix", async () => {
    const base = await input(runtimeSpec);
    const readme = emitReadme(base).content;
    const prefix = envPrefixOf(base.config);

    expect(prefix).toBe("ACME_PAY");
    for (const suffix of ["BASE_URL", "TIMEOUT", "RETRIES", "IDLE_TIMEOUT", "ERROR_FORMAT"]) {
      expect(readme).toContain(`\`${prefix}_${suffix}\``);
    }
    expect(section(readme, "## Output")).toContain("`--error-format json`");
    expect(section(readme, "## Output")).toContain("retryAfter");
    expect(section(readme, "## Retries")).toContain("`--retry-unsafe`");
  });

  test("lists the mutualTLS certificate environment names, with no file flag", async () => {
    const base = await input(runtimeSpec);
    const certificates = section(emitReadme(base).content, "### Client certificates");

    expect(base.plan.certificates.length).toBe(1);
    for (const certificate of base.plan.certificates) {
      for (const env of [certificate.certEnv, certificate.keyEnv, certificate.caEnv]) {
        expect(env.startsWith(`${envPrefixOf(base.config)}_`)).toBe(true);
        expect(certificates).toContain(`\`${env}\``);
      }
    }
    expect(certificates).not.toContain("-file");
    expect(certificates).toContain("`--allow-credentials-for-base-url`");
  });

  test("lists the oauth2 and openIdConnect token sources and the TTY prompt", async () => {
    const base = await input(runtimeSpec);
    const readme = emitReadme(base).content;
    const tokens = section(readme, "### OAuth2 and OpenID Connect");
    const tokenSchemes = base.plan.credentials.filter((credential) =>
      ["oauth", "oidc"].includes(credential.scheme),
    );

    expect(tokenSchemes.length).toBe(2);
    for (const credential of tokenSchemes) {
      expect(tokens).toContain(`\`${credential.env}\``);
      expect(tokens).toContain(`\`--${credential.flag} <path|->\``);
    }
    expect(section(readme, "## Credentials")).toContain("prompt");
  });

  test("lists each secret field's file flag", async () => {
    const base = await input(runtimeSpec);
    const secrets = section(emitReadme(base).content, "## Secret fields");
    const flags = [...base.plan.root, ...base.plan.groups.flatMap((group) => group.commands)]
      .flatMap((command) => command.flags)
      .filter((flag) => flag.source._tag === "Body" && flag.source.kind === "secret-file")
      .map((flag) => flag.name);

    expect(flags).toEqual(["pin-file"]);
    expect(secrets).toContain("`--pin-file <path|->`");
  });

  test("keeps a hostile info.title out of the README unsanitized", async () => {
    const readme = emitReadme(await input(runtimeSpec)).content;
    const unsafe: string[] = [];
    for (const character of readme) {
      if (isUnsafe(character)) {
        unsafe.push(character);
      }
    }

    expect(unsafe).toEqual([]);
    expect(readme).not.toContain("Injected");
    expect(headings(readme)).not.toContain("Injected");
  });

  test("keeps the exit-code table unchanged", async () => {
    const inputs = await Promise.all([input(runtimeSpec), input(plainSpec)]);

    for (const base of inputs) {
      expect(section(emitReadme(base).content, "## Exit codes")).toBe(
        `\n## Exit codes\n\n${exitCodes}\n\n`,
      );
    }
  });

  test("names the request path's modules in order, through Output.send (X7)", async () => {
    const runs = section(emitReadme(await input(runtimeSpec)).content, "## How a command runs");
    const modules = [
      "`cli/<group>.ts`",
      "`api/<group>.ts`",
      "`runtime/output.ts`",
      "`Output.send`",
      "`runtime/client.ts`",
      "`bin.ts`",
    ];
    const positions = modules.map((name) => runs.indexOf(name));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(Arr.sort(positions, Order.Number)).toEqual(positions);
  });

  test("tabulates the five settings with the package prefix and the author defaults (X7)", async () => {
    const config = { ...baseConfig, runtime: { timeoutSeconds: 60 } };
    const base = await input(runtimeSpec, config);
    const prefix = envPrefixOf(base.config);
    const rows = tableRows(section(emitReadme(base).content, "## Settings"));

    expect(rows.map((row) => [row[0], row[1]])).toEqual([
      ["`--base-url`", `\`${prefix}_BASE_URL\``],
      ["`--timeout`", `\`${prefix}_TIMEOUT\``],
      ["`--retries`", `\`${prefix}_RETRIES\``],
      ["none", `\`${prefix}_IDLE_TIMEOUT\``],
      ["`--error-format`", `\`${prefix}_ERROR_FORMAT\``],
    ]);
    expect(rows.map((row) => row[3])).toEqual(["none", "30", "2", "300", "`text`"]);
    expect(rows[1]?.[2]).toContain("`runtime.timeoutSeconds`");
    expect(rows[1]?.[2]).toContain("60");
    expect(rows[2]?.[2]).toContain("`runtime.retries`");
    expect(rows[2]?.[2]).not.toMatch(/\d/u);
    expect(rows[3]?.[2]).toContain("`runtime.idleTimeoutSeconds`");
    expect(rows[4]?.[2]).toBe("none");
  });
});
