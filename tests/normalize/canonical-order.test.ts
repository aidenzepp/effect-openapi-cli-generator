import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Array as Arr, Effect, FileSystem, Layer, Order, Path, Schema, pipe } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { isObject } from "../../src/model/json-tree.ts";
import type { Json } from "../../src/model/pointer.ts";

// Design 3.7: output is a function of the document's value and its semantic orders. Member order
// of `paths`, path items, `components.schemas` and JSON `properties` maps is not semantic, so a
// twin with those members reversed generates the same package. `content`, `encoding` and the
// multipart body's `properties` are semantic and stay in place. `S1` and `s1` fold to one flag, so
// a first-wins step over body properties would show here. Objects whose member order the test
// sets on purpose are built from entries, in the order written.

type Entry = readonly [string, Json];

const members = (...entries: readonly Entry[]): Json => Object.fromEntries(entries);

const entriesOf = (value: Json | undefined): readonly Entry[] =>
  isObject(value) ? Object.entries(value) : [];

const withEntries = (value: Json, change: (entries: readonly Entry[]) => readonly Entry[]): Json =>
  isObject(value) ? Object.fromEntries(change(Object.entries(value))) : value;

const updateEach = (value: Json, change: (member: Json) => Json): Json =>
  withEntries(value, (entries) => entries.map(([key, member]) => [key, change(member)]));

const updateMember = (value: Json, name: string, change: (member: Json) => Json): Json =>
  withEntries(value, (entries) =>
    entries.map(([key, member]) => [key, key === name ? change(member) : member]),
  );

const jsonBody = (schema: Json): Json => ({
  content: { "application/json": { schema } },
  required: true,
});

const jsonResponse = (schema: Json): Json => ({
  "200": { content: { "application/json": { schema } }, description: "OK" },
});

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });

const pathParameter = (name: string): Json => ({
  in: "path",
  name,
  required: true,
  schema: { type: "string" },
});

const spec = members(
  [
    "components",
    {
      schemas: members(
        [
          "Zone",
          {
            properties: members(
              ["name", { type: "string" }],
              ["id", { type: "string" }],
              ["status", { type: "string" }],
            ),
            type: "object",
          },
        ],
        [
          "Account",
          {
            properties: members(
              ["P1", { type: "string" }],
              ["S1", { type: "string" }],
              ["S10", { type: "integer" }],
              ["S2", { type: "boolean" }],
              ["s1", { type: "string" }],
            ),
            required: ["P1"],
            type: "object",
          },
        ],
      ),
    },
  ],
  ["info", { title: "Canon", version: "1.0.0" }],
  ["openapi", "3.1.0"],
  [
    "paths",
    members(
      [
        "/zones/{zone_id}",
        members(
          ["parameters", [pathParameter("zone_id")]],
          ["put", { requestBody: jsonBody(ref("Zone")), responses: jsonResponse(ref("Zone")) }],
          ["get", { responses: jsonResponse(ref("Zone")), tags: ["Zones"] }],
        ),
      ],
      [
        "/zones",
        {
          get: {
            responses: jsonResponse({
              properties: members(
                ["S1", { type: "string" }],
                ["S10", { type: "integer" }],
                ["S2", { type: "boolean" }],
              ),
              type: "object",
            }),
            tags: ["Zones"],
          },
        },
      ],
      ["/accounts/me", { get: { responses: jsonResponse(ref("Account")), tags: ["Accounts"] } }],
      [
        "/accounts/{account_id}",
        {
          get: {
            parameters: [pathParameter("account_id")],
            responses: jsonResponse(ref("Account")),
            tags: ["user-accounts"],
          },
        },
      ],
      [
        "/accounts",
        members(
          [
            "post",
            {
              requestBody: jsonBody(ref("Account")),
              responses: jsonResponse(ref("Account")),
              tags: ["User Accounts"],
            },
          ],
          [
            "patch",
            {
              requestBody: {
                content: {
                  "multipart/form-data": {
                    encoding: members(
                      ["b", { contentType: "text/plain" }],
                      ["a", { contentType: "text/plain" }],
                    ),
                    schema: {
                      properties: members(["b", { type: "string" }], ["a", { type: "string" }]),
                      type: "object",
                    },
                  },
                },
              },
              responses: jsonResponse({
                properties: members(["S2", { type: "string" }], ["S1", { type: "string" }]),
              }),
              tags: ["User Accounts"],
            },
          ],
        ),
      ],
    ),
  ],
  ["servers", [{ url: "https://api.example.com" }]],
);

