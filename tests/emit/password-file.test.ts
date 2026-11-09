import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Cause, Console, Effect, Exit, Layer, Runtime, Schema, Sink, Stdio } from "effect";
import { CliOutput, Command, Flag } from "effect/cli";
import { constVoid } from "effect/Function";
import { emitCli } from "../../src/emit/cli.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";

// m3-pw1b: the V1 cli emitter builds the `secret-file` field flag m3-pw1a plans for a flattened
// `format: password` string property (design 13.1 R4): `--<prop>-file` through the m3-pw2 helper,
// its value wrapped as an `Input.SecretField` so the runtime reads it from a file or stdin.
// m3-pw1h: the flag's help carries the property's sanitized description, then the helper's note.
// m3-pwmh: a multipart `format: password` part (a file part, ruling DR4) gets the same help: the
// `path|-` metavar, the sanitized description and the never-echoed note, through Input.secretPartFlag.

const document = Schema.decodeUnknownSync(DocumentUri)("file:///pw/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///pw/author-config.json");

const config: Schema.Json = {
  binName: "pw",
  envPrefix: "PW",
  package: { name: "pw-cli", version: "1.0.0" },
  servers: { accepted: ["https://api.example.com"] },
};

const plainPassword: Schema.Json = { format: "password", type: "string" };

// The spec, its `password` property replaced when a test gives one.
const specWith = (password: Schema.Json = plainPassword): Schema.Json => ({
  info: { title: "Pw", version: "1.0.0" },
  openapi: "3.1.1",
  paths: {
    "/users": {
      post: {
        operationId: "users-create",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                properties: {
                  name: { type: "string" },
                  password,
                  passwords: { items: { format: "password", type: "string" }, type: "array" },
                },
                type: "object",
              },
            },
          },
          required: true,
        },
        responses: { "204": { description: "Created." } },
        tags: ["users"],
      },
    },
  },
});

// A multipart/form-data body whose `secret` part is the given schema.
const multipartWith = (secret: Schema.Json = plainPassword): Schema.Json => ({
  info: { title: "Pw", version: "1.0.0" },
  openapi: "3.1.1",
  paths: {
    "/users": {
      post: {
        operationId: "users-create",
        requestBody: {
          content: {
            "multipart/form-data": {
              schema: {
                properties: { name: { type: "string" }, secret },
                type: "object",
              },
            },
          },
          required: true,
        },
        responses: { "204": { description: "Created." } },
        tags: ["users"],
      },
    },
  },
});

// The formatter may break lines; the structure is what the test pins.
const squeezed = (text: string): string => text.replaceAll(/\s+/gu, " ");

// The emitted `users` module, squeezed, and the emit refusals.
const emittedFrom = (spec: Schema.Json) =>
  Effect.runPromise(
    Effect.gen(function* generate() {
      const author = yield* decodeAuthorConfig(config, { document: configDocument });
      const resolution = yield* resolve({ document, line: "3.1", value: spec });
      const { api } = yield* normalize(resolution, {
        checkFindings: [],
        config: author,
        configDocument,
      });
      const plan = yield* planNames(api, { config: author, configDocument, strict: false });
      const output = yield* emitCli({ api, config: author, plan, validationEdits: [] });
      const content = output.files.find((file) => file.path === "src/cli/users.ts")?.content;

      return { content: squeezed(content ?? ""), refusals: output.refusals };
    }),
  );

const emitted = (password?: Schema.Json) => emittedFrom(specWith(password));

// Help prints through `Console`; the test reads the exit code and the printed text.
// Object.assign keeps the host console methods; spreading a Console instance drops its prototype.
// oxlint-disable-next-line prefer-object-spread
const silent: Console.Console = Object.assign({}, globalThis.console, {
  error: constVoid,
  log: constVoid,
});

// `--help` of a command whose one flag is `flag`, run in process.
const helpOf = (flag: Flag.Flag<unknown>) =>
  Effect.runPromise(
    Effect.suspend(() => {
      const printed: string[] = [];
      // oxlint-disable-next-line prefer-object-spread
      const recording: Console.Console = Object.assign({}, silent, {
        log: (...parts: readonly unknown[]) => {
          printed.push(parts.join(" "));
        },
      });
      const command = Command.make("create", { flag }, () => Effect.void);

      return Command.runWith(command, { renderErrors: false, version: "0" })(["--help"]).pipe(
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
        Effect.provideService(Console.Console, recording),
        Effect.exit,
        Effect.map((exit) => ({
          code: Exit.isSuccess(exit) ? 0 : Runtime.getErrorExitCode(Cause.squash(exit.cause)),
          printed: squeezed(printed.join("\n")),
        })),
      );
    }),
  );

