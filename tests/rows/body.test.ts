import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate, GenerateRefused } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import type { Diagnostic } from "../../src/model/diagnostic.ts";
import type { Json } from "../../src/model/pointer.ts";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { RecordedRequest } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";
import { setEnv } from "../support/env.ts";

// The Milestone 2 witness for the Request Body, Media Type and Binary data rows (RQB-*, MED-*,
// BIN-*): one generated package per version line, built once, run against the capture server; the
// generation rows call `generate()` in process. A row the product gets wrong is a `test.todo` with
// what was observed. MED-03's response half and MED-16 to MED-20 are deferred to Milestone 3.
// MED-07, MED-08, MED-15 and MED-26 send a 3.2 positional multipart/mixed body from one repeatable,
// ordered --part flag (M3-MP1).

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

const fixtures = nodePath.join(repoRoot, "corpus/fixtures/rows/body");

type Line = "3.0.4" | "3.1.2" | "3.2.1";

const lines: readonly Line[] = ["3.0.4", "3.1.2", "3.2.1"];

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

// Generated packages and input files live under the worktree's git-ignored `work/`, never the
// system temp directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "wt-body-"));

const restoreTmpdir = setEnv("TMPDIR", work);

interface Members {
  readonly [key: string]: Json;
}

const readJson = (file: string): Members =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
    nodeFs.readFileSync(file, "utf-8"),
  );

const authorConfig = readJson(nodePath.join(fixtures, "author-config.json"));

const capture = startCaptureServer();

const origin = capture.origins["127.0.0.1"];

const { port } = new URL(origin);

const scope = Effect.runSync(Scope.make());

const packages = new Map<Line, GeneratedPackage>();

const encoder = new TextEncoder();

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");

// Five bytes with a NUL and a control byte, so text handling would show.
const small = Uint8Array.from([0x61, 0x62, 0x00, 0x01, 0x0a]);

// Bytes whose base64 and base64url texts differ: +/8= and -_8=.
const alphabet = Uint8Array.from([0xfb, 0xff]);

const ten = encoder.encode("0123456789");

const three = encoder.encode("abc");

// One valid JSON line and one that is not: a sequential upload is sent as given, never parsed.
const jsonLines = encoder.encode('{"a":1}\nnot json\n');

// A JSON document sent as one positional part's raw bytes, never parsed.
const meta = encoder.encode('{"id":1}');

const file = (name: string): string => nodePath.join(work, name);

const multipartResponse =
  "--b\r\nContent-Type: text/plain\r\n\r\none\r\n--b\r\nContent-Type: text/plain\r\n\r\ntwo\r\n--b--\r\n";

beforeAll(async () => {
  nodeFs.writeFileSync(file("small.bin"), small);
  nodeFs.writeFileSync(file("alphabet.bin"), alphabet);
  nodeFs.writeFileSync(file("ten.bin"), ten);
  nodeFs.writeFileSync(file("three.bin"), three);
  nodeFs.writeFileSync(file("lines.jsonl"), jsonLines);
  nodeFs.writeFileSync(file("meta.json"), meta);

  capture.script("/json", {
    body: '{"b": 1,"a":[2]}',
    headers: [["content-type", "application/json"]],
    status: 200,
  });
  capture.script("/binary", {
    body: "downloaded\u0001",
    headers: [["content-type", "application/octet-stream"]],
    status: 200,
  });
  capture.script("/bounded", {
    body: "0123456789",
    headers: [["content-type", "application/octet-stream"]],
    status: 200,
  });
  capture.script("/parts", {
    body: multipartResponse,
    headers: [["content-type", "multipart/mixed; boundary=b"]],
    status: 200,
  });
  capture.script("/ranges", {
    body: multipartResponse,
    headers: [["content-type", "multipart/byteranges; boundary=b"]],
    status: 206,
  });
  capture.script("/form-parts", {
    body: multipartResponse,
    headers: [["content-type", "multipart/form-data; boundary=b"]],
    status: 200,
  });

  // The port is known only once the capture server listens, so the bound origin is added here.
  const configPath = file("author-config.json");
  nodeFs.writeFileSync(
    configPath,
    `${JSON.stringify({ ...authorConfig, acceptedOrigins: [origin] })}\n`,
  );

  // One package per line, built one after the other.
  const built = await Effect.runPromise(
    Effect.forEach(
      lines,
      (line) =>
        generateFixture({ configPath, specPath: nodePath.join(fixtures, `${line}.json`) }).pipe(
          Effect.tap(preparePackage),
          Effect.map((generated) => [line, generated] as const),
        ),
      { concurrency: 1 },
    ).pipe(Scope.provide(scope), Effect.provide(layer)),
  );
  for (const [line, generated] of built) {
    packages.set(line, generated);
  }
}, 900_000);

