import { afterAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunCrypto, BunFileSystem, BunPath, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { Command } from "effect/cli";
import type { Flag } from "effect/cli";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

// m2-dpany: Stripe's `created` query parameter is deepObject over `anyOf [object, integer]`. It
// generated a string flag that the runtime refused for every value, `--created 5` and
// `--created '{"gt":1}'` alike. deepObject is defined only for an object (style-values), so a
// deepObject whose schema admits a value that is not an object is refused at generation
// (PRM-27/non-object-schema), with the bracket switch on or off; one whose anyOf members are all
// objects is still generated. Runs `generate` in process; nothing is installed or built.
//
// m2-objfact: that all-object anyOf, or oneOf, is object-valued, so it takes JSON like a `type:
// object` schema does; it was emitted as a string flag the runtime refused for every value.

const root = nodePath.resolve(import.meta.dir, "../..");

const scratch = nodePath.join(root, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "dpany-"));

afterAll(() => {
  nodeFs.rmSync(work, { force: true, recursive: true });
});

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layerDigest);

const decodeUri = Schema.decodeUnknownSync(DocumentUri);

const range: Schema.Json = {
  properties: {
    gt: { type: "integer" },
    gte: { type: "integer" },
    lt: { type: "integer" },
    lte: { type: "integer" },
  },
  type: "object",
};

const deep = (name: string, schema: Schema.Json, required = false) => ({
  explode: true,
  in: "query",
  name,
  required,
  schema,
  style: "deepObject",
});

const ok = { "200": { description: "ok" } };

const spec = {
  info: { title: "Deep any", version: "1.0.0" },
  openapi: "3.0.3",
  paths: {
    "/charges": {
      get: {
        operationId: "charges-list",
        parameters: [
          deep("created", { anyOf: [range, { type: "integer" }] }),
          deep("window", { anyOf: [range, { properties: { at: { type: "string" } } }] }),
          deep("span", { oneOf: [range, { properties: { at: { type: "string" } } }] }),
        ],
        responses: ok,
      },
    },
    "/events": {
      get: {
        operationId: "events-list",
        parameters: [deep("created", { anyOf: [range, { type: "integer" }] }, true)],
        responses: ok,
      },
    },
  },
  servers: [{ url: "https://api.example.com" }],
};

interface Switches {
  readonly deepObjectBrackets?: boolean;
  readonly deepObjectScalars?: boolean;
}

const runWith = (nonStandard: Switches) =>
  Effect.runPromise(
    Effect.gen(function* run() {
      const dir = nodeFs.mkdtempSync(nodePath.join(work, "run-"));
      const specPath = nodePath.join(dir, "openapi.json");
      const configPath = nodePath.join(dir, "author-config.json");
      const outDir = nodePath.join(dir, "out");
      nodeFs.writeFileSync(specPath, JSON.stringify(spec));
      nodeFs.writeFileSync(
        configPath,
        JSON.stringify({
          binName: "dpany",
          envPrefix: "DPANY",
          nonStandard,
          package: { name: "dpany-cli", version: "0.1.0" },
        }),
      );

      const result = yield* generate(
        {
          document: decodeUri("file:///dpany/openapi.json"),
          generator: {
            packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
            tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
          },
          outDir,
          source: { _tag: "File", path: specPath },
          strict: false,
        },
        { document: decodeUri("file:///dpany/author-config.json"), path: configPath },
      );
      const read = (relative: string) => {
        const target = nodePath.join(outDir, ...relative.split("/"));

        return nodeFs.existsSync(target) ? nodeFs.readFileSync(target, "utf-8") : "";
      };

      return {
        api: read("src/api/root.ts"),
        cli: read("src/cli/root.ts"),
        facts: result.diagnostics
          .filter((diagnostic) => diagnostic.row === "PRM-27" || diagnostic.row === "OPR-08")
          .map((diagnostic) => [diagnostic.code, diagnostic.scope, diagnostic.pointer]),
      };
    }).pipe(Effect.provide(layer)),
  );

