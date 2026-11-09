import { afterAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Array as Arr, Effect, Order, Schema } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { emitApi } from "../../src/emit/api.ts";
import { emitCli } from "../../src/emit/cli.ts";
import { emitDomainSchemas } from "../../src/emit/domain.ts";
import { emitPackageFiles } from "../../src/emit/package.ts";
import type { EmittedFile } from "../../src/emit/package.ts";
import { runtimeFiles } from "../../src/emit/runtime-files.generated.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { Api } from "../../src/model/entities.ts";
import type { Server } from "../../src/model/entities.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { normalizeSchemas } from "../../src/normalize/schemas.ts";
import { boundOrigins } from "../../src/normalize/servers.ts";
import { resolve } from "../../src/resolve/index.ts";

// The bracket convention (design 6.1, D-OQ1 (b)) is a model marker, `nonStandard:
// "deepObjectBrackets"`, on a query parameter's `StyleSerialization` or a form property's
// `EncodingRule`. Only the author config switch sets it: with `nonStandard.deepObjectBrackets` on,
// normalize marks the nested deepObject entries, and a marked entry emits `brackets: true`. The
// comparison model is the same model with its markers removed, so it emits the M1 text. The scalar
// switch's marker, `nonStandardScalars: "deepObjectScalars"` (design 6.1 Scalar switch), is added
// to the marked model by hand until normalize sets it (m3-sc5), and emits `scalars: true`.

const root = nodePath.resolve(import.meta.dir, "../..");

const fixture = nodePath.join(root, "tests/fixtures/golden/users-update");

const read = (relative: string): string =>
  nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8");

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const golden = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
  JSON.parse(read("openapi.json")),
);

const document = Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///golden/author-config.json");

const goldenConfig = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
  JSON.parse(read("author-config.json")),
);

// The switch is never defaulted or inferred: each run names it in the author config.
const configWith = (deepObjectBrackets: boolean) =>
  Effect.runPromise(
    decodeAuthorConfig(decodeJson({ ...goldenConfig, nonStandard: { deepObjectBrackets } }), {
      document: configDocument,
    }),
  );

const config = await configWith(true);

const configOff = await configWith(false);

const filter = {
  properties: { owner: { properties: { name: { type: "string" } }, type: "object" } },
  type: "object",
};

// A deepObject object with scalar members: standard, so neither switch marks it in normalize.
const created = { properties: { gt: { type: "integer" } }, type: "object" };

// A deepObject array of scalars, Stripe's `expand` shape (watch item N2).
const expand = { items: { maxLength: 5000, type: "string" }, type: "array" };

const formSchema = {
  properties: { created, expand, filter, title: { type: "string" } },
  type: "object",
};

const formEncoding = {
  created: { explode: true, style: "deepObject" },
  expand: { explode: true, style: "deepObject" },
  filter: { explode: true, style: "deepObject" },
};

// `GET /items` with nested and array deepObject query parameters and a plain one; `POST /forms`
// with a lone form body; `POST /choices` with form and JSON alternatives (the alternatives table).
const spec: Schema.Json = {
  ...golden,
  paths: {
    "/choices": {
      post: {
        operationId: "choices-create",
        requestBody: {
          content: {
            "application/json": { schema: formSchema },
            "application/x-www-form-urlencoded": { encoding: formEncoding, schema: formSchema },
          },
          required: true,
        },
        responses: { "200": { description: "ok" } },
        tags: ["items"],
      },
    },
    "/forms": {
      post: {
        operationId: "forms-create",
        requestBody: {
          content: {
            "application/x-www-form-urlencoded": { encoding: formEncoding, schema: formSchema },
          },
          required: true,
        },
        responses: { "200": { description: "ok" } },
        tags: ["items"],
      },
    },
    "/items": {
      get: {
        operationId: "items-list",
        parameters: [
          { explode: true, in: "query", name: "created", schema: created, style: "deepObject" },
          { explode: true, in: "query", name: "filter", schema: filter, style: "deepObject" },
          { explode: true, in: "query", name: "expand", schema: expand, style: "deepObject" },
          { in: "query", name: "page", schema: { type: "string" } },
        ],
        responses: { "200": { description: "ok" } },
        tags: ["items"],
      },
    },
  },
};

