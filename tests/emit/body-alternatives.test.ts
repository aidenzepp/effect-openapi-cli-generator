import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { generateFixture } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// Design 6.6 and the em9 ruling: a body with several media alternatives is offered whole behind
// `--content-type`. The fixture holds a Discord-shaped `json + form + multipart` body, an
// OpenAI-shaped `multipart + json` body (multipart first), `json + binary`, and `json + ndjson +
// text`; none is refused. A form or multipart alternative among several is encoded per key by
// `Serialize.alternatives`; a lone builder prints as it did before (C16).

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

const fixture = nodePath.join(repoRoot, "tests/fixtures/body-alternatives");

// Generated packages live under the worktree's git-ignored `work/`, never the system temp directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "body-alternatives-"));

const priorTmpdir = process.env.TMPDIR;

process.env.TMPDIR = work;

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const scope = Effect.runSync(Scope.make());

let generated: GeneratedPackage | undefined;

beforeAll(async () => {
  generated = await Effect.runPromise(
    generateFixture({
      configPath: nodePath.join(fixture, "author-config.json"),
      specPath: nodePath.join(fixture, "openapi.json"),
    }).pipe(Scope.provide(scope), Effect.provide(layer)),
  );
}, 120_000);

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  nodeFs.rmSync(work, { force: true, recursive: true });
  process.env.TMPDIR = priorTmpdir;
});

const file = (path: string): string => {
  if (generated === undefined) {
    throw new Error("the body-alternatives package was not generated");
  }

  return nodeFs.readFileSync(nodePath.join(generated.dir, path), "utf-8");
};

const Report = Schema.Struct({
  notices: Schema.Array(Schema.Struct({ code: Schema.String })),
  refusals: Schema.Array(Schema.Struct({ code: Schema.String, pointer: Schema.String })),
});

const groups = ["events", "files", "images", "lone", "messages"];

describe("body alternatives: generation", () => {
  test("no operation is refused and no notice is reported", () => {
    const report = Schema.decodeUnknownSync(Schema.fromJsonString(Report))(
      file("generation-report.json"),
    );

    expect(report.refusals).toEqual([]);
    expect(report.notices).toEqual([]);
  });

  test("every group has its cli module", () => {
    for (const group of groups) {
      expect(file(`src/cli/${group}.ts`)).toContain("Command.make(");
    }
  });
});

describe("body alternatives: the api/ builders", () => {
  test("no builder sends a form or multipart body through Serialize.body", () => {
    for (const group of groups) {
      const text = file(`src/api/${group}.ts`);
      expect(text).not.toContain('Serialize.body("multipart/form-data"');
      expect(text).not.toContain('Serialize.body("application/x-www-form-urlencoded"');
    }

    for (const group of ["files", "messages"]) {
      expect(file(`src/api/${group}.ts`)).not.toContain("Serialize.body(input.contentType");
    }
  });

  test("json + form + multipart is a Bodies table dispatched by the chosen key", () => {
    const text = file("src/api/messages.ts");

    expect(text).toContain(
      [
        "export interface CreateBodies {",
        '  readonly "application/json": Serialize.Body;',
        '  readonly "application/x-www-form-urlencoded": Serialize.Json | undefined;',
        '  readonly "multipart/form-data": Serialize.FormFields;',
        "}",
      ].join("\n"),
    );
    expect(text).toContain("  readonly body: Serialize.Chosen<CreateBodies>;");
    expect(text).not.toContain("readonly contentType");
    expect(text).toContain(
      [
        "    body: Serialize.alternatives(input.body, {",
        '      "application/json": (body: Serialize.Body, contentType: "application/json") =>',
        "        Serialize.body(contentType, body),",
        '      "application/x-www-form-urlencoded": (',
        "        body: Serialize.Json | undefined,",
        '        contentType: "application/x-www-form-urlencoded",',
        "      ) =>",
        "        Serialize.urlEncoded(contentType, body, {",
      ].join("\n"),
    );
    expect(text).toContain(
      [
        '      "multipart/form-data": (body: Serialize.FormFields) =>',
        "        Serialize.formData(body, {",
        "          parts: [",
        '            ["content", "text/plain"],',
        '            ["file", "application/octet-stream"],',
        "          ],",
      ].join("\n"),
    );
  });

  test("multipart listed first is still a table entry, not the lone multipart builder", () => {
    const text = file("src/api/files.ts");

    expect(text).toContain("  readonly body: Serialize.Chosen<UploadBodies>;");
    expect(text).toContain("body: Serialize.alternatives(input.body, {");
    expect(text).toContain('"multipart/form-data": (body: Serialize.FormFields) =>');
  });

  test("bytes-only alternatives keep the chosen content type input", () => {
    for (const group of ["events", "images"]) {
      const text = file(`src/api/${group}.ts`);
      expect(text).toContain("body: Serialize.body(input.contentType, input.body),");
      expect(text).not.toContain("Serialize.alternatives(");
    }
  });

  test("the lone json, form and multipart builders print as they did before (C16)", () => {
    expect(file("src/api/lone.ts")).toBe(
      nodeFs.readFileSync(nodePath.join(fixture, "expected/api-lone.ts.txt"), "utf-8"),
    );
  });
});

describe("body alternatives: the cli/ table", () => {
  test("every alternative is a selectBody entry, with each key's foreign flags", () => {
    const text = file("src/cli/messages.ts");

    expect(text).toContain('"application/x-www-form-urlencoded": Input.structuredBody({');
    expect(text).toContain('"multipart/form-data": Effect.all({');
    expect(text).toContain(
      [
        "      foreign: {",
        '        "application/json": { file: Option.isSome(flags.file) },',
        '        "application/x-www-form-urlencoded": { file: Option.isSome(flags.file) },',
        '        "multipart/form-data": {',
        "          body: Option.isSome(flags.body),",
        '          "body-file": Option.isSome(flags.bodyFile),',
        "          ids: Option.isSome(Option.fromIterable(flags.ids)),",
        "          tags: Option.isSome(Option.fromIterable(flags.tags)),",
        "        },",
        "      },",
      ].join("\n"),
    );
    expect(text).toContain("Messages.create({ body: selected, id: flags.id })");
  });

  test("text and sequential alternatives beside JSON are Input.sequentialBody entries", () => {
    const text = file("src/cli/events.ts");

    expect(text).toContain('"application/x-ndjson": Input.sequentialBody({');
    expect(text).toContain('"text/plain": Input.sequentialBody({');
    expect(text).toContain(
      "Events.send({ body: selected.body, contentType: selected.contentType })",
    );
  });
});