// `--help` of a command whose one flag is the emitted secret-file flag.
const help = (description?: string) =>
  helpOf(
    description === undefined
      ? Input.secretFileFlag("password-file")
      : Input.secretFileFlag("password-file", description),
  );

describe("m3-pw1b secret-file field flag", () => {
  test("a format password property is --password-file through Input.secretFileFlag, never --password", async () => {
    const { content, refusals } = await emitted();

    expect(refusals).toEqual([]);
    expect(content).toContain('Input.secretFileFlag("password-file"),');
    expect(content).not.toMatch(/Input\.secretFileFlag\("password-file"\)\.pipe/u);
    expect(content).not.toMatch(/\("password"/u);
    expect(content).toContain('Flag.String("name")');
  });

  test("the flag's value is wrapped as an Input.SecretField at the property's pointer", async () => {
    const { content } = await emitted();

    expect(content).toMatch(
      /"\/password": Option\.map\( flags\.\w+, \(path\) => new Input\.SecretField\(\{ flag: "password-file", path: path \}\), \)/u,
    );
  });

  test("an array of password strings has no flag", async () => {
    const { content } = await emitted();

    expect(content).not.toContain('"passwords');
    expect(content).not.toContain('"/passwords"');
  });

  test("help for the flag says the value is read from a file or stdin", async () => {
    const { code, printed } = await help();

    expect(code).toBe(0);
    expect(printed).toContain("--password-file path|-");
    expect(printed).toContain("Read the value from a file or stdin");
  });

  test("secret-file flag help carries the property description", async () => {
    const { content, refusals } = await emitted({
      description: "The account password.",
      format: "password",
      type: "string",
    });

    expect(refusals).toEqual([]);
    expect(content).toMatch(
      /Input\.secretFileFlag\( ?"password-file", "The account password\.",? ?\)/u,
    );

    const { code, printed } = await help("The account password.");
    const described = printed.indexOf("The account password.");

    expect(code).toBe(0);
    expect(described).toBeGreaterThanOrEqual(0);
    expect(printed.indexOf("Read the value from a file or stdin")).toBeGreaterThan(described);
  });

  test("a hostile property description is sanitized before it reaches the flag", async () => {
    const { content } = await emitted({
      description: "The\u001B[31m account\u202E password.",
      format: "password",
      type: "string",
    });

    expect(content).toMatch(
      /Input\.secretFileFlag\( ?"password-file", "The\[31m account password\.",? ?\)/u,
    );
    expect(content).not.toContain("\u001B");
    expect(content).not.toContain("\u202E");
  });

  test("a property without a description emits today's call", async () => {
    const { content } = await emitted({ description: "", format: "password", type: "string" });

    expect(content).toContain('Input.secretFileFlag("password-file"),');
  });
});

describe("m3-pwmh multipart password part flag", () => {
  test("a format password part is --secret through Input.secretPartFlag, not a bare path flag", async () => {
    const { content, refusals } = await emittedFrom(multipartWith());

    expect(refusals).toEqual([]);
    expect(content).toMatch(/Input\.secretPartFlag\("secret"\)\.pipe\( ?Flag\.optional,? ?\)/u);
    expect(content).not.toContain('Flag.String("secret")');
    expect(content).toContain('Flag.String("name")');
  });

  test("the part carries the property's sanitized description", async () => {
    const { content, refusals } = await emittedFrom(
      multipartWith({
        description: "The\u001B[31m account\u202E secret.",
        format: "password",
        type: "string",
      }),
    );

    expect(refusals).toEqual([]);
    expect(content).toMatch(
      /Input\.secretPartFlag\( ?"secret", "The\[31m account secret\.",? ?\)\.pipe\( ?Flag\.optional,? ?\)/u,
    );
    expect(content).not.toContain("\u001B");
    expect(content).not.toContain("\u202E");
  });

  test("a binary part keeps its plain path flag", async () => {
    const { content } = await emittedFrom(multipartWith({ format: "binary", type: "string" }));

    expect(content).toContain('Flag.String("secret")');
    expect(content).not.toContain("Input.secretPartFlag");
  });

  test("help for the part shows path|-, the description, then the never-echoed note", async () => {
    const { code, printed } = await helpOf(
      Input.secretPartFlag("secret", "The account secret.").pipe(Flag.optional),
    );
    const described = printed.indexOf("The account secret.");

    expect(code).toBe(0);
    expect(printed).toContain("--secret path|-");
    expect(described).toBeGreaterThanOrEqual(0);
    expect(
      printed.indexOf("Read the value from a file or stdin (-); it is never echoed"),
    ).toBeGreaterThan(described);
  });
});
