import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Schema } from "effect";
import { fileURLToPath } from "node:url";
import { formatApplication } from "../src/core/format.js";
import { generate } from "../src/index.js";

/**
 * Generate every outbound operation directly from the pinned, unmodified Resend document.
 */
const generateResendFull = Effect.gen(function* generateResendFullExample() {
  const fs = yield* FileSystem.FileSystem;
  const root = fileURLToPath(new URL("../", import.meta.url));
  const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.JsonObject))(
    yield* fs.readFileString(`${root}examples/resend-reference/upstream/resend.json.snapshot`),
  );
  const application = yield* generate(document, { name: "resend-full-generated" });
  const destination = `${root}examples/resend-full-generated`;
  if (yield* fs.exists(`${destination}/src`)) {
    const existing = yield* fs.readDirectory(`${destination}/src`, { recursive: true });
    const expected = new Set(
      application.files
        .filter((file) => file.path.startsWith("src/"))
        .map((file) => file.path.slice(4)),
    );
    for (const entry of existing) {
      const stat = yield* fs.stat(`${destination}/src/${entry}`);
      if (stat.type === "File" && !expected.has(entry)) {
        return yield* Effect.fail(
          new Error(`Unexpected generated source ${entry}; inspect it before regenerating.`),
        );
      }
    }
  }

  yield* fs.makeDirectory(destination, { recursive: true });

  const input = yield* formatApplication({
    files: [{ content: JSON.stringify(document), path: "openapi.json" }],
  });
  for (const file of input.files) {
    yield* fs.writeFileString(`${destination}/${file.path}`, file.content);
  }
  for (const file of application.files) {
    const target = `${destination}/${file.path}`;
    yield* fs.makeDirectory(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    yield* fs.writeFileString(target, file.content);
  }

  return yield* Effect.void;
});

generateResendFull.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain());
