import { describe, expect, test } from "bun:test";
import nodePath from "node:path";
import { Array as Arr, Effect, Exit, Option } from "effect";
import type { ManifestError } from "../../src/write/manifest.ts";
import {
  decodeManifest,
  manifestFileName,
  printManifest,
  sha256Hex,
} from "../../src/write/manifest.ts";

const root = nodePath.resolve(import.meta.dir, "../..");

const vp = nodePath.resolve(root, "node_modules/.bin/vp");

const encoder = new TextEncoder();

const decoder = new TextDecoder();

// `vp fmt --stdin-filepath` runs the same formatter and config as `vp fmt --check`.
const formatJson = (text: string) => {
  const result = Bun.spawnSync([vp, "fmt", `--stdin-filepath=tests/write/${manifestFileName}`], {
    cwd: root,
    stdin: encoder.encode(text),
  });

  return { exitCode: result.exitCode, stdout: decoder.decode(result.stdout) };
};

const entry = (path: string, content: string) => ({ path, sha256: sha256Hex(content) });

const failureOf = <A>(effect: Effect.Effect<A, ManifestError>) =>
  Effect.runSync(
    Effect.exit(effect).pipe(
      Effect.map((exit) => (Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none())),
    ),
  );

const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("sha256Hex", () => {
  test("hashes text and bytes to lowercase hex", () => {
    expect(sha256Hex("abc")).toBe(abc);
    expect(sha256Hex(encoder.encode("abc"))).toBe(abc);
  });
});

describe("printManifest", () => {
  test("lists paths sorted by code unit whatever the input order", () => {
    const text = Effect.runSync(
      printManifest([
        entry("src/main.ts", "m"),
        entry("README.md", "r"),
        entry("package.json", "p"),
      ]),
    );
    const paths = Effect.runSync(decodeManifest(text)).map((item) => item.path);

    expect(paths).toEqual(["README.md", "package.json", "src/main.ts"]);
  });

  test("is deterministic for any input order", () => {
    const a = [entry("a.ts", "1"), entry("b.ts", "2")];

    expect(Effect.runSync(printManifest(a))).toBe(Effect.runSync(printManifest(Arr.reverse(a))));
  });

  test("prints an empty manifest", () => {
    expect(Effect.runSync(decodeManifest(Effect.runSync(printManifest([]))))).toEqual([]);
  });

  test("is a vp fmt fixed point", () => {
    const entries = Array.from({ length: 30 }, (_, index) =>
      entry(`src/file-${index}.ts`, `${index}`),
    );
    for (const text of [
      Effect.runSync(printManifest(entries)),
      Effect.runSync(printManifest([entry("one.ts", "x")])),
      Effect.runSync(printManifest([])),
    ]) {
      const formatted = formatJson(text);

      expect(formatted.exitCode).toBe(0);
      expect(formatted.stdout).toBe(text);
    }
  });

  test("a duplicate path fails with a typed error", () => {
    const error = failureOf(printManifest([entry("a.ts", "1"), entry("a.ts", "2")]));

    expect(Option.getOrUndefined(error)?._tag).toBe("ManifestError");
  });

  test("a sha256 that is not 64 lowercase hex digits fails", () => {
    const error = failureOf(printManifest([{ path: "a.ts", sha256: "ABC" }]));

    expect(Option.getOrUndefined(error)?._tag).toBe("ManifestError");
  });
});

describe("decodeManifest", () => {
  test("round trips the printed manifest", () => {
    const entries = [entry("a.ts", "1"), entry("src/b.ts", "2")];
    const decoded = Effect.runSync(decodeManifest(Effect.runSync(printManifest(entries))));

    expect(decoded).toEqual(entries);
  });

  test("keeps a path that escapes the output directory for the writer to refuse", () => {
    const decoded = Effect.runSync(
      decodeManifest(Effect.runSync(printManifest([entry("../outside.ts", "x")]))),
    );

    expect(decoded.map((item) => item.path)).toEqual(["../outside.ts"]);
  });

  test("a hand-edited, unsorted manifest decodes sorted", () => {
    const text = JSON.stringify({ files: [entry("b.ts", "2"), entry("a.ts", "1")] });

    expect(Effect.runSync(decodeManifest(text)).map((item) => item.path)).toEqual(["a.ts", "b.ts"]);
  });

  const malformed: readonly (readonly [string, string])[] = [
    ["not json", "{"],
    ["empty text", ""],
    ["not an object", "[]"],
    ["no files member", "{}"],
    ["files not an array", '{"files":{}}'],
    ["entry not an object", '{"files":["a.ts"]}'],
    ["empty path", JSON.stringify({ files: [{ path: "", sha256: abc }] })],
    ["path not a string", JSON.stringify({ files: [{ path: 1, sha256: abc }] })],
    ["short sha256", JSON.stringify({ files: [{ path: "a.ts", sha256: "abc" }] })],
    ["uppercase sha256", JSON.stringify({ files: [{ path: "a.ts", sha256: abc.toUpperCase() }] })],
    ["missing sha256", JSON.stringify({ files: [{ path: "a.ts" }] })],
    ["unknown entry member", JSON.stringify({ files: [{ extra: 1, path: "a.ts", sha256: abc }] })],
    ["unknown top-level member", JSON.stringify({ extra: 1, files: [] })],
    [
      "duplicate path",
      JSON.stringify({
        files: [
          { path: "a.ts", sha256: abc },
          { path: "a.ts", sha256: abc },
        ],
      }),
    ],
  ];

  for (const [name, text] of malformed) {
    test(`malformed previous manifest (${name}) fails with a typed error`, () => {
      const error = failureOf(decodeManifest(text));

      expect(Option.getOrUndefined(error)?._tag).toBe("ManifestError");
    });
  }
});
