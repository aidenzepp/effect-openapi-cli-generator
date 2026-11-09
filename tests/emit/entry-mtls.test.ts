import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { emitEntryFiles } from "../../src/emit/entry.ts";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { SecurityScheme } from "../../src/model/entities.ts";
import { maxCertificateBytes } from "../../src/runtime-src/runtime/auth.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

const root = nodePath.resolve(import.meta.dir, "../..");

const vp = nodePath.resolve(root, "node_modules/.bin/vp");

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const fmtTimeout = 30_000;

const config = Schema.decodeUnknownSync(AuthorConfig)({
  binName: "example-cli",
  package: { name: "example-cli", version: "1.2.3" },
});

const scheme = (name: string, kind: (typeof SecurityScheme.Encoded)["kind"]) =>
  Schema.decodeUnknownSync(SecurityScheme)({
    credentialSources: [],
    deprecated: false,
    kind,
    name,
    origin: { document: "file:///spec.json", pointer: `/components/securitySchemes/${name}` },
    rows: [],
    source: "spec",
  });

const bearer = scheme("bearerAuth", { scheme: "bearer", type: "http" });

const apiKey = scheme("apiKey", { in: "header", name: "X-Key", type: "apiKey" });

const client = scheme("client", { type: "mutualTls" });

const contentOf = (schemes: readonly SecurityScheme[], path: string): string => {
  const files = Effect.runSync(emitEntryFiles(config, schemes));
  const file = files.find((candidate) => candidate.path === path);
  expect(file).toBeDefined();

  return file?.content ?? "";
};

// `vp fmt --stdin-filepath` runs the formatter `vp fmt --check` runs: output equal to input passes.
const formatted = (path: string, text: string) =>
  decoder.decode(
    Bun.spawnSync([vp, "fmt", `--stdin-filepath=${path}`], {
      cwd: root,
      stdin: encoder.encode(text),
    }).stdout,
  );

const closers = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);

const quotes = new Set(['"', "'", "`"]);

// The index just past the string literal or bracket group that starts at `at`.
const skip = (text: string, at: number): number => {
  const first = text.charAt(at);
  if (quotes.has(first)) {
    let index = at + 1;
    while (index < text.length && text.charAt(index) !== first) {
      index += text.charAt(index) === "\\" ? 2 : 1;
    }

    return index + 1;
  }

  const close = closers.get(first);
  if (close === undefined) {
    return at + 1;
  }

  let index = at + 1;
  while (index < text.length && text.charAt(index) !== close) {
    index = skip(text, index);
  }

  return index + 1;
};

// Splits `text` at the commas outside any bracket group or string literal.
const topLevel = (text: string): readonly string[] => {
  const parts: string[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    if (text.charAt(index) === ",") {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }

    index = skip(text, index);
  }

  parts.push(text.slice(start).trim());

  return parts.filter((part) => part !== "");
};

// The parsed `BunHttpClient.layerOptions(...)` call: its argument count and the top-level keys
// of its one object-literal argument.
const layerOptionsCall = (bin: string) => {
  const head = "BunHttpClient.layerOptions(";
  const at = bin.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  expect(bin.indexOf(head, at + 1)).toBe(-1);

  const open = at + head.length - 1;
  const end = skip(bin, open);
  expect(bin.charAt(end - 1)).toBe(")");

  const args = topLevel(bin.slice(open + 1, end - 1));
  const [options = ""] = args;
  expect(options.startsWith("{") && options.endsWith("}")).toBe(true);

  const keys = topLevel(options.slice(1, -1)).map((entry) => entry.split(":")[0]?.trim() ?? "");

  return { args, keys };
};

