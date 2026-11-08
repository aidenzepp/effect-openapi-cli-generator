import { describe, expect, test } from "bun:test";
import nodePath from "node:path";
import { Effect, Schema } from "effect";
import { emitEntryFiles } from "../../src/emit/entry.ts";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { SecurityScheme } from "../../src/model/entities.ts";

const root = nodePath.resolve(import.meta.dir, "../..");

const vp = nodePath.resolve(root, "node_modules/.bin/vp");

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const fmtTimeout = 30_000;

const config = Schema.decodeUnknownSync(AuthorConfig)({
  binName: "example-cli",
  package: { name: "example-cli", version: "1.2.3" },
});

// The sha256 of `src/bin.ts` as the emitter wrote it before mutualTLS (m3/integration 530690b).
const previousBinSha256 = "465c26bcf4028fc631cc27475bc8cdf3abef75b4f148e1852070a1124a02b489";

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

const contentOf = (schemes: readonly SecurityScheme[] | undefined, path: string): string => {
  const files = Effect.runSync(
    schemes === undefined ? emitEntryFiles(config) : emitEntryFiles(config, schemes),
  );
  const file = files.find((candidate) => candidate.path === path);
  expect(file).toBeDefined();

  return file?.content ?? "";
};

const sha256 = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

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

  test("each configured path is checked readable and read through Bun.file", () => {
    const bin = contentOf([client], "src/bin.ts");
    expect(bin).toContain("fs.access(path, { readable: true })");
    expect(bin).toContain("Effect.as(Bun.file(path))");
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
    expect(bin).toContain("Output.finalCatch([])");
    expect(bin).toContain(
      "Layer.provide(Layer.mergeAll(BunServices.layer, Output.runCredentialsLayer))",
    );
    expect(bin).toContain("  clientCertificate,\n");
    expect(
      bin.endsWith(
        "BunRuntime.runMain(Effect.provide(run, entry), { disableErrorReporting: true });\n",
      ),
    ).toBe(true);
  });

  test("the Bun client layer never receives a tls key", () => {
    for (const schemes of [[client], [bearer], undefined]) {
      const call = layerOptionsCall(contentOf(schemes, "src/bin.ts"));
      expect(call.args).toHaveLength(1);
      expect(call.keys).toEqual(["redirect", "timeout"]);
    }
  });

  test("main.ts does not name Bun and is unchanged by the scheme", () => {
    const main = contentOf([client], "src/main.ts");
    expect(main).not.toContain("Bun");
    expect(main).toBe(contentOf(undefined, "src/main.ts"));
  });

  test("without a mutualTLS scheme bin.ts is byte-identical to before", () => {
    expect(sha256(contentOf(undefined, "src/bin.ts"))).toBe(previousBinSha256);
    expect(sha256(contentOf([], "src/bin.ts"))).toBe(previousBinSha256);
    expect(sha256(contentOf([bearer, apiKey], "src/bin.ts"))).toBe(previousBinSha256);
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
