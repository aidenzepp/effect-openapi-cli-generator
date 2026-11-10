import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunCrypto, BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, FileSystem, Layer, Path, Schema } from "effect";
import generatorPackage from "../package.json" with { type: "json" };
import generatorTsconfig from "../tsconfig.json" with { type: "json" };
import { generate } from "../src/generate.ts";
import type { GenerateResult } from "../src/generate.ts";
import { DocumentUri } from "../src/model/brands.ts";
import { GenerationReport } from "../src/report/index.ts";

// The author config switch `nonStandard.deepObjectBrackets` (design 6.1, PRM-27) end to end through
// `generate`: on, a nested deepObject query parameter and a nested form deepObject property are
// both marked and sent in the bracket convention; off, both are refused. The switch is never
// defaulted or inferred, so each run names it.

const root = nodePath.resolve(import.meta.dir, "..");

const fixture = nodePath.join(root, "tests/fixtures/golden/users-update");

const JsonRecord = Schema.Record(Schema.String, Schema.Json);

const decodeRecord = Schema.decodeUnknownSync(JsonRecord);

const readJson = (relative: string) =>
  decodeRecord(JSON.parse(nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8")));

const golden = readJson("openapi.json");

const goldenConfig = readJson("author-config.json");

const goldenPaths = decodeRecord(golden.paths ?? {});

const document = Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///golden/author-config.json");

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layerDigest);

const filter = {
  properties: { owner: { properties: { name: { type: "string" } }, type: "object" } },
  type: "object",
};

const formSchema = { properties: { filter, title: { type: "string" } }, type: "object" };

// The golden paths plus `GET /items` (a nested deepObject query parameter) and `POST /forms` (a
// form body whose `filter` property is a nested deepObject).
const spec: Schema.Json = {
  ...golden,
  paths: {
    ...goldenPaths,
    "/forms": {
      post: {
        operationId: "forms-create",
        requestBody: {
          content: {
            "application/x-www-form-urlencoded": {
              encoding: { filter: { explode: true, style: "deepObject" } },
              schema: formSchema,
            },
          },
          required: false,
        },
        responses: { "200": { description: "ok" } },
        tags: ["items"],
      },
    },
    "/items": {
      get: {
        operationId: "items-list",
        parameters: [
          { explode: true, in: "query", name: "filter", schema: filter, style: "deepObject" },
        ],
        responses: { "200": { description: "ok" } },
        tags: ["items"],
      },
    },
  },
};

const queryPointer = "/paths/~1items/get";

const formPointer = "/paths/~1forms/post";

const decodeReport = Schema.decodeUnknownSync(GenerationReport);

// The worktree's git-ignored `work/`, so no run writes outside the tree.
const scratch = nodePath.join(root, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

interface Observed {
  readonly apiItems: string;
  readonly cliItems: string;
  readonly report: typeof GenerationReport.Type;
  readonly result: GenerateResult;
}

const runWith = (deepObjectBrackets: boolean): Promise<Observed> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* prepare() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ directory: scratch, prefix: "brw-" });
        const specPath = path.join(dir, "openapi.json");
        const configPath = path.join(dir, "author-config.json");
        const out = path.join(dir, "out");
        const config = { ...goldenConfig, nonStandard: { deepObjectBrackets } };
        yield* fs.writeFileString(specPath, JSON.stringify(spec));
        yield* fs.writeFileString(configPath, JSON.stringify(config));

        const exit = yield* Effect.exit(
          generate(
            {
              document,
              generator,
              outDir: out,
              source: { _tag: "File", path: specPath },
              strict: false,
            },
            { document: configDocument, path: configPath },
          ),
        );
        if (Exit.isFailure(exit)) {
          return yield* Effect.die(new Error(`generate failed: ${String(exit.cause)}`));
        }

        const read = (relative: string) =>
          fs
            .readFileString(path.join(out, ...relative.split("/")))
            .pipe(Effect.orElseSucceed(() => ""));

        return {
          apiItems: yield* read("src/api/items.ts"),
          cliItems: yield* read("src/cli/items.ts"),
          report: decodeReport(JSON.parse(yield* read("generation-report.json"))),
          result: exit.value,
        };
      }),
    ).pipe(Effect.provide(layer)),
  );

const at = (pointer: string, prefix: string) => pointer.startsWith(prefix);

// The emitted call that starts with `head`, through its closing `})`, whatever its line layout.
const callOf = (text: string, head: string): string => {
  const start = text.indexOf(head);

  return start === -1 ? "" : text.slice(start, text.indexOf("})", start) + 2);
};

const on = await runWith(true);

const off = await runWith(false);

describe("generate: nonStandard.deepObjectBrackets on", () => {
  test("the emitted query call and form entry carry brackets: true", () => {
    expect(callOf(on.apiItems, 'Serialize.deepObject("filter"')).toContain("brackets: true");

    const entries = on.apiItems.split("\n").filter((line) => line.includes('["filter", {'));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("brackets: true");
    expect(entries[0]).toContain('style: "deepObject"');
  });

  test("the report lists both marked elements under PRM-27", () => {
    const entries = on.report.nonStandard;

    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        choice: "deepObjectBrackets",
        configKey: "nonStandard.deepObjectBrackets",
        document,
        row: "PRM-27",
      });
    }
    expect(at(entries[0]?.pointer ?? "", formPointer)).toBe(true);
    expect(at(entries[1]?.pointer ?? "", queryPointer)).toBe(true);
  });

  test("each marked element has its bracket-author-choice notice and nothing is refused", () => {
    const notices = on.report.notices.filter(
      (diagnostic) => diagnostic.code === "PRM-27/bracket-author-choice",
    );

    expect(notices).toHaveLength(2);
    expect(notices.some((notice) => at(notice.pointer, formPointer))).toBe(true);
    expect(notices.some((notice) => at(notice.pointer, queryPointer))).toBe(true);
    expect(on.report.refusals.filter((refusal) => refusal.row === "PRM-27")).toEqual([]);
  });

  test("help carries the NON-STANDARD section", () => {
    expect(on.cliItems).toContain('"NON-STANDARD"');
  });
});

describe("generate: nonStandard.deepObjectBrackets off", () => {
  test("both nested deepObject elements are refused compound-nested and none is marked", () => {
    const refusals = off.report.refusals.filter(
      (diagnostic) => diagnostic.code === "PRM-27/compound-nested",
    );

    expect(refusals).toHaveLength(2);
    expect(refusals.some((refusal) => at(refusal.pointer, formPointer))).toBe(true);
    expect(refusals.some((refusal) => at(refusal.pointer, queryPointer))).toBe(true);
    expect(off.report.nonStandard).toEqual([]);
    expect(off.report.notices.map((notice) => notice.code)).not.toContain(
      "PRM-27/bracket-author-choice",
    );
    expect(off.apiItems).not.toContain("brackets");
    expect(off.cliItems).not.toContain("NON-STANDARD");
  });
});
