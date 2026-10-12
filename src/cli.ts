#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { Effect, FileSystem } from "effect";
import { NodeServices } from "@effect/platform-node";
import { main } from "./cli/main.js";

/**
 * The path invoked by Node, which may be an installed executable symlink.
 */
const [, invokedPath] = process.argv;

/**
 * Keeps module imports inert while accepting installed executable symlinks.
 */
const isEntryPoint =
  invokedPath !== undefined && invokedPath !== ""
    ? await Effect.gen(function* resolveEntryPoint() {
        const fs = yield* FileSystem.FileSystem;
        const invoked = yield* fs.realPath(invokedPath);
        // oxlint-disable-next-line unicorn/prefer-import-meta-properties -- fileURLToPath supports the existing Node ESM runtime floor.
        const module = yield* fs.realPath(fileURLToPath(import.meta.url));

        return invoked === module;
      }).pipe(
        Effect.orElseSucceed(() => false),
        Effect.provide(NodeServices.layer),
        Effect.runPromise,
      )
    : false;

if (isEntryPoint) {
  main();
}
