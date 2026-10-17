import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Schema } from "effect";
import { fileURLToPath } from "node:url";
import { formatApplication } from "../src/core/format.js";
import { generate } from "../src/index.js";

/**
 * Apply this fixture's eight concrete naming targets; this is not a general Overlay engine.
 */
const generateResend = Effect.gen(function* generateResendExample() {
  const fs = yield* FileSystem.FileSystem;
  const root = fileURLToPath(new URL("../", import.meta.url));
  const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.JsonObject))(
    yield* fs.readFileString(`${root}examples/resend-reference/openapi.json`),
  );
  const overlay = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        actions: Schema.Array(Schema.Struct({ target: Schema.String, update: Schema.JsonObject })),
      }),
    ),
  )(yield* fs.readFileString(`${root}examples/resend-reference/naming.overlay.json`));
  const paths = yield* Schema.decodeUnknownEffect(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.JsonObject)),
  )(document.paths);
  const seen = new Set<string>();
  for (const action of overlay.actions) {
    const match =
      /^\$\["paths"\]\[(?<path>"[^"\\]+")\]\[(?<method>"(?:get|post|patch|delete)")\]$/u.exec(
        action.target,
      );
    const pathText = yield* Schema.decodeUnknownEffect(Schema.String)(match?.groups?.path);
    const methodText = yield* Schema.decodeUnknownEffect(Schema.String)(match?.groups?.method);
    const path = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.String))(pathText);
    const method = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.String))(
      methodText,
    );
    const operation = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(paths[path]?.[method]);
    if (seen.has(action.target)) {
      return yield* Effect.fail(new Error("Duplicate naming target."));
    }

    seen.add(action.target);
    Object.assign(operation, action.update);

    const item = paths[path];
    if (item) {
      Object.assign(item, { [method]: operation });
    }
  }
  yield* Schema.decodeUnknownEffect(Schema.Literal(8))(seen.size);

  const enriched = { ...document, paths };
  const application = yield* generate(enriched, { name: "resend-generated" });
  const destination = `${root}examples/resend-generated`;
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
    files: [{ content: JSON.stringify(enriched), path: "openapi.json" }],
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

generateResend.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain());