afterAll(async () => {
  capture.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  nodeFs.rmSync(work, { force: true, recursive: true });
  restoreTmpdir();
});

interface Exchange {
  readonly exitCode: number | null;
  readonly requests: readonly RecordedRequest[];
  readonly stdout: string;
}

// One invocation of the line's built CLI against the bound server, with what the capture server
// recorded during it. `runBin` is asynchronous, so the in-process capture server keeps answering.
const run = async (line: Line, args: readonly string[], stdin?: Uint8Array): Promise<Exchange> => {
  const generated = packages.get(line);
  if (generated === undefined) {
    throw new Error(`no package built for ${line}`);
  }

  const before = capture.requests().length;
  const result = await Effect.runPromise(
    runBin(generated, {
      args: ["--server", "0", "--server-variable", `port=${port}`, ...args],
      stdin: stdin ?? new Uint8Array(),
      timeoutMs: 30_000,
    }).pipe(Effect.provide(layer)),
  );
  if (result.exitCode !== 0 && result.exitCode !== 2) {
    throw new Error(`unexpected exit ${String(result.exitCode)}: ${latin1(result.stderr)}`);
  }

  return {
    exitCode: result.exitCode,
    requests: capture.requests().slice(before),
    stdout: latin1(result.stdout),
  };
};

const header = (request: RecordedRequest, name: string): string | undefined =>
  request.headers.find(([candidate]) => candidate.toLowerCase() === name)?.[1];

// The request fields a body row decides; an absent header is `undefined`.
interface Sent {
  readonly body: string;
  readonly contentEncoding: string | undefined;
  readonly contentLength: string | undefined;
  readonly contentType: string | undefined;
  readonly target: string;
  readonly transferEncoding: string | undefined;
}

const sentOf = (request: RecordedRequest): Sent => ({
  body: latin1(request.body),
  contentEncoding: header(request, "content-encoding"),
  contentLength: header(request, "content-length"),
  contentType: header(request, "content-type"),
  target: request.target,
  transferEncoding: header(request, "transfer-encoding"),
});

// The one request an invocation sent, or a failure naming what happened instead.
const sentOnce = (exchange: Exchange): Sent => {
  expect(exchange.exitCode).toBe(0);
  expect(exchange.requests).toHaveLength(1);

  const [request] = exchange.requests;
  if (request === undefined) {
    throw new Error("the capture server saw no request");
  }

  return sentOf(request);
};

const refusedBeforeSending = { exitCode: 2, requests: [] };

const usage = (exchange: Exchange) => ({
  exitCode: exchange.exitCode,
  requests: exchange.requests,
});

// A fixed body: `Content-Length` and no chunking.
const fixed = (target: string, contentType: string | undefined, body: string): Sent => ({
  body,
  contentEncoding: undefined,
  contentLength: String(Buffer.byteLength(body, "latin1")),
  contentType,
  target,
  transferEncoding: undefined,
});

// A body streamed from stdin: chunked, with no `Content-Length`.
const chunked = (target: string, contentType: string | undefined, body: string): Sent => ({
  ...fixed(target, contentType, body),
  contentLength: undefined,
  transferEncoding: "chunked",
});

interface Part {
  readonly body: string;
  readonly headers: readonly string[];
}

// The parts of a recorded multipart body, split at the boundary its `Content-Type` names.
const partsOf = (sent: Sent): readonly Part[] => {
  const boundary = /; boundary=(?<boundary>.+)$/u.exec(sent.contentType ?? "")?.groups?.boundary;
  if (boundary === undefined) {
    throw new Error("the multipart Content-Type names no boundary");
  }

  const segments = sent.body.split(`--${boundary}`);
  expect(segments.at(-1)).toBe("--\r\n");

  return segments.slice(1, -1).map((segment) => {
    const headEnd = segment.indexOf("\r\n\r\n");

    return {
      body: segment.slice(headEnd + 4, -2),
      headers: segment.slice(2, headEnd).split("\r\n"),
    };
  });
};

const disposition = (name: string, filename?: string): string =>
  filename === undefined
    ? `Content-Disposition: form-data; name="${name}"`
    : `Content-Disposition: form-data; name="${name}"; filename="${filename}"`;

const smallText = latin1(small);

// In process generation of a small document of a line; the diagnostics of a refused run are the
// refusal's.
const members = (line: Line, extra: Members): Members => ({
  info: { title: "Request Body rows", version: "1.0.0" },
  openapi: line,
  ...extra,
});

const ok: Members = { "200": { description: "ok" } };

const named: Members = { properties: { name: { type: "string" } }, type: "object" };

