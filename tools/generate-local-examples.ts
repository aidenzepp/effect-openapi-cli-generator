import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Schema } from "effect";
import { fileURLToPath } from "node:url";
import { generate } from "../src/index.js";

/**
 * Regenerate the demo and integration outputs from their committed specifications.
 */
const generateLocalExamples = Effect.gen(function* generateLocalExamples() {
  const fs = yield* FileSystem.FileSystem;
  const root = fileURLToPath(new URL("../examples/", import.meta.url));
  for (const example of ["demo", "integration"]) {
    const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.JsonObject))(
      yield* fs.readFileString(`${root}${example}/openapi.json`),
    );
    const application = yield* generate(document);
    const destination = `${root}${example}/cli`;
    const expected = new Set(application.files.map((file) => file.path));
    const existing = yield* fs.readDirectory(`${destination}/src`, { recursive: true });
    for (const entry of existing) {
      const stat = yield* fs.stat(`${destination}/src/${entry}`);
      if (stat.type === "File" && !expected.has(`src/${entry}`)) {
        return yield* Effect.fail(
          new Error(
            `Unexpected generated source ${example}/cli/src/${entry}; inspect it before regenerating.`,
          ),
        );
      }
    }
    for (const file of application.files) {
      const target = `${destination}/${file.path}`;
      yield* fs.makeDirectory(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      yield* fs.writeFileString(target, file.content);
    }
  }

  return yield* Effect.void;
});

generateLocalExamples.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain());