describe("emitEntryFiles with a mutualTLS scheme", () => {
  test("bin.ts reads the certificate paths from Config and provides ClientCertificate", () => {
    const bin = contentOf([bearer, client], "src/bin.ts");
    expect(bin).toContain('import * as Auth from "./runtime/auth.ts";');
    expect(bin).toContain('import { security } from "./api/security.ts";');
    expect(bin).toContain("Auth.clientCertificatePaths(scheme)");
    expect(bin).toContain("Layer.effect(\n  Auth.ClientCertificate,");
    expect(bin).toContain("Effect.forEach(Object.values(security.schemes), (scheme) =>");
    expect(bin).toContain('Match.when({ kind: "mutualTLS" }, certificateInit)');
  });

  test("each configured path is a regular file read through FileSystem within the bound", () => {
    const bin = contentOf([client], "src/bin.ts");
    expect(bin).toContain("fs.stat(path)");
    expect(bin).toContain('Match.when({ type: "File" }');
    expect(bin).toContain("Stream.limitBytes(Auth.maxCertificateBytes");
    expect(bin).toContain("Stream.mkUint8Array");
    expect(bin).not.toContain("Effect.as(Bun.file(path))");
    expect(bin).not.toContain("fs.access");
    expect(bin).toContain("new UsageError({ message");
    for (const named of [
      "certificateFile(scheme.caEnv, ca)",
      "certificateFile(scheme.certEnv, configured.cert)",
      "certificateFile(scheme.keyEnv, configured.key)",
    ]) {
      expect(bin).toContain(named);
    }
  });

  test("the request init is { tls } with the CA only when configured", () => {
    const bin = contentOf([client], "src/bin.ts");
    expect(bin).toContain("(files): BunFetchRequestInit => ({");
    expect(bin).toContain("tls: Option.match(files.ca, {");
    expect(bin).toContain("onNone: () => ({ cert: files.cert, key: files.key }),");
    expect(bin).toContain("onSome: (ca) => ({ ca: ca, cert: files.cert, key: files.key }),");
  });

  test("an unreadable path renders through the final catch before the run", () => {
    const bin = contentOf([client], "src/bin.ts");
    // A pre-run error follows the parse-time rule: it reads `<PREFIX>_ERROR_FORMAT` (design 7.4).
    expect(bin).toContain('Output.finalCatch([], { envPrefix: "EXAMPLE_CLI" })');
    expect(bin).not.toContain("Output.finalCatch([])");
    expect(bin).toContain(
      "Layer.provide(Layer.mergeAll(BunServices.layer, Redact.runCredentialsLayer))",
    );
    expect(bin).toContain("  clientCertificate,\n");
    expect(
      bin.endsWith(
        "BunRuntime.runMain(Effect.provide(run, entry), { disableErrorReporting: true });\n",
      ),
    ).toBe(true);
  });

  test("the Bun client layer never receives a tls key", () => {
    for (const schemes of [[client], [bearer], []]) {
      const call = layerOptionsCall(contentOf(schemes, "src/bin.ts"));
      expect(call.args).toHaveLength(1);
      expect(call.keys).toEqual(["redirect", "timeout"]);
    }
  });

  test("main.ts does not name Bun and is unchanged by the scheme", () => {
    const main = contentOf([client], "src/main.ts");
    expect(main).not.toContain("Bun");
    expect(main).toBe(contentOf([], "src/main.ts"));
  });

  // Not a pinned hash: other features change `bin.ts` too. Without a mutualTLS scheme the schemes
  // leave it as it is with none, and it has no client-certificate part (audit of m3/wi1b, F1).
  test("without a mutualTLS scheme bin.ts is byte-identical to one with no schemes", () => {
    const bin = contentOf([bearer, apiKey], "src/bin.ts");
    expect(bin).toBe(contentOf([], "src/bin.ts"));
    expect(bin).not.toContain("ClientCertificate");
  });

  test(
    "bin.ts with a mutualTLS scheme passes vp fmt --check",
    () => {
      const bin = contentOf([client], "src/bin.ts");
      expect(formatted("src/bin.ts", bin)).toBe(bin);
    },
    fmtTimeout,
  );
});

// A start-up rejection: exit 2 with one error line that names no path, in time.
const rejected = (stderr: string) => ({ exitCode: 2, leaksPath: false, stderr, timedOut: false });