const withBody = (line: Line, requestBody: Members): Members =>
  members(line, { paths: { "/a": { post: { requestBody, responses: ok } } } });

interface Generated {
  // The emitted commands' paths; empty for a refused run.
  readonly commands: readonly (readonly string[])[];
  readonly diagnostics: readonly Diagnostic[];
  // The generated package directory of a run that was not refused.
  readonly out?: string;
}

let counter = 0;

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

const inProcess = async (document: Members): Promise<Generated> => {
  counter += 1;
  const dir = nodePath.join(work, `case-${counter}`);
  nodeFs.mkdirSync(dir, { recursive: true });

  const specPath = nodePath.join(dir, "openapi.json");
  const configPath = nodePath.join(dir, "author-config.json");

  nodeFs.writeFileSync(specPath, JSON.stringify(document));
  nodeFs.writeFileSync(configPath, JSON.stringify(authorConfig));

  const decodeDocument = Schema.decodeUnknownSync(DocumentUri);
  const exit = await Effect.runPromiseExit(
    generate(
      {
        document: decodeDocument("file:///fixture/openapi.json"),
        generator,
        outDir: nodePath.join(dir, "out"),
        source: { _tag: "File", path: specPath },
        strict: false,
      },
      { document: decodeDocument("file:///fixture/author-config.json"), path: configPath },
    ).pipe(Effect.provide(layer)),
  );
  if (Exit.isSuccess(exit)) {
    return {
      commands: exit.value.report.commandNames.map((command) => command.path),
      diagnostics: exit.value.diagnostics,
      out: nodePath.join(dir, "out"),
    };
  }

  const [failure] = exit.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" && reason.error instanceof GenerateRefused ? [reason.error] : [],
  );
  if (failure === undefined) {
    throw new Error(`generate failed for a reason other than a refusal: ${String(exit.cause)}`);
  }

  return { commands: [], diagnostics: failure.diagnostics };
};

const summary = (found: Generated) =>
  found.diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.severity,
    diagnostic.scope,
    String(diagnostic.pointer),
  ]);

// A refusal that drops a whole media alternative is anchored at the media type, with the keyword
// that caused it first in `related`.
const anchored = (found: Generated) =>
  found.diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.severity,
    diagnostic.scope,
    String(diagnostic.pointer),
    String(diagnostic.related?.[0]?.pointer),
  ]);

const content = "/paths/~1a/post/requestBody/content";

const withResponse = (line: Line, response: Members): Members =>
  members(line, { paths: { "/a": { get: { responses: { "200": response } } } } });

