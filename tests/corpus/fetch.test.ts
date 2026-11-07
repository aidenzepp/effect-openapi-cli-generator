import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import { Array as Arr, Effect, FileSystem, Order, Path, Schema } from "effect";
import type { Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import { Corpus, fetchPinned, githubSource } from "../../corpus/tools/fetch.ts";
import type { Source } from "../../corpus/tools/fetch.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";

const bytes = new TextEncoder().encode('{"openapi":"3.1.0"}\n');

const sha256Of = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

const known = sha256Of(bytes);

const sourceUrl = "https://raw.githubusercontent.com/example/repo/0123456789abcdef/spec.json";

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(BunServices.layer)));

const tagOf = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (failure) => failure._tag);

const tempCache = Effect.gen(function* temp() {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.makeTempDirectoryScoped({ prefix: "corpus-fetch-test-" });
});

const readJson = <A, I>(path: string, schema: Schema.Codec<A, I>) =>
  Effect.gen(function* read() {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path);

    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text);
  });

// A local file stands in for the network: the pin's URL names the file's bytes.
const localSource =
  (calls: { count: number }): Source<FileSystem.FileSystem> =>
  () =>
    Effect.sync(() => {
      calls.count += 1;

      return bytes;
    });

describe("fetchPinned", () => {
  test("accepts bytes with the pinned hash and caches them by hash", async () => {
    const calls = { count: 0 };
    const { cached, exists, path, second } = await run(
      Effect.gen(function* body() {
        const cacheDir = yield* tempCache;
        const fs = yield* FileSystem.FileSystem;
        const first = yield* fetchPinned(
          { sha256: known, sourceUrl },
          cacheDir,
          localSource(calls),
        );
        const again = yield* fetchPinned(
          { sha256: known, sourceUrl },
          cacheDir,
          localSource(calls),
        );

        return {
          cached: yield* fs.readFile(first),
          exists: yield* fs.exists(first),
          path: first,
          second: again,
        };
      }),
    );

    expect(exists).toBe(true);
    expect(path.endsWith(`/${known}`)).toBe(true);
    expect(sha256Of(cached)).toBe(known);
    expect(second).toBe(path);
    expect(calls.count).toBe(1);
  });

  test("refuses bytes whose hash differs and caches nothing", async () => {
    const wrong = "0".repeat(64);
    const { exists, tag } = await run(
      Effect.gen(function* body() {
        const cacheDir = yield* tempCache;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const failed = yield* tagOf(
          fetchPinned({ sha256: wrong, sourceUrl }, cacheDir, localSource({ count: 0 })),
        );

        return { exists: yield* fs.exists(path.join(cacheDir, wrong)), tag: failed };
      }),
    );

    expect(tag).toBe("CorpusHashMismatch");
    expect(exists).toBe(false);
  });

  test("refetches when a cached file no longer matches its hash", async () => {
    const calls = { count: 0 };
    const { cached } = await run(
      Effect.gen(function* body() {
        const cacheDir = yield* tempCache;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* fs.writeFile(path.join(cacheDir, known), new TextEncoder().encode("tampered"));

        const result = yield* fetchPinned(
          { sha256: known, sourceUrl },
          cacheDir,
          localSource(calls),
        );

        return { cached: yield* fs.readFile(result) };
      }),
    );

    expect(sha256Of(cached)).toBe(known);
    expect(calls.count).toBe(1);
  });
});

describe("githubSource", () => {
  const refused = [
    "https://example.com/spec.json",
    "http://raw.githubusercontent.com/example/repo/sha/spec.json",
    "https://raw.githubusercontent.com.evil.test/example/repo/sha/spec.json",
    "https://user:pass@raw.githubusercontent.com/example/repo/sha/spec.json",
    "https://raw.githubusercontent.com:8443/example/repo/sha/spec.json",
    "not a url",
  ];

  test.each(refused)("refuses %s before any request", async (url) => {
    const tag = await Effect.runPromise(
      tagOf(githubSource(url)).pipe(Effect.provide(FetchHttpClient.layer)),
    );

    expect(tag).toBe("CorpusSourceRefused");
  });
});

describe("corpus files", () => {
  test("corpus.json decodes with the tiers, unique ids and commit-pinned ci URLs", async () => {
    const corpus = await run(readJson("corpus/corpus.json", Corpus));
    const ids = corpus.specs.map((spec) => spec.id);
    const ci = corpus.specs.filter((spec) => spec.tier === "ci");

    expect(new Set(ids).size).toBe(ids.length);
    expect(
      Arr.sort(
        ci.map((spec) => spec.id),
        Order.String,
      ),
    ).toEqual([
      "cloudflare",
      "discord",
      "github-3.0",
      "github-3.1",
      "kubernetes-core-v1",
      "openai",
      "resend",
      "stripe",
      "stripe-brackets",
    ]);
    expect(
      Arr.sort(
        corpus.specs.filter((spec) => spec.tier === "extended").map((spec) => spec.id),
        Order.String,
      ),
    ).toEqual(["digitalocean", "plaid", "twilio"]);

    for (const spec of ci) {
      const sha = spec.pinnedRef.split("@")[1] ?? "";

      expect(sha).toMatch(/^[0-9a-f]{40}$/u);
      expect(spec.sourceUrl.startsWith("https://raw.githubusercontent.com/")).toBe(true);
      expect(spec.sourceUrl.includes(`/${sha}/`)).toBe(true);
    }
  });

  test("resend.json decodes with the author config codec", async () => {
    const config = await run(
      Effect.gen(function* body() {
        const json = yield* readJson("corpus/config/resend.json", Schema.Json);

        return yield* decodeAuthorConfig(json, {
          document: Schema.decodeUnknownSync(DocumentUri)("file:///corpus/config/resend.json"),
        });
      }),
    );

    expect(config.binName).toBe("resend");
    expect(config.envPrefix).toBe("RESEND");
    expect(config.servers?.accepted).toEqual(["https://api.resend.com"]);
  });
});