// Through a generated CLI (design 9 I5, M3-MT2; merit HB2): a certificate path that is not a
// regular file, or holds more than `maxCertificateBytes`, is the start-up UsageError naming its
// variable, exit 2, and the request is never attempted. No case uses `/dev/zero`: a regression
// would read it without bound. The FIFO case would hang if the bin opened it, so the timeout
// catches that regression. The valid PEM pair reaching the TLS fixture is tests/generated/mtls.
describe("a generated mutualTLS CLI rejects an unusable certificate file at start-up", () => {
  const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
  const work = mkdtempSync(nodePath.join(tmpdir(), "entry-mtls-"));
  const scope = Effect.runSync(Scope.make());
  const ready = Promise.withResolvers<GeneratedPackage>();
  const pem = nodePath.join(work, "client.pem");
  const directory = nodePath.join(work, "a-directory");
  const fifo = nodePath.join(work, "a-fifo");
  const atBound = nodePath.join(work, "at-bound.pem");
  const overBound = nodePath.join(work, "over-bound.pem");

  beforeAll(async () => {
    const configPath = nodePath.join(work, "author-config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify({ binName: "mtls", envPrefix: "MTLS", package: { name: "mtls-cli", version: "0.1.0" } })}\n`,
    );
    writeFileSync(pem, "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n");
    mkdirSync(directory);
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    // Sparse: the size is set, no bytes are written.
    writeFileSync(atBound, "");
    truncateSync(atBound, maxCertificateBytes);
    writeFileSync(overBound, "");
    truncateSync(overBound, maxCertificateBytes + 1);

    const specPath = nodePath.resolve(root, "tests/fixtures/specs/mtls.json");
    const prepare = Effect.gen(function* prepareGen() {
      const generated = yield* generateFixture({ configPath, specPath });
      yield* preparePackage(generated);

      return generated;
    }).pipe(Scope.provide(scope), Effect.provide(layer));
    ready.resolve(await Effect.runPromise(prepare));
  }, 600_000);

  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(work, { force: true, recursive: true });
  });

  const run = async (env: Record<string, string>) => {
    const generated = await ready.promise;
    const result = await Effect.runPromise(
      runBin(generated, {
        args: ["--base-url", "http://127.0.0.1:9", "--dry-run", "pets", "get", "1"],
        env: { MTLS_CLIENT_CERT: pem, MTLS_CLIENT_KEY: pem, ...env },
        timeoutMs: 30_000,
      }).pipe(Effect.provide(layer)),
    );
    const stderr = decoder.decode(result.stderr);

    return {
      exitCode: result.exitCode,
      leaksPath: [work, ...Object.values(env)].some((value) => stderr.includes(value)),
      stderr: stderr.trim(),
      timedOut: result.timedOut,
    };
  };

  test("a directory named by MTLS_CLIENT_CERT is not a regular file", async () => {
    expect(await run({ MTLS_CLIENT_CERT: directory })).toEqual(
      rejected("Error: the file named by MTLS_CLIENT_CERT is not a regular file"),
    );
  }, 60_000);

  test("a FIFO named by MTLS_CLIENT_KEY is refused without being opened", async () => {
    expect(await run({ MTLS_CLIENT_KEY: fifo })).toEqual(
      rejected("Error: the file named by MTLS_CLIENT_KEY is not a regular file"),
    );
  }, 60_000);

  test("a CA file one byte over the bound is too large", async () => {
    expect(await run({ MTLS_CLIENT_CA: overBound })).toEqual(
      rejected(
        `Error: the file named by MTLS_CLIENT_CA is larger than ${maxCertificateBytes} bytes`,
      ),
    );
  }, 60_000);

  test("a CA file exactly at the bound is read", async () => {
    const observed = await run({ MTLS_CLIENT_CA: atBound });
    expect({ exitCode: observed.exitCode, leaksPath: observed.leaksPath }).toEqual({
      exitCode: 0,
      leaksPath: false,
    });
  }, 60_000);
});