describe("RQB, MED and BIN rows through the built CLI", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`RQB-01: a Request Body Object becomes the request's body (${line})`, async () => {
        const sent = sentOnce(await run(line, ["json-create", "--name", "a"]));

        expect(sent).toEqual(fixed("/json", "application/json", '{"name":"a"}'));
      }, 60_000);

      test(`RQB-03: Content-Type and body follow the chosen content entry (${line})`, async () => {
        const json = sentOnce(await run(line, ["choose-create", "--name", "a"]));
        const gzip = sentOnce(
          await run(line, [
            "choose-create",
            "--content-type",
            "application/gzip",
            "--body-file",
            file("small.bin"),
          ]),
        );

        expect([json, gzip]).toEqual([
          fixed("/choose", "application/json", '{"name":"a"}'),
          fixed("/choose", "application/gzip", smallText),
        ]);
      }, 60_000);

      test(`RQB-04: a required body missing is a usage error; an optional one omitted sends none (${line})`, async () => {
        const missing = await run(line, ["blob-required-put"]);
        const omitted = sentOnce(await run(line, ["blob-optional-put"]));

        expect(usage(missing)).toEqual(refusedBeforeSending);
        expect(omitted).toEqual(fixed("/blob/optional", undefined, ""));
      }, 60_000);

      test(`RQB-05: the specific key's schema and encoding apply over a range that also matches (${line})`, async () => {
        const sent = sentOnce(
          await run(line, [
            "specific-create",
            "--content-type",
            "application/x-www-form-urlencoded",
            "--name",
            "a b",
          ]),
        );

        expect(sent).toEqual(fixed("/specific", "application/x-www-form-urlencoded", "name=a+b"));
      }, 60_000);

      test(`RQB-06: JSON is the default; a range key needs a concrete type inside it (${line})`, async () => {
        const unnamed = await run(line, ["image-put", "--body-file", file("small.bin")]);
        const outside = await run(line, [
          "image-put",
          "--content-type",
          "text/plain",
          "--body-file",
          file("small.bin"),
        ]);
        const range = await run(line, [
          "image-put",
          "--content-type",
          "image/*",
          "--body-file",
          file("small.bin"),
        ]);
        const concrete = sentOnce(
          await run(line, [
            "image-put",
            "--content-type",
            "image/png",
            "--body-file",
            file("small.bin"),
          ]),
        );
        const defaulted = sentOnce(await run(line, ["choose-create", "--name", "a"]));

        expect([usage(unnamed), usage(outside), usage(range)]).toEqual([
          refusedBeforeSending,
          refusedBeforeSending,
          refusedBeforeSending,
        ]);
        expect(concrete).toEqual(fixed("/image", "image/png", smallText));
        expect(defaulted.contentType).toBe("application/json");
      }, 60_000);

      test(`RQB-08: an array of binary parts in multipart/form-data repeats the part name (${line})`, async () => {
        const sent = sentOnce(
          await run(line, [
            "files-upload",
            "--files",
            file("small.bin"),
            "--files",
            file("three.bin"),
          ]),
        );

        expect(sent.transferEncoding).toBe("chunked");
        expect(partsOf(sent)).toEqual([
          {
            body: smallText,
            headers: [disposition("files", "small.bin"), "Content-Type: application/octet-stream"],
          },
          {
            body: "abc",
            headers: [disposition("files", "three.bin"), "Content-Type: application/octet-stream"],
          },
        ]);
      }, 60_000);

      test(`MED-01: a Media Type Object carries the request body and the response is written (${line})`, async () => {
        const exchange = await run(line, ["json-create", "--name", "a"]);

        expect(sentOnce(exchange)).toEqual(fixed("/json", "application/json", '{"name":"a"}'));
        expect(exchange.stdout).toBe('{"b": 1,"a":[2]}');
      }, 60_000);

      test(`MED-02: the body is serialized by and asserted against its schema; the response is written as received (${line})`, async () => {
        const typed = await run(line, ["json-create", "--name", "a", "--count", "3"]);
        const mismatched = await run(line, ["json-create", "--body", '{"count":"x"}']);
        const notInteger = await run(line, ["json-create", "--count", "x"]);

        expect(sentOnce(typed)).toEqual(
          fixed("/json", "application/json", '{"count":3,"name":"a"}'),
        );
        expect(typed.stdout).toBe('{"b": 1,"a":[2]}');
        expect([usage(mismatched), usage(notInteger)]).toEqual([
          refusedBeforeSending,
          refusedBeforeSending,
        ]);
      }, 60_000);

      test(`MED-06: encoding by property name sets a part's Content-Type and a form value's explode (${line})`, async () => {
        const multipart = sentOnce(await run(line, ["files-upload", "--note", "n1"]));
        const form = sentOnce(
          await run(line, ["form-create", "--name", "n", "--tags", "a", "--tags", "b"]),
        );

        expect(partsOf(multipart)).toEqual([
          { body: "n1", headers: [disposition("note"), "Content-Type: text/csv"] },
        ]);
        expect(form).toEqual(
          fixed("/form", "application/x-www-form-urlencoded", "name=n&tags=a,b"),
        );
      }, 60_000);

      test(`MED-21: a streamed download is not truncated to the schema's maxLength (${line})`, async () => {
        const exchange = await run(line, ["bounded-put", "--body-file", file("three.bin")]);

        expect(sentOnce(exchange)).toEqual(fixed("/bounded", "application/octet-stream", "abc"));
        expect(exchange.stdout).toBe("0123456789");
      }, 60_000);

      test(`MED-21: a 10-byte upload against maxLength 4 is rejected before sending (${line})`, async () => {
        const exchange = await run(line, ["bounded-put", "--body-file", file("ten.bin")]);

        expect(usage(exchange)).toEqual(refusedBeforeSending);
      }, 60_000);

      test(`MED-24: a +json vendor media type is treated as JSON (${line})`, async () => {
        const sent = sentOnce(await run(line, ["vendor-create", "--name", "n"]));

        expect(sent).toEqual(fixed("/vendor", "application/vnd.github.v3+json", '{"name":"n"}'));
      }, 60_000);

      test(`BIN-08: a base64 field adds no Content-Encoding header (${line})`, async () => {
        const sent = sentOnce(await run(line, ["encoded-create", "--data", file("small.bin")]));

        expect(sent.contentEncoding).toBeUndefined();
        expect(sent.body).toBe('{"data":"YWIAAQo="}');
      }, 60_000);
    });
  }

  test("RQB-10: a 3.0 Media Type with no schema sends an opaque body from a file with Content-Length", async () => {
    const sent = sentOnce(await run("3.0.4", ["raw-put", "--body-file", file("small.bin")]));

    expect(sent).toEqual(fixed("/raw", "application/octet-stream", smallText));
  }, 60_000);

  test("RQB-10: a 3.0 Media Type with no schema streams --body-file - from stdin chunked, with no Content-Length", async () => {
    const sent = sentOnce(await run("3.0.4", ["raw-put", "--body-file", "-"], small));

    expect(sent).toEqual(chunked("/raw", "application/octet-stream", smallText));
  }, 60_000);

  test("BIN-01: a 3.0 format: binary body streams from a file with Content-Length and downloads to --output", async () => {
    const output = file("download-3.0.4.bin");
    const exchange = await run("3.0.4", [
      "binary-put",
      "--body-file",
      file("small.bin"),
      "--output",
      output,
    ]);

    expect(sentOnce(exchange)).toEqual(fixed("/binary", "application/octet-stream", smallText));
    expect(latin1(nodeFs.readFileSync(output))).toBe("downloaded\u0001");
  }, 60_000);

  test("BIN-01: a 3.0 format: binary body streams --body-file - from stdin chunked, with no Content-Length", async () => {
    const sent = sentOnce(await run("3.0.4", ["binary-put", "--body-file", "-"], small));

    expect(sent).toEqual(chunked("/binary", "application/octet-stream", smallText));
  }, 60_000);

  test("BIN-01: a 3.0 format: binary multipart part is read from a file", async () => {
    const sent = sentOnce(await run("3.0.4", ["files-upload", "--avatar", file("three.bin")]));

    expect(partsOf(sent)).toEqual([
      {
        body: "abc",
        headers: [disposition("avatar", "three.bin"), "Content-Type: application/octet-stream"],
      },
    ]);
  }, 60_000);

  test("BIN-02: a 3.0 format: byte JSON field takes a file or stdin and sends its base64", async () => {
    const fromFile = sentOnce(await run("3.0.4", ["encoded-create", "--data", file("small.bin")]));
    const fromStdin = sentOnce(await run("3.0.4", ["encoded-create", "--data", "-"], three));

    expect([fromFile, fromStdin]).toEqual([
      fixed("/encoded", "application/json", '{"data":"YWIAAQo="}'),
      fixed("/encoded", "application/json", '{"data":"YWJj"}'),
    ]);
  }, 60_000);

  test("BIN-02: a 3.0 format: byte form property takes a file or stdin and sends its base64, percent-encoded", async () => {
    const fromFile = sentOnce(
      await run("3.0.4", ["encoded-form-create", "--data", file("small.bin")]),
    );
    const fromStdin = sentOnce(await run("3.0.4", ["encoded-form-create", "--data", "-"], three));

    expect([fromFile, fromStdin]).toEqual([
      fixed("/encoded-form", "application/x-www-form-urlencoded", "data=YWIAAQo%3D"),
      fixed("/encoded-form", "application/x-www-form-urlencoded", "data=YWJj"),
    ]);
  }, 60_000);

  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`RQB-09: a schemaless binary body streams from a file with Content-Length (${line})`, async () => {
      const sent = sentOnce(await run(line, ["raw-put", "--body-file", file("small.bin")]));

      expect(sent).toEqual(fixed("/raw", "application/octet-stream", smallText));
    }, 60_000);

    test(`RQB-09: a schemaless binary body streams --body-file - from stdin chunked, with no Content-Length (${line})`, async () => {
      const sent = sentOnce(await run(line, ["raw-put", "--body-file", "-"], small));

      expect(sent).toEqual(chunked("/raw", "application/octet-stream", smallText));
    }, 60_000);

    test(`BIN-03: a typeless contentMediaType body streams from a file and downloads to --output (${line})`, async () => {
      const output = file(`download-${line}.bin`);
      const exchange = await run(line, [
        "binary-put",
        "--body-file",
        file("small.bin"),
        "--output",
        output,
      ]);

      expect(sentOnce(exchange)).toEqual(fixed("/binary", "application/octet-stream", smallText));
      expect(latin1(nodeFs.readFileSync(output))).toBe("downloaded\u0001");
    }, 60_000);

    test(`BIN-03: a typeless contentMediaType body streams --body-file - from stdin chunked, with no Content-Length (${line})`, async () => {
      const sent = sentOnce(await run(line, ["binary-put", "--body-file", "-"], small));

      expect(sent).toEqual(chunked("/binary", "application/octet-stream", smallText));
    }, 60_000);

    test(`BIN-04: contentEncoding base64 and base64url JSON fields send the file's encoding (${line})`, async () => {
      const sent = sentOnce(
        await run(line, [
          "encoded-create",
          "--data",
          file("alphabet.bin"),
          "--urlsafe",
          file("alphabet.bin"),
        ]),
      );

      expect(sent).toEqual(
        fixed("/encoded", "application/json", '{"data":"+/8=","urlsafe":"-_8="}'),
      );
    }, 60_000);

    test(`BIN-04: a contentEncoding base64 form property reads a file and sends its base64, percent-encoded (${line})`, async () => {
      const sent = sentOnce(
        await run(line, ["encoded-form-create", "--data", file("alphabet.bin")]),
      );

      expect(sent).toEqual(
        fixed("/encoded-form", "application/x-www-form-urlencoded", "data=%2B%2F8%3D"),
      );
    }, 60_000);

    test(`BIN-05: format: binary is an annotation; the property stays a string sent as given (${line})`, async () => {
      const sent = sentOnce(await run(line, ["annotated-create", "--blob", "not a path"]));

      expect(sent).toEqual(fixed("/annotated", "application/json", '{"blob":"not a path"}'));
    }, 60_000);

    test(`BIN-06: a contradicting contentMediaType is ignored for the body and the part Content-Type (${line})`, async () => {
      const body = sentOnce(await run(line, ["binary-put", "--body-file", file("small.bin")]));
      const part = sentOnce(await run(line, ["files-upload", "--avatar", file("three.bin")]));

      expect(body.contentType).toBe("application/octet-stream");
      expect(partsOf(part)).toEqual([
        {
          body: "abc",
          headers: [disposition("avatar", "three.bin"), "Content-Type: application/octet-stream"],
        },
      ]);
    }, 60_000);
  }

  test("MED-03 (request): a sequential upload is streamed as given, chunked from stdin", async () => {
    const fromStdin = sentOnce(await run("3.2.1", ["events-send", "--body-file", "-"], jsonLines));
    const fromFile = sentOnce(
      await run("3.2.1", ["events-send", "--body-file", file("lines.jsonl")]),
    );

    expect(fromStdin).toEqual({
      ...fixed("/events", "application/jsonl", latin1(jsonLines)),
      contentLength: undefined,
      transferEncoding: "chunked",
    });
    expect(fromFile).toEqual(fixed("/events", "application/jsonl", latin1(jsonLines)));
  }, 60_000);

  test("MED-12: an encoding key with no property and an absent property send no part (3.2.1)", async () => {
    const sent = sentOnce(await run("3.2.1", ["sparse-upload", "--a", "x"]));

    expect(partsOf(sent)).toEqual([
      { body: "x", headers: [disposition("a"), "Content-Type: text/plain"] },
    ]);
  }, 60_000);

  test("MED-22: multipart/mixed and multipart/byteranges responses are written byte for byte", async () => {
    const mixed = await run("3.2.1", ["parts-get"]);
    const ranges = await run("3.2.1", ["ranges-get", "--output", "-"]);

    expect([mixed.exitCode, mixed.stdout]).toEqual([0, multipartResponse]);
    expect([ranges.exitCode, ranges.stdout]).toEqual([0, multipartResponse]);
  }, 60_000);

  test("MED-23: a multipart response with encoding is written intact to --output", async () => {
    const output = file("form-parts.bin");
    const exchange = await run("3.2.1", ["form-parts-get", "--output", output]);

    expect(exchange.exitCode).toBe(0);
    expect(latin1(nodeFs.readFileSync(output))).toBe(multipartResponse);
  }, 60_000);

  test("MED-27: the form serializer finds an array type through allOf and $ref", async () => {
    const sent = sentOnce(await run("3.2.1", ["inspected-create", "--tags", '["a","b"]']));

    expect(sent).toEqual(fixed("/inspected", "application/x-www-form-urlencoded", "tags=a&tags=b"));
  }, 60_000);

  test("BIN-07: a mixed multipart body checks its non-binary fields and sends the binary part unchecked", async () => {
    const sent = sentOnce(
      await run("3.2.1", ["mixed-upload", "--file", file("small.bin"), "--count", "2"]),
    );
    const notInteger = await run("3.2.1", [
      "mixed-upload",
      "--file",
      file("small.bin"),
      "--count",
      "x",
    ]);

    expect(partsOf(sent)).toEqual([
      { body: "2", headers: [disposition("count"), "Content-Type: text/plain"] },
      {
        body: smallText,
        headers: [disposition("file", "small.bin"), "Content-Type: application/octet-stream"],
      },
    ]);
    expect(usage(notInteger)).toEqual(refusedBeforeSending);
  }, 60_000);

  // A positional multipart/mixed part is raw bytes from a file or `-`, typed by its position's
  // rule; no part has a Content-Disposition.
  test("MED-07: prefixEncoding types the leading part, and the parts are sent in --part order (3.2.1)", async () => {
    const sent = sentOnce(
      await run("3.2.1", [
        "positional-upload",
        "--part",
        file("meta.json"),
        "--part",
        file("small.bin"),
      ]),
    );

    expect(sent.contentType).toMatch(/^multipart\/mixed; boundary=/u);
    expect(partsOf(sent)).toEqual([
      { body: '{"id":1}', headers: ["Content-Type: application/json"] },
      { body: smallText, headers: ["Content-Type: image/png"] },
    ]);
  }, 60_000);

  test("MED-08: itemEncoding types every remaining part alike, stdin included; a required body with no part is the close delimiter alone (3.2.1)", async () => {
    const sent = sentOnce(
      await run(
        "3.2.1",
        [
          "positional-upload",
          "--part",
          file("meta.json"),
          "--part",
          file("ten.bin"),
          "--part",
          "-",
        ],
        three,
      ),
    );
    const empty = sentOnce(await run("3.2.1", ["positional-upload"]));

    expect(partsOf(sent)).toEqual([
      { body: '{"id":1}', headers: ["Content-Type: application/json"] },
      { body: "0123456789", headers: ["Content-Type: image/png"] },
      { body: "abc", headers: ["Content-Type: image/png"] },
    ]);
    expect(empty.contentType).toMatch(/^multipart\/mixed; boundary=/u);
    expect(partsOf(empty)).toEqual([]);
  }, 60_000);

  test("MED-15: a prefixEncoding entry beyond the schema's items is unused, a part beyond them is refused before sending, and an optional body with no part is none (3.2.1)", async () => {
    const one = sentOnce(
      await run("3.2.1", ["positional-extra-upload", "--part", file("three.bin")]),
    );
    const two = await run("3.2.1", [
      "positional-extra-upload",
      "--part",
      file("three.bin"),
      "--part",
      file("ten.bin"),
    ]);
    const none = sentOnce(await run("3.2.1", ["positional-extra-upload"]));

    expect(partsOf(one)).toEqual([{ body: "abc", headers: ["Content-Type: text/csv"] }]);
    expect(usage(two)).toEqual(refusedBeforeSending);
    expect([none.body, none.contentType]).toEqual(["", undefined]);
  }, 60_000);

  test("MED-26: an array schema or itemSchema fixes the part order, each position typed by the default table, and minItems and maxItems bound the parts (3.2.1)", async () => {
    const ordered = sentOnce(
      await run("3.2.1", [
        "ordered-upload",
        "--part",
        file("meta.json"),
        "--part",
        file("three.bin"),
        "--part",
        file("ten.bin"),
      ]),
    );
    const few = await run("3.2.1", ["ordered-upload", "--part", file("meta.json")]);
    const many = await run("3.2.1", [
      "ordered-upload",
      ...[1, 2, 3, 4].flatMap(() => ["--part", file("three.bin")]),
    ]);
    const items = sentOnce(
      await run("3.2.1", [
        "stream-upload",
        "--part",
        file("meta.json"),
        "--part",
        file("three.bin"),
      ]),
    );

    expect(partsOf(ordered)).toEqual([
      { body: '{"id":1}', headers: ["Content-Type: application/json"] },
      { body: "abc", headers: ["Content-Type: text/plain"] },
      { body: "0123456789", headers: ["Content-Type: text/plain"] },
    ]);
    expect([usage(few), usage(many)]).toEqual([refusedBeforeSending, refusedBeforeSending]);
    expect(partsOf(items)).toEqual([
      { body: '{"id":1}', headers: ["Content-Type: application/json"] },
      { body: "abc", headers: ["Content-Type: application/json"] },
    ]);
  }, 60_000);
});

