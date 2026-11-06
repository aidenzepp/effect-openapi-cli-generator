import nodeFs from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { Corpus, fetchPinned, githubSource } from "../../corpus/tools/fetch.ts";

const root = nodePath.resolve(import.meta.dir, "../..");

const cacheDir =
  process.env.CORPUS_CACHE ?? nodePath.join(homedir(), ".cache/effect-openapi-cli-generator");

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, FetchHttpClient.layer);

export interface PinnedSpec {
  readonly spec: string;
  readonly twin: string | undefined;
}

/**
 * Paths of the pinned corpus entry `id` and its YAML twin, read through the sha256-verified cache
 * (the same `fetchPinned` the corpus run uses); a missing file is fetched once from its pinned URL.
 */
export const pinnedSpec = (id: string): Promise<PinnedSpec> => {
  const entry = Schema.decodeUnknownSync(Schema.fromJsonString(Corpus))(
    nodeFs.readFileSync(nodePath.join(root, "corpus/corpus.json"), "utf-8"),
  ).specs.find((candidate) => candidate.id === id);

  if (entry === undefined) {
    return Promise.reject(new Error(`corpus entry ${id} not found`));
  }

  return Effect.runPromise(
    Effect.gen(function* resolve() {
      const spec = yield* fetchPinned(entry, cacheDir, githubSource);
      const twin =
        entry.twin === undefined
          ? undefined
          : yield* fetchPinned(entry.twin, cacheDir, githubSource);

      return { spec, twin };
    }).pipe(Effect.provide(layer)),
  );
};
