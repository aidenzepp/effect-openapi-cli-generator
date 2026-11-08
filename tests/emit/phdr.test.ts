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
import { setEnv } from "../support/env.ts";

// ENC-03, HDR-01 and HDR-03 (part clauses), FW:140 (design 6.3): each declared part header is a
// `--<part>-<header>` flag, typed and serialized as a header parameter. Its value is sent in the
// part's head; a required one is needed only when its part is sent, and a header flag without its
// part is a usage error, both before any connection. The headers the writer owns
// (`Content-Disposition` under form-data, `Content-Transfer-Encoding`) get no flag and a notice.
// A second operation lists ten part types, whose union the `api/` module names as an alias, so the
// package's own `tsc` proves the long-union shape compiles beside the header shape.

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const configJson = decodeJson({
  binName: "docs",
  envPrefix: "DOCS",
  package: { name: "docs-cli", version: "0.1.0" },
  servers: { accepted: ["https://api.example.com"] },
});

const scanTypes = [
  "application/json",
  "application/pdf",
  "application/zip",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/html",
  "text/plain",
];

const fileSchema = { contentMediaType: "application/octet-stream", type: "string" };

// `POST /docs`: a `file` part typed `image/png` with a required `X-Checksum` header, a deprecated
// `X-Trace` header and a declared `Content-Disposition`, and a required `title` part. `POST /scans`:
// a `scan` part listing ten types.
const spec: Schema.Json = {
  info: { title: "Docs", version: "1.0.0" },
  openapi: "3.1.0",
  paths: {
    "/docs": {
      post: {
        operationId: "docs-upload",
        requestBody: {
          content: {
            "multipart/form-data": {
              encoding: {
                file: {
                  contentType: "image/png",
                  headers: {
                    "Content-Disposition": { schema: { type: "string" } },
                    "X-Checksum": { required: true, schema: { type: "string" } },
                    "X-Trace": { deprecated: true, schema: { type: "string" } },
                  },
                },
              },
              schema: {
                properties: { file: fileSchema, title: { type: "string" } },
                required: ["title"],
                type: "object",
              },
            },
          },
          required: true,
        },
        responses: { "204": { description: "stored" } },
        tags: ["docs"],
      },
    },
    "/scans": {
      post: {
        operationId: "docs-scan",
        requestBody: {
          content: {
            "multipart/form-data": {
              encoding: { scan: { contentType: scanTypes.join(", ") } },
              schema: { properties: { scan: fileSchema }, type: "object" },
            },
          },
          required: true,
        },
        responses: { "204": { description: "stored" } },
        tags: ["docs"],
      },
    },
  },
  servers: [{ url: "https://api.example.com" }],
  tags: [{ name: "docs" }],
};

const document = Schema.decodeUnknownSync(DocumentUri)("file:///phdr/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///phdr/author-config.json");

const config = await Effect.runPromise(
  decodeAuthorConfig(configJson, { document: configDocument }),
);

const emitted = await Effect.runPromise(
  Effect.gen(function* generated() {
    const resolution = yield* resolve({ document, line: "3.1", value: spec });
    const { api, diagnostics } = yield* normalize(resolution, {
      checkFindings: [],
      config,
      configDocument,
    });
    const plan = yield* planNames(api, { config, configDocument, strict: false });
    const context = { config, configDocument, document, openapi: api.openapi };
    const bound = (servers: readonly Server[]) => boundOrigins(servers, context).origins;
    const apiFiles = yield* emitApi({ api, boundOrigins: bound, plan });
    const cli = yield* emitCli({ api, config, plan, validationEdits: [] });
    const commands = plan.groups.flatMap((group) => group.commands);

    return {
      api: apiFiles.find((file) => file.path === "src/api/docs.ts")?.content ?? "",
      cli: cli.files.find((file) => file.path === "src/cli/docs.ts")?.content ?? "",
      diagnostics,
      flags: commands.find((command) => command.name === "upload")?.flags ?? [],
      refusals: cli.refusals,
    };
  }),
);

const media = "/paths/~1docs/post/requestBody/content/multipart~1form-data";

describe("names plan and emitters: declared part headers", () => {
  test("the plan offers one --file-<header> option per header the writer does not own", () => {
    const options = emitted.flags.filter((flag) => flag.source._tag === "PartOption");

    expect(options.map((flag) => [flag.name, flag.source])).toEqual([
      [
        "file-x-checksum",
        {
          _tag: "PartOption",
          media: ["multipart/form-data"],
          option: { kind: "header", name: "X-Checksum" },
          part: "/file",
          pointer: `${media}/encoding/file/headers/X-Checksum`,
        },
      ],
      [
        "file-x-trace",
        {
          _tag: "PartOption",
          media: ["multipart/form-data"],
          option: { kind: "header", name: "X-Trace" },
          part: "/file",
          pointer: `${media}/encoding/file/headers/X-Trace`,
        },
      ],
    ]);
  });

  test("Content-Disposition is the writer's: a notice, no flag", () => {
    const notices = emitted.diagnostics.filter(
      (diagnostic) => diagnostic.code === "ENC-03/writer-owned-header",
    );

    expect(notices.map((diagnostic) => [String(diagnostic.pointer), diagnostic.severity])).toEqual([
      [`${media}/encoding/file/headers/Content-Disposition`, "notice"],
    ]);
  });

  test("both commands are generated, with help naming each header and its marks", () => {
    expect(emitted.refusals).toEqual([]);
    expect(emitted.cli).toContain(
      '"file-x-checksum": "header X-Checksum of multipart part file; required when --file is given",',
    );
    expect(emitted.cli).toContain(
      '"file-x-trace": "header X-Trace of multipart part file; deprecated",',
    );
  });

  test("the api/ builder takes the part with its type and header values", () => {
    expect(emitted.api).toContain(
      '  readonly file?: Serialize.ChosenPart<"image/png"> | undefined;',
    );
    expect(emitted.api).toContain('["file", input.body.file],');
  });

  test("ten part types are one alias, so no field line passes 100 columns", () => {
    expect(emitted.api).toContain("export type ScanFormScanContentType =");
    expect(emitted.api).toContain(
      "  readonly scan?: Serialize.ChosenPart<ScanFormScanContentType> | undefined;",
    );
    expect(emitted.api.split("\n").every((line) => line.length <= 100)).toBe(true);
  });
});

