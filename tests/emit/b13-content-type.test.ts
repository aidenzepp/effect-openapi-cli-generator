import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { emitApi } from "../../src/emit/api.ts";
import { emitCli } from "../../src/emit/cli.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Server } from "../../src/model/entities.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { boundOrigins } from "../../src/normalize/servers.ts";
import { resolve } from "../../src/resolve/index.ts";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { RecordedRequest } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { BinRun, GeneratedPackage } from "../support/generated-cli.ts";

// ENC-10 (design 6.3): a multipart part whose Encoding `contentType` lists several media types
// gets a `--<part>-content-type` choice flag over them, with no sniffing default. The part is
// sent under the chosen type; a sent part without the flag, and the flag without its part, are
// usage errors before any connection. The `api/` builder takes the chosen type with the part's
// values, so a call without the part names no type. The package's own install, `tsc` and build
// prove that shape against the runtime, with `builderCheck` among its sources.

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const configJson = decodeJson({
  binName: "pics",
  envPrefix: "PICS",
  package: { name: "pics-cli", version: "0.1.0" },
  servers: { accepted: ["https://api.example.com"] },
});

// One `POST /uploads` operation: an optional `file` part typed `image/png` or `image/jpeg`, and a
// required `title` part.
const spec: Schema.Json = {
  info: { title: "Pictures", version: "1.0.0" },
  openapi: "3.1.0",
  paths: {
    "/uploads": {
      post: {
        operationId: "uploads-create",
        requestBody: {
          content: {
            "multipart/form-data": {
              encoding: { file: { contentType: "image/png, image/jpeg" } },
              schema: {
                properties: {
                  file: { contentMediaType: "application/octet-stream", type: "string" },
                  title: { type: "string" },
                },
                required: ["title"],
                type: "object",
              },
            },
          },
          required: true,
        },
        responses: { "204": { description: "stored" } },
        tags: ["uploads"],
      },
    },
  },
  servers: [{ url: "https://api.example.com" }],
  tags: [{ name: "uploads" }],
};

const document = Schema.decodeUnknownSync(DocumentUri)("file:///b13/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///b13/author-config.json");

const config = await Effect.runPromise(
  decodeAuthorConfig(configJson, { document: configDocument }),
);

const emitted = await Effect.runPromise(
  Effect.gen(function* generated() {
    const resolution = yield* resolve({ document, line: "3.1", value: spec });
    const { api } = yield* normalize(resolution, { checkFindings: [], config, configDocument });
    const plan = yield* planNames(api, { config, configDocument, strict: false });
    const context = { config, configDocument, document, openapi: api.openapi };
    const bound = (servers: readonly Server[]) => boundOrigins(servers, context).origins;
    const apiFiles = yield* emitApi({ api, boundOrigins: bound, plan });
    const cli = yield* emitCli({ api, config, plan, validationEdits: [] });
    const [command] = plan.groups.flatMap((group) => group.commands);

    return {
      api: apiFiles.find((file) => file.path === "src/api/uploads.ts")?.content ?? "",
      cli: cli.files.find((file) => file.path === "src/cli/uploads.ts")?.content ?? "",
      flags: command?.flags ?? [],
      refusals: cli.refusals,
    };
  }),
);

describe("names plan and emitters: a part with several content types", () => {
  test("the plan offers --file-content-type over the listed types", () => {
    const flag = emitted.flags.find((candidate) => candidate.name === "file-content-type");

    expect(flag?.source).toEqual({
      _tag: "PartOption",
      media: ["multipart/form-data"],
      option: { choices: ["image/png", "image/jpeg"], kind: "content-type" },
      part: "/file",
      pointer: "/paths/~1uploads/post/requestBody/content/multipart~1form-data/encoding/file",
    });
  });

  test("the command is generated, not refused", () => {
    expect(emitted.refusals).toEqual([]);
    expect(emitted.cli).toContain(
      'Flag.Literals("file-content-type", ["image/png", "image/jpeg"])',
    );
    expect(emitted.cli).toContain(
      '"file-content-type": "content type of multipart part file; choices: image/png, image/jpeg"',
    );
  });

  test("the api/ builder takes the chosen type with the part, and no type without it", () => {
    expect(emitted.api).toContain(
      'readonly file?: Serialize.ChosenPart<"image/png" | "image/jpeg"> | undefined;',
    );
    expect(emitted.api).toContain("readonly body: CreateForm;");
    expect(emitted.api).not.toContain("ContentType");
    expect(emitted.api).toContain("Serialize.formData(input.body.fields, {");
    expect(emitted.api).toContain('["file", input.body.file],');
    expect(emitted.api).toContain('["title", "text/plain"],');
  });

  test("the cli/ command splits the chosen part out, filling no type", () => {
    expect(emitted.cli).toContain(
      'Effect.flatMap(Serialize.chooseParts({ file: ["file", flags.fileContentType] })),',
    );
    expect(emitted.cli).not.toContain("Option.getOrElse(flags.fileContentType");
  });
});

