import { createHash } from "node:crypto";
import { Array, Data, Effect, Order, Schema } from "effect";
import { resolveReference } from "../src/core/references.js";

export const cloudflareRevision = "15656f084dd7a0ada54f8f659c749a7248254b9f";

export const cloudflareSha256 = "d1d390a0d062d5686c448b01f57a7a72e7f61594929f1888137e81499efc97c9";

export const cloudflareUrl = `https://raw.githubusercontent.com/cloudflare/api-schemas/${cloudflareRevision}/openapi.json`;

export const cloudflarePaths = [
  "/user/tokens",
  "/user/tokens/permission_groups",
  "/user/tokens/verify",
] as const;

export class CloudflareSourceError extends Data.TaggedError("CloudflareSourceError")<{
  readonly message: string;
}> {}

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const references = (value: Schema.Json): readonly string[] => {
  if (Schema.is(Schema.Array(Schema.Json))(value)) {
    return value.flatMap(references);
  }

  if (Schema.is(Schema.JsonObject)(value)) {
    return [
      ...(Schema.is(Schema.String)(value.$ref) ? [value.$ref] : []),
      ...Object.values(value).flatMap(references),
    ];
  }

  return [];
};

/**
 * Retain exact selected operations and the complete closure of their original local references.
 */
export const extractCloudflare = (document: Schema.JsonObject) =>
  Effect.gen(function* extractCloudflareTokenDiscovery() {
    const sourcePaths = yield* Schema.decodeUnknownEffect(
      Schema.Record(Schema.String, Schema.JsonObject),
    )(document.paths);
    const sourceComponents = yield* Schema.decodeUnknownEffect(
      Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.JsonObject)),
    )(document.components);
    const paths: Record<string, Schema.JsonObject> = {};
    const methods = new Set(["get", "put", "post", "delete", "patch", "options", "head", "trace"]);
    for (const path of cloudflarePaths) {
      const item = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(sourcePaths[path]);
      yield* Schema.decodeUnknownEffect(Schema.JsonObject)(item.get);
      paths[path] = Object.fromEntries(
        Object.entries(item).filter(([key]) => key === "get" || !methods.has(key)),
      );
    }
    const securitySchemes = yield* Schema.decodeUnknownEffect(
      Schema.Record(Schema.String, Schema.JsonObject),
    )(sourceComponents.securitySchemes);
    const components = new Map<string, Map<string, Schema.JsonObject>>([
      ["securitySchemes", new Map(Object.entries(securitySchemes))],
    ]);
    const pending = [...references(paths), ...references(securitySchemes)];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const ref = pending.pop();
      if (ref === undefined || seen.has(ref)) {
        continue;
      }

      seen.add(ref);

      const resolved = yield* resolveReference(document, ref, "/components", new Set());
      const [root, category, name, ...rest] = resolved.location
        .slice(1)
        .split("/")
        .map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
      if (
        root !== "components" ||
        category === undefined ||
        name === undefined ||
        rest.length !== 0
      ) {
        return yield* Effect.fail(
          new CloudflareSourceError({
            message: "This pinned fixture requires top-level local component references.",
          }),
        );
      }

      const value = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(resolved.value);
      const entries = components.get(category) ?? new Map<string, Schema.JsonObject>();
      entries.set(name, value);
      components.set(category, entries);
      pending.push(...references(value));
    }

    return {
      ...Object.fromEntries(Object.entries(document)),
      components: Object.fromEntries(
        Array.sort([...components.keys()], Order.String).map((category) => [
          category,
          Object.fromEntries(
            Array.sort(
              [...(components.get(category)?.entries() ?? [])],
              Order.mapInput(
                Order.String,
                (entry: readonly [string, Schema.JsonObject]) => entry[0],
              ),
            ),
          ),
        ]),
      ),
      paths,
    };
  });

/**
 * Verify the original bytes before parsing or selecting any operation.
 */
export const decodeCloudflareSnapshot = (text: string) =>
  Effect.gen(function* decodePinnedCloudflareSnapshot() {
    if (sha256(text) !== cloudflareSha256) {
      return yield* Effect.fail(
        new CloudflareSourceError({
          message:
            "Cloudflare snapshot checksum differs from the pinned source; no files were generated.",
        }),
      );
    }

    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.JsonObject))(text);
  });