// The marked model with every marker removed, round-tripped through the model's encoded form so the
// result passes the model's own schema. Only the bracket markers are keyed `nonStandard`.
const unmark = (api: Api): Api =>
  Schema.decodeUnknownSync(Api)(
    JSON.parse(
      JSON.stringify(Schema.encodeSync(Api)(api), (key: string, value: Schema.Json) =>
        key === "nonStandard" ? undefined : value,
      ),
    ),
  );

// The deepObject entries the hand-built scalar model marks: `created`, which is made
// non-object-valued as a covered union of an object and a scalar is (design 6.1 Scalar switch), so
// its JSON flag comes from the marker alone, and `filter`, which the bracket switch marks too.
const scalarMarked: ReadonlySet<string> = new Set(["created", "filter"]);

type EncodedOperation = (typeof Api.Encoded)["operations"][number];

type EncodedParameter = EncodedOperation["parameters"][number];

type EncodedRule = NonNullable<
  EncodedOperation["body"]
>["alternatives"][number]["encoding"][number];

const markParameter = (parameter: EncodedParameter): EncodedParameter => {
  const { serialization, wireName } = parameter;
  if (serialization.kind !== "style" || !scalarMarked.has(wireName)) {
    return parameter;
  }

  const objectValued = wireName === "filter" && serialization.objectValued;

  return {
    ...parameter,
    serialization: { ...serialization, nonStandardScalars: "deepObjectScalars", objectValued },
  };
};

const markRule = (rule: EncodedRule): EncodedRule =>
  rule.target.kind === "property" &&
  scalarMarked.has(rule.target.name) &&
  rule.serialization?.style === "deepObject"
    ? { ...rule, nonStandardScalars: "deepObjectScalars" }
    : rule;

const markOperation = (operation: EncodedOperation): EncodedOperation => {
  const marked = { ...operation, parameters: operation.parameters.map(markParameter) };
  if (operation.body === undefined) {
    return marked;
  }

  const alternatives = operation.body.alternatives.map((alternative) => ({
    ...alternative,
    encoding: alternative.encoding.map(markRule),
  }));

  return { ...marked, body: { ...operation.body, alternatives } };
};

// The marked model with the scalar marker added to `created` and `filter`, on the query parameters
// and the form properties, round-tripped through the model's encoded form as `unmark` is.
const markScalars = (api: Api): Api => {
  const encoded = Schema.encodeSync(Api)(api);

  return Schema.decodeUnknownSync(Api)({
    ...encoded,
    operations: encoded.operations.map(markOperation),
  });
};

const generated = await Effect.runPromise(
  Effect.gen(function* generated() {
    const resolution = yield* resolve({ document, line: "3.1", value: spec });
    const { api: markedApi } = yield* normalize(resolution, {
      checkFindings: [],
      config,
      configDocument,
    });
    const off = yield* normalize(resolution, {
      checkFindings: [],
      config: configOff,
      configDocument,
    });
    const schemas = yield* normalizeSchemas(resolution);
    const planOf = (model: Api) => planNames(model, { config, configDocument, strict: false });
    const context = { config, configDocument, document, openapi: markedApi.openapi };
    const bound = (servers: readonly Server[]) => boundOrigins(servers, context).origins;
    const roots = markedApi.operations.flatMap((operation) =>
      (operation.body?.alternatives ?? []).flatMap((alternative) =>
        alternative.schema === undefined ? [] : [alternative.schema.key],
      ),
    );
    const domain = yield* emitDomainSchemas(
      schemas.validation.definitions,
      roots,
      (yield* planOf(markedApi)).domain,
    );
    // The name plan carries each command's operation, so each model is planned on its own.
    const emitOf = (model: Api) =>
      Effect.gen(function* emitModel() {
        return yield* emitApi({ api: model, boundOrigins: bound, plan: yield* planOf(model) });
      });
    const plainApi = unmark(markedApi);
    const scalarApi = markScalars(markedApi);
    const cliOf = (model: Api) =>
      Effect.gen(function* cliModel() {
        const emitted = yield* emitCli({
          api: model,
          config,
          plan: yield* planOf(model),
          validationEdits: [],
        });

        return emitted.files;
      });

    const cli = yield* emitCli({
      api: markedApi,
      config,
      plan: yield* planOf(markedApi),
      validationEdits: [],
    });

    return {
      cli: cli.files,
      domain,
      marked: yield* emitOf(markedApi),
      off: { diagnostics: off.diagnostics, files: yield* emitOf(off.api) },
      plain: yield* emitOf(plainApi),
      scalars: { api: yield* emitOf(scalarApi), cli: yield* cliOf(scalarApi) },
    };
  }),
);

