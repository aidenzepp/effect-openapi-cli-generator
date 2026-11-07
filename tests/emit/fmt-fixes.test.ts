import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import {
  Cause,
  Console,
  Effect,
  Exit,
  Layer,
  Option,
  Result,
  Runtime,
  Schema,
  Sink,
  Stdio,
  Stream,
} from "effect";
import { CliOutput, Command, Flag } from "effect/cli";
import { constVoid } from "effect/Function";
import type { HttpBody } from "effect/http";
import { emitCli } from "../../src/emit/cli.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { planNames } from "../../src/names/index.ts";
import { flattenBody } from "../../src/names/flatten.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

// The format fixes of m2-fmtfx: a 3.1 or 3.2 `format: byte` property is a plain string flag sent
// as given, base64 handling staying with 3.0 `format: byte` and `contentEncoding` (FMT-10); and a
// number or integer body field sent as the operator's text, checked against its grammar (FMT-04).

type Line = "3.0" | "3.1" | "3.2";

const versions: Record<Line, string> = { "3.0": "3.0.4", "3.1": "3.1.1", "3.2": "3.2.0" };

const document = Schema.decodeUnknownSync(DocumentUri)("file:///fmt/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///fmt/author-config.json");

const config: Schema.Json = {
  binName: "fmt",
  envPrefix: "FMT",
  package: { name: "fmt-cli", version: "1.0.0" },
  servers: { accepted: ["https://api.example.com"] },
};

type Properties = Readonly<Record<string, Schema.Json>>;

const spec = (line: Line, properties: Properties): Schema.Json => ({
  info: { title: "Fmt", version: "1.0.0" },
  openapi: versions[line],
  paths: {
    "/items": {
      post: {
        operationId: "items-create",
        requestBody: {
          content: { "application/json": { schema: { properties, type: "object" } } },
          required: true,
        },
        responses: { "204": { description: "Created." } },
        tags: ["items"],
      },
    },
  },
});

// The formatter may break lines; the structure is what the test pins.
const squeezed = (text: string): string => text.replaceAll(/\s+/gu, " ");

// The emitted `items` module, squeezed, and the emit refusals.
const emitted = (line: Line, properties: Properties) =>
  Effect.runPromise(
    Effect.gen(function* generate() {
      const author = yield* decodeAuthorConfig(config, { document: configDocument });
      const resolution = yield* resolve({ document, line, value: spec(line, properties) });
      const { api } = yield* normalize(resolution, {
        checkFindings: [],
        config: author,
        configDocument,
      });
      const plan = yield* planNames(api, { config: author, configDocument, strict: false });
      const output = yield* emitCli({ api, config: author, plan, validationEdits: [] });
      const content = output.files.find((file) => file.path === "src/cli/items.ts")?.content;

      return { content: squeezed(content ?? ""), refusals: output.refusals };
    }),
  );

const kinds = (line: Line, properties: Properties) => {
  const result = flattenBody(
    { Root: { properties, type: "object" } },
    { codec: "json", schema: { key: "Root" } },
    line,
  );
  if (Result.isFailure(result)) {
    throw new Error(`flattenBody failed with ${result.failure._tag}`);
  }

  return Object.fromEntries(result.success.flags.map((flag) => [flag.name, flag.kind]));
};

// The emitted number and safe-integer field flags, run in process the way the generated command
// runs them: the parsed flag values become the JSON body's fields. `seen` holds each merged body.
const numberFlags = {
  count: Input.numericFlag("count", "integer").pipe(
    Flag.map((text) => new Input.JsonNumber(text)),
    Flag.optional,
  ),
  ratio: Input.numericFlag("ratio", "number").pipe(
    Flag.map((text) => new Input.JsonNumber(text)),
    Flag.optional,
  ),
};

const decoder = new TextDecoder();

const bodyText = (body: HttpBody.HttpBody): string =>
  body._tag === "Uint8Array" ? decoder.decode(body.body) : "";

// Help and errors print through `Console`; the test reads only the exit code and the bodies.
// Object.assign keeps the host console methods; spreading a Console instance drops its prototype.
// oxlint-disable-next-line prefer-object-spread
const silent: Console.Console = Object.assign({}, globalThis.console, {
  error: constVoid,
  log: constVoid,
});

const sent = (args: readonly string[]) =>
  Effect.runPromise(
    Effect.suspend(() => {
      const seen: string[] = [];
      const command = Command.make("create", numberFlags, (flags) =>
        Input.mergeBody({
          body: Option.none(),
          bodyFile: Option.none(),
          fields: { "/count": flags.count, "/ratio": flags.ratio },
          required: true,
          schema: Schema.Struct({
            count: Schema.optionalKey(Schema.Number),
            ratio: Schema.optionalKey(Schema.Number),
          }),
        }).pipe(
          Effect.flatMap((body) =>
            Effect.sync(() => {
              seen.push(bodyText(body));
            }),
          ),
        ),
      );

      return Command.runWith(command, { renderErrors: false, version: "0" })(args).pipe(
        Output.exitForHelp,
        Output.finalCatch([]),
        Effect.provide(
          Layer.mergeAll(
            Stdio.layerTest({ stderr: () => Sink.drain, stdout: () => Sink.drain }),
            Output.runCredentialsLayer,
            Input.stdinClaimLayer,
          ),
        ),
        Effect.provide(CliOutput.layer(Output.valueFreeFormatter)),
        Effect.provide(CliOutput.layerPresenter(Output.presenter)),
        Effect.provide(BunServices.layer),
        Effect.provideService(Console.Console, silent),
        Effect.exit,
        Effect.map((exit) => ({
          code: Exit.isSuccess(exit) ? 0 : Runtime.getErrorExitCode(Cause.squash(exit.cause)),
          seen,
        })),
      );
    }),
  );