// Compiled with the package (`tsc` fails the build step otherwise): a part with header values, a
// ten-type part under a listed type, and an unlisted type that does not compile.
const builderCheck = `import * as Docs from "./api/docs.ts";
import * as Serialize from "./runtime/serialize.ts";

const checksum = Serialize.header("X-Checksum", "9f86d0", { explode: false, required: false });

export const titleOnly = Docs.upload({ body: { fields: { title: ["t"] } } });

export const withHeader = Docs.upload({
  body: {
    fields: { title: ["t"] },
    file: { contentType: "image/png", headers: [checksum], values: ["x"] },
  },
});

export const scanned = Docs.scan({
  body: { fields: {}, scan: { contentType: "image/webp", values: ["x"] } },
});

export const unlisted = Docs.scan({
  // @ts-expect-error a type the part does not list
  body: { fields: {}, scan: { contentType: "image/x-unlisted", values: ["x"] } },
});
`;

// The generated package lives under the worktree's git-ignored `work/`, never the system temp
// directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "phdr-"));

const restoreTmpdir = setEnv("TMPDIR", work);

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const scope = Effect.runSync(Scope.make());

const capture = startCaptureServer();

const origin = capture.origins["127.0.0.1"];

const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const filePath = nodePath.join(work, "scan.png");

let generated: GeneratedPackage | undefined;

beforeAll(async () => {
  const specPath = nodePath.join(work, "openapi.json");
  const configPath = nodePath.join(work, "author-config.json");
  nodeFs.writeFileSync(filePath, pngBytes);
  nodeFs.writeFileSync(specPath, JSON.stringify(spec));
  nodeFs.writeFileSync(configPath, JSON.stringify(configJson));
  capture.script("/docs", { status: 204 });

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
  restoreTmpdir();
});

const built = (): GeneratedPackage => {
  if (generated === undefined) {
    throw new Error("the phdr package was not built");
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

const filePart = (run: Exchange): string => {
  const text = Buffer.from(run.requests[0]?.body ?? new Uint8Array()).toString("latin1");

  return text.split("\r\n--").find((part) => part.includes('name="file"')) ?? "";
};

describe("ENC-03, HDR-01, HDR-03: the built CLI sends part headers", () => {
  test("the header values are written in the file part's head (HDR-01)", async () => {
    const run = await exchange([
      "docs",
      "upload",
      "--title",
      "t",
      "--file",
      filePath,
      "--file-x-checksum",
      "9f86d0",
      "--file-x-trace",
      "t1",
    ]);

    expect(run.result.exitCode, decode(run.result.stderr)).toBe(0);
    expect(run.requests).toHaveLength(1);
    expect(filePart(run)).toContain(
      [
        'Content-Disposition: form-data; name="file"; filename="scan.png"',
        "X-Checksum: 9f86d0",
        "X-Trace: t1",
        "Content-Type: image/png",
      ].join("\r\n"),
    );
  }, 60_000);

  test("an optional header not given is not written", async () => {
    const run = await exchange([
      "docs",
      "upload",
      "--title",
      "t",
      "--file",
      filePath,
      "--file-x-checksum",
      "9f86d0",
    ]);

    expect(run.result.exitCode, decode(run.result.stderr)).toBe(0);
    expect(filePart(run)).toContain("X-Checksum: 9f86d0\r\n");
    expect(filePart(run)).not.toContain("X-Trace");
  }, 60_000);

  test("a sent part without its required header is exit 2 with no connection (HDR-03)", async () => {
    const run = await exchange(["docs", "upload", "--title", "t", "--file", filePath]);

    refused(run, "--file-x-checksum: this request needs it when --file is given");
  }, 60_000);

  test("a header flag without its part is exit 2 with no connection", async () => {
    const run = await exchange(["docs", "upload", "--title", "t", "--file-x-checksum", "9f86d0"]);

    refused(run, "--file-x-checksum: applies only with --file");
  }, 60_000);

  test("a header value with a line break is refused with no connection", async () => {
    const run = await exchange([
      "docs",
      "upload",
      "--title",
      "t",
      "--file",
      filePath,
      "--file-x-checksum",
      "a\r\nX-Evil: 1",
    ]);

    expect(run.result.exitCode).toBe(2);
    expect(run.connections).toBe(0);
  }, 60_000);

  test("without the part, the request is sent with the title alone and no header", async () => {
    const run = await exchange(["docs", "upload", "--title", "t"]);

    expect(run.result.exitCode, decode(run.result.stderr)).toBe(0);

    const text = Buffer.from(run.requests[0]?.body ?? new Uint8Array()).toString("latin1");

    expect(text).toContain('name="title"');
    expect(text).not.toContain('name="file"');
    expect(text).not.toContain("X-Checksum");
  }, 60_000);
});
