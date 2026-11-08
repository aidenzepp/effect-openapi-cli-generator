import { describe, expect, test } from "bun:test";
import nodePath from "node:path";
import { Effect, Schema } from "effect";
import { emitEntryFiles } from "../../src/emit/entry.ts";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { methodTokens } from "../../src/model/method-tokens.ts";

const root = nodePath.resolve(import.meta.dir, "../..");

const vp = nodePath.resolve(root, "node_modules/.bin/vp");

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const fmtTimeout = 30_000;

const config = Schema.decodeUnknownSync(AuthorConfig)({
  binName: "example-cli",
  package: { name: "example-cli", version: "1.2.3" },
});

const emit = () => Effect.runSync(emitEntryFiles(config, []));

const contentOf = (path: string): string => {
  const file = emit().find((candidate) => candidate.path === path);
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

// The string literals of the `allowed: new Set([...])` array in the client policy.
const allowlistOf = (bin: string): readonly string[] => {
  const start = bin.indexOf("allowed: new Set([");
  const end = bin.indexOf("])", start);
  expect(start).toBeGreaterThan(-1);

  return [...bin.slice(start, end).matchAll(/"(?<token>[^"]*)"/gu)].map(
    (match) => match.groups?.token ?? "",
  );
};

const callText = (text: string, head: string): string => {
  const start = text.indexOf(head);
  expect(start).toBeGreaterThan(-1);

  return text.slice(start, text.indexOf(")", start) + 1);
};

describe("emitEntryFiles", () => {
  test("emits src/bin.ts and src/main.ts in path order", () => {
    expect(emit().map((file) => file.path)).toEqual(["src/bin.ts", "src/main.ts"]);
  });

  test("main.ts runs the root without rendering, provides services and the formatter", () => {
    expect(contentOf("src/main.ts")).toBe(
      [
        'import { Effect, Layer, Stdio } from "effect";',
        'import { CliOutput, Command } from "effect/cli";',
        'import { root, services } from "./cli/root.ts";',
        'import * as Output from "./runtime/output.ts";',
        "",
        "export const run = Stdio.Stdio.use((stdio) => stdio.args).pipe(",
        "  Effect.flatMap(root),",
        "  Effect.flatMap((command) =>",
        '    Command.run(command, { renderErrors: false, version: "1.2.3" }).pipe(',
        "      Effect.provide(Layer.mergeAll(services, CliOutput.layer(Output.formatter(command)))),",
        "    ),",
        "  ),",
        "  Output.exitForHelp,",
        "  Output.finalCatch([]),",
        ");",
        "",
      ].join("\n"),
    );
  });

  test("bin.ts is the only module that names Bun", () => {
    const bin = contentOf("src/bin.ts");
    const main = contentOf("src/main.ts");
    expect(bin.startsWith("#!/usr/bin/env bun\n\n")).toBe(true);
    expect(bin).toContain('from "@effect/platform-bun";');
    expect(bin).toContain("Bun.file(path)");
    expect(bin).toContain('import { run } from "./main.ts";');
    expect(main).not.toContain("Bun");
    expect(main).not.toContain("@effect/platform-bun");
  });

  test("the client policy allowlist equals method-tokens.ts", () => {
    expect(allowlistOf(contentOf("src/bin.ts"))).toEqual([...methodTokens]);
  });

  test("the client policy carries the direct route, bin name and version", () => {
    const bin = contentOf("src/bin.ts");
    expect(bin).toContain("Layer.succeed(Output.ClientPolicy, {");
    expect(bin).toContain('  binName: "example-cli",\n');
    expect(bin).toContain("  direct: Client.directRoute,\n");
    expect(bin).not.toContain("proxy");
    expect(bin).toContain('  version: "1.2.3",\n');
  });

  test("the Bun client layer has manual redirects, no timeout and no proxy key", () => {
    const layer = callText(contentOf("src/bin.ts"), "BunHttpClient.layerOptions(");
    expect(layer).toBe('BunHttpClient.layerOptions({ redirect: "manual", timeout: 0 })');
  });

  test("bin.ts provides the entry services and runs without a second error reporter", () => {
    const bin = contentOf("src/bin.ts");
    for (const provided of [
      "BunServices.layer,",
      "Layer.succeed(FileBody.FileBody, {",
      "Output.runCredentialsLayer,",
      "CliOutput.layerPresenter(Output.presenter),",
      "Layer.succeed(References.LogToStderr, true),",
      "Layer.succeed(HttpClient.TracerPropagationEnabled, false),",
    ]) {
      expect(bin).toContain(provided);
    }

    expect(callText(bin, "CliConfig.layer(")).toBe(
      "CliConfig.layer({ builtIns: Output.builtIns })",
    );
    expect(bin).not.toContain("GlobalFlag");
    expect(bin).not.toContain("stdinClaimLayer");
    expect(bin).not.toContain("Wizard");
    expect(bin).not.toContain("CliOutput.layer(");
    expect(
      bin.endsWith(
        "BunRuntime.runMain(Effect.provide(run, entry), { disableErrorReporting: true });\n",
      ),
    ).toBe(true);
  });

  test("a hostile package version is refused before emit", () => {
    const decoded = Schema.decodeUnknownEffect(AuthorConfig)({
      binName: "example-cli",
      package: { name: "example-cli", version: "1.0.0-'rc'\u2028" },
    });

    expect(Effect.runSyncExit(decoded)._tag).toBe("Failure");
  });

  test(
    "both files pass vp fmt --check",
    () => {
      expect(emit()).toHaveLength(2);
      for (const file of emit()) {
        expect(formatted(file.path, file.content)).toBe(file.content);
      }
    },
    fmtTimeout,
  );
});