// Compiled with the package (`tsc` fails the build step otherwise): a call without the part names
// no content type, a call with it takes a listed one, and the part without its type does not
// compile (the `@ts-expect-error` line fails as unused if it does).
const builderCheck = `import * as Uploads from "./api/uploads.ts";

export const titleOnly = Uploads.create({ body: { fields: { title: ["cat"] } } });

export const chosen = Uploads.create({
  body: { fields: { title: ["cat"] }, file: { contentType: "image/jpeg", values: ["x"] } },
});

export const untyped = Uploads.create({
  // @ts-expect-error a sent part needs its content type
  body: { fields: { title: ["cat"] }, file: { values: ["x"] } },
});
`;

// The generated package lives under the worktree's git-ignored `work/`, never the system temp
// directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "b13-content-type-"));

const priorTmpdir = process.env.TMPDIR;

process.env.TMPDIR = work;

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const scope = Effect.runSync(Scope.make());

const capture = startCaptureServer();

const origin = capture.origins["127.0.0.1"];

const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const filePath = nodePath.join(work, "photo.png");

let generated: GeneratedPackage | undefined;

beforeAll(async () => {
  const specPath = nodePath.join(work, "openapi.json");
  const configPath = nodePath.join(work, "author-config.json");
  nodeFs.writeFileSync(filePath, pngBytes);
  nodeFs.writeFileSync(specPath, JSON.stringify(spec));
  nodeFs.writeFileSync(configPath, JSON.stringify(configJson));
  capture.script("/uploads", { status: 204 });

  generated = await Effect.runPromise(
    generateFixture({
      authorFiles: [{ content: builderCheck, path: "src/builder-check.ts" }],
      configPath,
      specPath,
    }).pipe(Effect.tap(preparePackage), Scope.provide(scope), Effect.provide(layer)),
  );
}, 900_000);

afterAll(async () => {
  capture.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  nodeFs.rmSync(work, { force: true, recursive: true });
  process.env.TMPDIR = priorTmpdir;
});

const built = (): GeneratedPackage => {
  if (generated === undefined) {
    throw new Error("the b13 package was not built");
  }

  return generated;
};

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

interface Exchange {
  readonly connections: number;
  readonly requests: readonly RecordedRequest[];
  readonly result: BinRun;
}

const exchange = async (args: readonly string[]): Promise<Exchange> => {
  const before = capture.requests().length;
  const opened = capture.connections();
  const result = await Effect.runPromise(
    runBin(built(), { args: ["--base-url", origin, ...args], timeoutMs: 30_000 }).pipe(
      Effect.provide(layer),
    ),
  );

  return {
    connections: capture.connections() - opened,
    requests: capture.requests().slice(before),
    result,
  };
};

const refused = (run: Exchange, message: string) => {
  expect(run.result.exitCode).toBe(2);
  expect(decode(run.result.stderr)).toContain(message);
  expect(run.connections).toBe(0);
  expect(run.requests).toEqual([]);
};

describe("ENC-10: the built CLI sends the chosen part content type", () => {
  test("--file-content-type image/jpeg sends the file part as image/jpeg", async () => {
    const run = await exchange([
      "uploads",
      "create",
      "--title",
      "cat",
      "--file",
      filePath,
      "--file-content-type",
      "image/jpeg",
    ]);

    expect(run.result.exitCode, decode(run.result.stderr)).toBe(0);
    expect(run.requests).toHaveLength(1);

    const text = Buffer.from(run.requests[0]?.body ?? new Uint8Array()).toString("latin1");
    const filePart = text.split("\r\n--").find((part) => part.includes('name="file"')) ?? "";

    expect(filePart).toContain('Content-Disposition: form-data; name="file"; filename="photo.png"');
    expect(filePart).toContain("Content-Type: image/jpeg\r\n");
    expect(filePart).toContain(Buffer.from(pngBytes).toString("latin1"));
  }, 60_000);

  test("a sent part without its content type is exit 2 with no connection", async () => {
    const run = await exchange(["uploads", "create", "--title", "cat", "--file", filePath]);

    refused(run, "--file-content-type: this request needs it when --file is given");
  }, 60_000);

  test("the content type without its part is exit 2 with no connection", async () => {
    const run = await exchange([
      "uploads",
      "create",
      "--title",
      "cat",
      "--file-content-type",
      "image/png",
    ]);

    refused(run, "--file-content-type: applies only with --file");
  }, 60_000);

  test("a type the part does not list is exit 2 with no connection", async () => {
    const run = await exchange([
      "uploads",
      "create",
      "--title",
      "cat",
      "--file",
      filePath,
      "--file-content-type",
      "image/gif",
    ]);

    expect(run.result.exitCode).toBe(2);
    expect(run.connections).toBe(0);
  }, 60_000);

  test("without the part the request is sent with the title alone", async () => {
    const run = await exchange(["uploads", "create", "--title", "cat"]);

    expect(run.result.exitCode, decode(run.result.stderr)).toBe(0);

    const text = Buffer.from(run.requests[0]?.body ?? new Uint8Array()).toString("latin1");

    expect(text).toContain('name="title"');
    expect(text).not.toContain('name="file"');
  }, 60_000);
});