describe("RQB, MED and BIN rows through generate()", () => {
  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`RQB-07: content with no entries is refused at element scope (${line})`, async () => {
      const found = await inProcess(withBody(line, { content: {} }));

      expect(summary(found)).toEqual([["RQB-07/empty-content", "refusal", "element", content]]);
    });
  }

  for (const line of ["3.0.4", "3.1.2"] as const) {
    test(`MED-10: encoding on a JSON request body is ignored with a notice (${line})`, async () => {
      const found = await inProcess(
        withBody(line, {
          content: {
            "application/json": {
              encoding: { name: { contentType: "text/plain" } },
              schema: named,
            },
          },
        }),
      );

      expect(summary(found)).toEqual([
        ["MED-10/encoding-ignored", "notice", "element", `${content}/application~1json`],
      ]);
    });

    test(`MED-10: encoding on a JSON response media type is ignored with a notice (${line})`, async () => {
      const found = await inProcess(
        withResponse(line, {
          content: {
            "application/json": {
              encoding: { name: { contentType: "text/plain" } },
              schema: named,
            },
          },
          description: "ok",
        }),
      );

      expect(summary(found)).toEqual([
        [
          "MED-10/encoding-ignored",
          "notice",
          "element",
          "/paths/~1a/get/responses/200/content/application~1json",
        ],
      ]);
    });

    test(`MED-11: an encoding key that names no schema property is refused (${line})`, async () => {
      const found = await inProcess(
        withBody(line, {
          content: {
            "multipart/form-data": {
              encoding: { ghost: { contentType: "text/plain" } },
              schema: named,
            },
          },
        }),
      );

      expect(anchored(found)).toEqual([
        [
          "MED-11/unknown-property",
          "refusal",
          "element",
          `${content}/multipart~1form-data`,
          `${content}/multipart~1form-data/encoding/ghost`,
        ],
      ]);
    });
  }

  test("MED-12: an encoding key that names no schema property is ignored with a notice (3.2.1)", async () => {
    const found = await inProcess(
      withBody("3.2.1", {
        content: {
          "multipart/form-data": {
            encoding: { ghost: { contentType: "text/plain" } },
            schema: named,
          },
        },
      }),
    );

    expect(summary(found)).toEqual([
      [
        "MED-12/absent-property-ignored",
        "notice",
        "element",
        `${content}/multipart~1form-data/encoding/ghost`,
      ],
    ]);
  });

  // The 3.2 schema refuses the combination before the MED rule runs: its code is the line's schema
  // row, so only severity, scope and pointer are stable here.
  test("MED-13: encoding with prefixEncoding is refused by the 3.2 schema", async () => {
    const found = await inProcess(
      withBody("3.2.1", {
        content: {
          "multipart/mixed": {
            encoding: { name: { contentType: "text/plain" } },
            prefixEncoding: [{ contentType: "text/plain" }],
            schema: { type: "array" },
          },
        },
      }),
    );

    expect(
      found.diagnostics.map((diagnostic) => [
        diagnostic.severity,
        diagnostic.scope,
        String(diagnostic.pointer),
      ]),
    ).toEqual([["refusal", "document", `${content}/multipart~1mixed/prefixEncoding`]]);
  });

  test("MED-14: encoding on a JSON body has no effect and is ignored with a notice (3.2.1)", async () => {
    const found = await inProcess(
      withBody("3.2.1", {
        content: {
          "application/json": {
            encoding: { name: { contentType: "text/plain" } },
            schema: named,
          },
        },
      }),
    );

    expect(summary(found)).toEqual([
      ["MED-14/encoding-ignored", "notice", "element", `${content}/application~1json`],
    ]);
  });

  for (const line of lines) {
    test(`MED-24: an unparsable content key is refused once at element scope and the rest generates (${line})`, async () => {
      const found = await inProcess(
        withBody(line, {
          content: { "application/json": { schema: named }, "not a type": { schema: named } },
        }),
      );

      expect(summary(found)).toEqual([
        ["MED-24/invalid-media-type", "refusal", "element", `${content}/not a type`],
      ]);
    });

    test(`MED-25: an object schema on multipart/mixed refuses that alternative at element scope and the rest generates (${line})`, async () => {
      const found = await inProcess(
        withBody(line, {
          content: { "application/json": { schema: named }, "multipart/mixed": { schema: named } },
        }),
      );

      expect(summary(found)).toEqual([
        ["MED-25/unnamed-parts", "refusal", "element", `${content}/multipart~1mixed`],
      ]);
    });
  }

  test("MED-09: a 3.2 Media Type description is ignored with a notice, on a request and a response (design D-OC5)", async () => {
    const request = await inProcess(
      withBody("3.2.1", {
        content: { "application/json": { description: "a name", schema: named } },
      }),
    );
    const response = await inProcess(
      withResponse("3.2.1", {
        content: { "application/json": { description: "a name", schema: named } },
        description: "ok",
      }),
    );

    expect([summary(request), summary(response)]).toEqual([
      [["MED-09/description-ignored", "notice", "element", `${content}/application~1json`]],
      [
        [
          "MED-09/description-ignored",
          "notice",
          "element",
          "/paths/~1a/get/responses/200/content/application~1json",
        ],
      ],
    ]);
  });

  // HT:B15 does not design a multipart/form-data body as an array of name/value objects, so it
  // stays refused until the Mind settles design 15 R77 (1).
  test("MED-26: a multipart/form-data array body of name/value objects stays refused at element scope (3.2.1)", async () => {
    const found = await inProcess(
      withBody("3.2.1", {
        content: {
          "multipart/form-data": {
            schema: {
              items: {
                properties: { name: { type: "string" }, value: { type: "string" } },
                type: "object",
              },
              type: "array",
            },
          },
        },
      }),
    );

    expect(summary(found)).toEqual([
      ["MED-26/array-form-data", "refusal", "element", `${content}/multipart~1form-data`],
    ]);
  });
});