const items = (files: readonly EmittedFile[]): string =>
  files.find((file) => file.path === "src/api/items.ts")?.content ?? "";

const lines = (text: string, needle: string): readonly string[] =>
  text.split("\n").filter((line) => line.includes(needle));

// The emitted call that starts with `head`, through its closing `})`, whatever its line layout.
const callOf = (text: string, head: string): string => {
  const start = text.indexOf(head);

  return start === -1 ? "" : text.slice(start, text.indexOf("})", start) + 2);
};

// The text with every `brackets: true` option removed, line layout and trailing commas aside: the
// printer may wrap a call once its options grow.
const withoutBrackets = (text: string): string =>
  text
    .replaceAll(/brackets: true,\s*/gu, "")
    .replaceAll(/\s+/gu, "")
    .replaceAll(/,(?<close>[}\]])/gu, "$<close>");

describe("emitApi: the non-standard bracket marker", () => {
  test("a marked deepObject query parameter emits brackets: true", () => {
    const text = items(generated.marked);

    expect(callOf(text, 'Serialize.deepObject("filter"')).toContain("brackets: true");
    expect(callOf(text, 'Serialize.deepObject("expand"')).toContain("brackets: true");
    expect(callOf(text, 'Serialize.form("page"')).toContain("explode: true");
    expect(callOf(text, 'Serialize.form("page"')).not.toContain("brackets");
  });

  test("a marked form property emits brackets: true, lone and among alternatives", () => {
    const entries = lines(items(generated.marked), '["filter", {');

    expect(entries.length).toBe(2);
    expect(lines(items(generated.marked), '["expand", {').length).toBe(2);
    for (const entry of [...entries, ...lines(items(generated.marked), '["expand", {')]) {
      expect(entry).toContain("brackets: true");
      expect(entry).toContain('style: "deepObject"');
    }
  });

  test("the marker adds brackets: true and nothing else", () => {
    expect(items(generated.marked).match(/brackets: true/gu)?.length).toBe(6);
    expect(withoutBrackets(items(generated.marked))).toBe(withoutBrackets(items(generated.plain)));
  });

  // Watch item N2 (memo 8573fad5): a marked array of scalars repeats, like any scalar-array flag,
  // and the runtime sends its items as `expand[0]=a&expand[1]=b`; a marked nested object is the
  // JSON flag object parameters use. Effect's help prints a repeatable flag as `--expand string`.
  test("a marked scalar array is a repeatable flag and a nested object a JSON flag", () => {
    const cli = generated.cli.find((file) => file.path === "src/cli/items.ts")?.content ?? "";

    expect(
      cli.match(/expand: Flag\.String\("expand"\)\.pipe\(Flag\.atLeast\(0\)\)/gu)?.length,
    ).toBe(3);
    expect(cli).toContain('filter: Input.jsonFlag("filter").pipe(Flag.withMetavar("json")');
    expect(cli).toContain('"query expand; non-standard: sent as name[a][b]=v');
    expect(cli).toContain('"body /expand; non-standard: sent as name[a][b]=v');
  });

  test("unmarked entries emit no brackets", () => {
    expect(items(generated.plain)).toContain('Serialize.deepObject("filter"');
    for (const file of generated.plain) {
      expect(file.content).not.toContain("brackets");
    }
  });

  test("the switch off refuses every nested deepObject entry and marks none", () => {
    const refused = generated.off.diagnostics
      .filter((diagnostic) => diagnostic.code === "PRM-27/compound-nested")
      .map((diagnostic) => diagnostic.pointer.split("/").slice(0, 4).join("/"));

    expect(Arr.sort(Arr.dedupe(refused), Order.String)).toEqual([
      "/paths/~1choices/post",
      "/paths/~1forms/post",
      "/paths/~1items/get",
    ]);
    for (const file of generated.off.files) {
      expect(file.content).not.toContain("brackets");
    }
  });
});

const cliItems = (files: readonly EmittedFile[]): string =>
  files.find((file) => file.path === "src/cli/items.ts")?.content ?? "";

// The text with every `scalars: true` option removed, as `withoutBrackets` removes brackets.
const withoutScalars = (text: string): string =>
  withoutBrackets(text.replaceAll(/scalars: true,\s*/gu, ""));