const multipartText = async (fields: Serialize.FormFields): Promise<string> => {
  const built = await Effect.runPromise(
    Serialize.request("POST", {
      body: Serialize.formData(fields, { parts: [["ratio", "text/plain"]], required: true }),
      headers: [],
      path: Serialize.path("/items", []),
      query: [],
    }),
  );
  if (built.body._tag !== "Stream") {
    throw new Error(`expected a stream body, got ${built.body._tag}`);
  }

  const chunks = await Effect.runPromise(Stream.runCollect(built.body.stream));

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");
};

describe("FMT-04 number and integer JSON body fields", () => {
  test("a number and a safe integer are Input.numericFlag carried as a JsonNumber; int64 stays Input.int64Flag", async () => {
    const { content, refusals } = await emitted("3.1", {
      count: { type: "integer" },
      ratio: { type: "number" },
      total: { format: "int64", type: "integer" },
    });
    const asJsonNumber = "Flag.map((text) => new Input.JsonNumber(text))";

    expect(refusals).toEqual([]);
    expect(content).toContain(
      `ratio: Input.numericFlag("ratio", "number").pipe( ${asJsonNumber}, Flag.optional, )`,
    );
    expect(content).toContain(
      `count: Input.numericFlag("count", "integer").pipe( ${asJsonNumber}, Flag.optional, )`,
    );
    expect(content).toContain('total: Input.int64Flag("total").pipe(Flag.optional)');
    expect(content).not.toContain("Flag.Int(");
    expect(content).not.toContain("Flag.Finite(");
  });

  test("--ratio 0.10000000000000000001 is sent with every digit", async () => {
    const run = await sent(["--ratio", "0.10000000000000000001", "--count", "-7"]);

    expect(run).toEqual({ code: 0, seen: ['{"count":-7,"ratio":0.10000000000000000001}'] });
  });

  test("a safe integer takes the integer grammar: --count 1e2 exits 2 and sends nothing", async () => {
    expect(await sent(["--count", "1e2"])).toEqual({ code: 2, seen: [] });
    expect(await sent(["--count", "1.0"])).toEqual({ code: 2, seen: [] });
  });

  test("a multipart number part sends its text unchanged", async () => {
    const ratio = new Input.JsonNumber("0.10000000000000000001");
    const fields = await Effect.runPromise(
      Serialize.assertFormData({
        flags: { ratio: "ratio" },
        repeated: [],
        required: true,
        schema: Schema.Struct({ ratio: Schema.Number }),
      })({ ratio: [ratio] }),
    );

    expect(await multipartText(fields)).toContain("\r\n\r\n0.10000000000000000001\r\n--");
  });
});

describe("FMT-10 format: byte on 3.1 and 3.2 is a plain string", () => {
  const properties = {
    encoded: { format: "byte", type: "string" },
    tagged: { contentEncoding: "base64", type: "string" },
  } satisfies Properties;

  test("3.0 byte is a file flag; 3.1 and 3.2 byte is a string flag", () => {
    expect(kinds("3.0", properties)).toMatchObject({ encoded: "file", tagged: "file" });
    expect(kinds("3.1", properties)).toMatchObject({ encoded: "string", tagged: "file" });
    expect(kinds("3.2", properties)).toMatchObject({ encoded: "string", tagged: "file" });
  });

  test.each(["3.1", "3.2"] as const)(
    "%s byte is Flag.String sent as given; contentEncoding base64 stays a FileField",
    async (line) => {
      const { content, refusals } = await emitted(line, properties);
      expect(refusals).toEqual([]);
      expect(content).toContain('Flag.String("encoded")');
      expect(content).toContain('"/encoded": flags.encoded');
      expect(content).not.toContain('flag: "encoded"');
      expect(content).toContain('new Input.FileField({ encoding: "base64", flag: "tagged"');
    },
  );

  test("3.0 byte stays a base64 FileField", async () => {
    const { content } = await emitted("3.0", { encoded: { format: "byte", type: "string" } });
    expect(content).toContain('new Input.FileField({ encoding: "base64", flag: "encoded"');
  });

  test("format: binary on 3.1 is unchanged (BIN-05)", () => {
    expect(kinds("3.1", { blob: { format: "binary", type: "string" } })).toMatchObject({
      blob: "string",
    });
  });
});