const reverseMembers = (value: Json): Json => withEntries(value, Arr.reverse);

// Reverses the `properties` of a JSON schema and of every schema nested in them.
const reverseSchema = (schema: Json): Json =>
  updateMember(schema, "properties", (properties) =>
    reverseMembers(updateEach(properties, reverseSchema)),
  );

// Reverses the JSON schema under a request body or a response; other media stay in place.
const reverseJsonMedia = (holder: Json): Json =>
  updateMember(holder, "content", (content) =>
    updateMember(content, "application/json", (media) =>
      updateMember(media, "schema", reverseSchema),
    ),
  );

const reverseOperation = (operation: Json): Json =>
  updateMember(updateMember(operation, "requestBody", reverseJsonMedia), "responses", (responses) =>
    updateEach(responses, reverseJsonMedia),
  );

const reverseItem = (item: Json): Json =>
  reverseMembers(
    withEntries(item, (entries) =>
      entries.map(([key, member]) => [
        key,
        key === "parameters" ? member : reverseOperation(member),
      ]),
    ),
  );

const reverseTwin = (source: Json): Json =>
  updateMember(
    updateMember(source, "paths", (paths) => reverseMembers(updateEach(paths, reverseItem))),
    "components",
    (components) =>
      updateMember(components, "schemas", (schemas) =>
        reverseMembers(updateEach(schemas, reverseSchema)),
      ),
  );

const pathKeys = (source: Json): readonly string[] =>
  entriesOf(entriesOf(source).find(([key]) => key === "paths")?.[1]).map(([key]) => key);

const config = JSON.stringify({
  binName: "canon",
  envPrefix: "CANON",
  package: { name: "canon-cli", version: "1.0.0" },
  servers: { accepted: ["https://api.example.com"] },
});

const document = Schema.decodeUnknownSync(DocumentUri)("file:///canon/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///canon/author-config.json");

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

/**
 * Generates `source` into a fresh temp directory and returns the files `generate` wrote, except
 * `generation-report.json` (it records each input's digest), sorted by path with their text: the
 * files the corpus twin check compares.
 */
const generateTree = (source: Json) =>
  Effect.gen(function* generateTreeGen() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "canon-" });
    const specPath = path.join(dir, "openapi.json");
    const configPath = path.join(dir, "author-config.json");
    const out = path.join(dir, "out");

    yield* fs.writeFileString(specPath, JSON.stringify(source));
    yield* fs.writeFileString(configPath, config);

    const result = yield* generate(
      { document, generator, outDir: out, source: { _tag: "File", path: specPath }, strict: false },
      { document: configDocument, path: configPath },
    );
    const kept = Arr.sort(
      result.files.filter((file) => file !== "generation-report.json"),
      Order.String,
    );

    return yield* pipe(
      kept,
      Effect.forEach((relative) =>
        fs
          .readFileString(path.join(out, relative))
          .pipe(Effect.map((text) => ({ relative, text }))),
      ),
    );
  });

const trees = Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* both() {
      const written = yield* generateTree(spec);
      const twin = yield* generateTree(reverseTwin(spec));

      return { twin, written };
    }),
  ).pipe(Effect.provide(layer)),
);

describe("canonical order (design 3.7)", () => {
  test("the reversed twin differs from the fixture in member order only", () => {
    const twin = reverseTwin(spec);

    expect(twin).toEqual(spec);
    expect(pathKeys(twin)).toEqual(Arr.reverse(pathKeys(spec)));
  });

  test("a spec and its member-reversed twin generate the same package", async () => {
    const { twin, written } = await trees;

    expect(written.map((file) => file.relative)).toContain("src/cli/zones.ts");
    expect(twin.map((file) => file.relative)).toEqual(written.map((file) => file.relative));
    for (const [index, file] of written.entries()) {
      expect({ relative: twin[index]?.relative, text: twin[index]?.text }).toEqual(file);
    }
  });
});