describe("emitApi and emitCli: the non-standard scalar marker (design 6.1 Scalar switch)", () => {
  test("a scalar-marked deepObject query parameter emits scalars: true and the JSON flag", () => {
    const call = callOf(items(generated.scalars.api), 'Serialize.deepObject("created"');

    expect(call).toContain("scalars: true");
    expect(call).not.toContain("brackets");
    expect(cliItems(generated.scalars.cli)).toContain(
      'created: Input.jsonFlag("created").pipe(Flag.withMetavar("json")',
    );
  });

  test("a deepObject entry marked by both switches emits brackets: true and scalars: true", () => {
    const text = items(generated.scalars.api);
    const call = callOf(text, 'Serialize.deepObject("filter"');

    expect(call).toContain("brackets: true");
    expect(call).toContain("scalars: true");
    expect(lines(text, '["filter", {').length).toBe(2);
    for (const entry of lines(text, '["filter", {')) {
      expect(entry).toContain("brackets: true");
      expect(entry).toContain("scalars: true");
    }
  });

  test("a scalar-marked form property emits scalars: true and one JSON-valued body field flag", () => {
    const entries = lines(items(generated.scalars.api), '["created", {');

    expect(entries.length).toBe(2);
    for (const entry of entries) {
      expect(entry).toContain("scalars: true");
      expect(entry).not.toContain("brackets");
    }

    // Unmarked, the form alternatives of `forms-create` and `choices-create` and the JSON one of
    // `choices-create` send `--created.gt`; marked, only the JSON alternative does, and the query
    // parameter and both form alternatives take `--created` as JSON.
    const dotted = /"\/created\/gt": flags\.createdGt/gu;
    expect(cliItems(generated.cli).match(dotted)?.length).toBe(3);
    expect(cliItems(generated.scalars.cli).match(dotted)?.length).toBe(1);
    expect(cliItems(generated.scalars.cli).match(/"\/created": flags\.created,/gu)?.length).toBe(2);
    expect(cliItems(generated.scalars.cli).match(/Input\.jsonFlag\("created"\)/gu)?.length).toBe(3);
  });

  test("the marker adds scalars: true and nothing else", () => {
    const text = items(generated.scalars.api);

    expect(text.match(/scalars: true/gu)?.length).toBe(6);
    expect(withoutScalars(text)).toBe(withoutBrackets(items(generated.marked)));
  });

  test("entries without the scalar marker emit no scalars option", () => {
    for (const file of [...generated.marked, ...generated.plain]) {
      expect(file.content).not.toContain("scalars");
    }
  });
});

// The scalar-marked modules, which carry every bracket marker too, and the runtime, written under
// the worktree's git-ignored `work/` and type-checked together: the emitted options satisfy
// `QueryOptions` and `FormEncoding`.
const scratch = nodePath.join(root, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "bracket-mode-"));

afterAll(() => {
  nodeFs.rmSync(work, { force: true, recursive: true });
});

describe("emitApi: the marked options against the runtime types", () => {
  test("the emitted modules type-check", async () => {
    const scaffold = await Effect.runPromise(
      emitPackageFiles(config, {
        packageJson: decodeJson(generatorPackage),
        tsconfig: decodeJson(generatorTsconfig),
      }),
    );
    const files: readonly EmittedFile[] = [
      generated.domain,
      ...generated.scalars.api,
      ...Object.entries(runtimeFiles).map(([key, content]) => ({ content, path: `src/${key}` })),
      {
        content: scaffold.find((file) => file.path === "tsconfig.json")?.content ?? "",
        path: "tsconfig.json",
      },
    ];
    for (const file of files) {
      const target = nodePath.join(work, ...file.path.split("/"));
      nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true });
      nodeFs.writeFileSync(target, file.content);
    }

    nodeFs.symlinkSync(nodePath.join(root, "node_modules"), nodePath.join(work, "node_modules"));

    const tsc = nodePath.join(root, "node_modules/.bin/tsc");
    const result = Bun.spawnSync([tsc, "--noEmit", "-p", nodePath.join(work, "tsconfig.json")], {
      cwd: work,
    });

    expect(new TextDecoder().decode(result.stdout)).toBe("");
    expect(result.exitCode).toBe(0);
  }, 120_000);
});