const runs = {
  off: await runWith({ deepObjectBrackets: false }),
  on: await runWith({ deepObjectBrackets: true }),
};

describe("PRM-27: a deepObject over a schema that admits non-objects", () => {
  for (const [label, run] of Object.entries(runs)) {
    test(`bracket switch ${label}: refused at element scope when optional, operation scope when required`, () => {
      expect(run.facts).toEqual([
        ["PRM-27/non-object-schema", "element", "/paths/~1charges/get/parameters/0"],
        ["OPR-08/required-parameter-refused", "operation", "/paths/~1events/get"],
        ["PRM-27/non-object-schema", "element", "/paths/~1events/get/parameters/0"],
      ]);
    });

    test(`bracket switch ${label}: no created flag or serializer is generated`, () => {
      expect(run.cli).not.toContain('"created"');
      expect(run.api).not.toContain('Serialize.deepObject("created"');
      expect(run.api).not.toContain("events");
    });

    test(`bracket switch ${label}: an anyOf whose members are all objects is still generated`, () => {
      expect(run.api).toContain('Serialize.deepObject("window"');
      expect(run.cli).toContain('"window"');
    });
  }
});

type Parsed = ReturnType<typeof Input.jsonFlag> extends Flag.Flag<infer A> ? A : never;

// The operator's `--window` text through the flag the CLI emits, then through the runtime's
// deepObject serializer, as the generated command hands it on.
const sent = (text: string) =>
  Effect.runPromise(
    Effect.gen(function* send() {
      let seen: Parsed | undefined;
      const command = Command.make("x", { window: Input.jsonFlag("window") }, ({ window }) =>
        Effect.sync(() => {
          seen = window;
        }),
      );
      yield* Command.runWith(command, { version: "0" })(["--window", text]);
      if (seen === undefined) {
        return yield* Effect.die(new Error("expected a parsed --window"));
      }

      const options = { allowReserved: false, explode: true, required: false };

      return yield* Serialize.deepObject("window", seen, options).expand;
    }).pipe(Effect.provide(BunServices.layer)),
  );

describe("m2-objfact: a deepObject over all-object anyOf or oneOf takes JSON", () => {
  for (const [label, run] of Object.entries(runs)) {
    test(`bracket switch ${label}: the anyOf and oneOf flags are JSON flags`, () => {
      expect(run.cli).toContain('window: Input.jsonFlag("window")');
      expect(run.cli).toContain('span: Input.jsonFlag("span")');
      expect(run.cli).not.toContain('Flag.String("window")');
      expect(run.cli).not.toContain('Flag.String("span")');
    });
  }

  test("the JSON flag's object is sent as window[at]=v", async () => {
    expect(await sent('{"at":"v"}')).toBe("window%5Bat%5D=v");
  });
});

// m3-sc5 (design 6.1 Scalar switch): with `nonStandard.deepObjectScalars`, `created`'s integer
// branch is a scalar branch the switch covers, so the parameter is generated, marked and noticed,
// and the operation that requires it is kept; it takes one JSON value.
const scalarRuns = {
  both: await runWith({ deepObjectBrackets: true, deepObjectScalars: true }),
  scalars: await runWith({ deepObjectScalars: true }),
};

describe("PRM-27 scalar switch: a deepObject over anyOf of an object and an integer", () => {
  for (const [label, run] of Object.entries(scalarRuns)) {
    test(`${label}: generated with the scalar notice, and the required operation kept`, () => {
      expect(run.facts).toEqual([
        ["PRM-27/scalar-author-choice", "element", "/paths/~1charges/get/parameters/0"],
        ["PRM-27/scalar-author-choice", "element", "/paths/~1events/get/parameters/0"],
      ]);
      expect(run.api).toContain('Serialize.deepObject("created"');
      expect(run.api).toContain("scalars: true");
      expect(run.api).toContain("events");
    });

    test(`${label}: created takes one JSON flag`, () => {
      expect(run.cli).toContain('created: Input.jsonFlag("created")');
      expect(run.cli).not.toContain('Flag.String("created")');
    });
  }
});
