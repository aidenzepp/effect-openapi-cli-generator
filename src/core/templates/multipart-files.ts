import { Effect } from "effect";
import { file } from "./multipart-file.js";

// template:body
/**
 * Read repeated same-name binary parts in their supplied order.
 */
export const files = (paths: readonly string[] | undefined) =>
  paths === undefined
    ? Effect.succeed(paths)
    : Effect.forEach(paths, (path) => file(path), { concurrency: 1 });
