import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";
import { HttpClient } from "effect/http";
import { fileURLToPath } from "node:url";
import {
  CloudflareSourceError,
  cloudflarePaths,
  cloudflareRevision,
  cloudflareSha256,
  cloudflareUrl,
  decodeCloudflareSnapshot,
  extractCloudflare,
  sha256,
} from "./cloudflare-source.js";
import { formatApplication } from "../src/core/format.js";
import { generate } from "../src/index.js";

/**
 * Fetch the pinned public snapshot, or accept the same verified bytes from a local file.
 */
const generateCloudflare = Effect.gen(function* generateCloudflareExample() {
  const fs = yield* FileSystem.FileSystem;
  const [localSnapshot] = process.argv.slice(2);
  const text =
    localSnapshot === undefined
      ? yield* HttpClient.get(cloudflareUrl).pipe(Effect.flatMap((response) => response.text))
      : yield* fs.readFileString(localSnapshot);
  const snapshot = yield* decodeCloudflareSnapshot(text);
  const document = yield* extractCloudflare(snapshot);
  const application = yield* generate(document);
  const destination = fileURLToPath(new URL("../examples/cloudflare-generated/", import.meta.url));
  const expected = new Set(application.files.map((file) => file.path));
  if (yield* fs.exists(`${destination}src`)) {
    for (const entry of yield* fs.readDirectory(`${destination}src`, { recursive: true })) {
      const stat = yield* fs.stat(`${destination}src/${entry}`);
      if (stat.type === "File" && !expected.has(`src/${entry}`)) {
        return yield* Effect.fail(
          new CloudflareSourceError({
            message: `Unexpected generated source ${entry}; inspect it before regenerating.`,
          }),
        );
      }
    }
  }

  const inputs = yield* formatApplication({
    files: [
      { content: JSON.stringify(document), path: "openapi.json" },
      {
        content: JSON.stringify({
          operations: cloudflarePaths.map((path) => ({ method: "get", path })),
          revision: cloudflareRevision,
          sha256: cloudflareSha256,
          sliceSha256: sha256(JSON.stringify(document)),
          url: cloudflareUrl,
        }),
        path: "provenance.json",
      },
    ],
  });
  for (const file of [...inputs.files, ...application.files]) {
    const target = `${destination}${file.path}`;
    yield* fs.makeDirectory(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    yield* fs.writeFileString(target, file.content);
  }

  return yield* Effect.void;
});

generateCloudflare.pipe(
  Effect.provide(NodeHttpClient.layerNodeHttp),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain(),
);
