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

// The Milestone 2 witness for the Encoding Object rule rows ENC-17 to ENC-41: the default
// contentType table, form-urlencoded bytes and order, multipart names, filenames and transfer
// encoding. One generated package per version line, built once, run against the capture server;
// the refusal rows call `generate()` in process. A row the product gets wrong is a `test.todo` with
// what was observed.

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

const fixtures = nodePath.join(repoRoot, "corpus/fixtures/rows/enc-rules");

type Line = "3.0.4" | "3.1.2" | "3.2.1";

const lines: readonly Line[] = ["3.0.4", "3.1.2", "3.2.1"];

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

// Generated packages and input files live under the worktree's git-ignored `work/`, never the
// system temp directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "wt-enc-rules-"));

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

// The UTF-8 bytes of a text, read one byte per character, as the recorded body is.
const utf8 = (text: string): string => latin1(encoder.encode(text));

// Five bytes with a NUL and a control byte, so text handling would show; base64 `YWIAAQo=`.
const small = Uint8Array.from([0x61, 0x62, 0x00, 0x01, 0x0a]);

const three = encoder.encode("abc");

// A basename with a quote, a non-ASCII letter, a space and a percent sequence: the multipart rule
// escapes only the quote, and nothing is percent-decoded or percent-encoded.
const oddName = 'café "q" a%41.bin';

const stdinBytes = encoder.encode("from stdin");

const file = (name: string): string => nodePath.join(work, name);

beforeAll(async () => {
  nodeFs.writeFileSync(file("small.bin"), small);
  nodeFs.writeFileSync(file("three.bin"), three);
  nodeFs.writeFileSync(file(oddName), three);

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
  if (result.exitCode !== 0) {
    throw new Error(`unexpected exit ${String(result.exitCode)}: ${latin1(result.stderr)}`);
  }

  return { exitCode: result.exitCode, requests: capture.requests().slice(before) };
};

const header = (request: RecordedRequest, name: string): string | undefined =>
  request.headers.find(([candidate]) => candidate.toLowerCase() === name)?.[1];

interface Sent {
  readonly body: string;
  readonly contentType: string | undefined;
  readonly target: string;
}

// The one request an invocation sent.
const sentOnce = async (line: Line, args: readonly string[], stdin?: Uint8Array): Promise<Sent> => {
  const exchange = await run(line, args, stdin);
  expect(exchange.requests).toHaveLength(1);

  const [request] = exchange.requests;
  if (request === undefined) {
    throw new Error("the capture server saw no request");
  }

  return {
    body: latin1(request.body),
    contentType: header(request, "content-type"),
    target: request.target,
  };
};

// A form body as the capture server saw it: target, type and bytes.
const formSent = (body: string): Sent => ({
  body,
  contentType: "application/x-www-form-urlencoded",
  target: "/form",
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

const parts = async (
  line: Line,
  args: readonly string[],
  stdin?: Uint8Array,
): Promise<readonly Part[]> => partsOf(await sentOnce(line, args, stdin));

// The disposition line exactly as the writer prints it; `name` and `filename` are already escaped.
const disposition = (name: string, filename?: string): string =>
  filename === undefined
    ? `Content-Disposition: form-data; name="${name}"`
    : `Content-Disposition: form-data; name="${name}"; filename="${filename}"`;

const text = (name: string, body: string, type = "text/plain"): Part => ({
  body,
  headers: [disposition(name), `Content-Type: ${type}`],
});

const filePart = (name: string, filename: string, body: string): Part => ({
  body,
  headers: [disposition(name, filename), "Content-Type: application/octet-stream"],
});

const base64Part = (name: string, filename: string, body: string): Part => ({
  body,
  headers: [
    disposition(name, filename),
    "Content-Transfer-Encoding: base64",
    "Content-Type: application/octet-stream",
  ],
});

describe("ENC rule rows through the built CLI", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`ENC-20: a string part without a format or contentEncoding defaults to text/plain (${line})`, async () => {
        expect(await parts(line, ["parts-upload", "--note", "a b"])).toEqual([text("note", "a b")]);
      }, 60_000);

      test(`ENC-21: number, integer and boolean parts default to text/plain (${line})`, async () => {
        const sent = await parts(line, [
          "parts-upload",
          "--ratio",
          "1.5",
          "--flag",
          "--count",
          "3",
        ]);

        expect(sent).toEqual([text("count", "3"), text("flag", "true"), text("ratio", "1.5")]);
      }, 60_000);

      test(`ENC-22: an object form value is sent as JSON, then percent-encoded (${line})`, async () => {
        const sent = await sentOnce(line, ["form-create", "--meta.b", "2", "--meta.a", "x y"]);

        expect(sent).toEqual(formSent("meta=%7B%22a%22%3A%22x+y%22%2C%22b%22%3A2%7D"));
      }, 60_000);

      test(`ENC-22: an object multipart part is sent as one part of compact JSON under Content-Type: application/json (${line})`, async () => {
        const sent = await parts(line, ["parts-upload", "--meta", '{ "a": "x y" }']);

        expect(sent).toEqual([text("meta", '{"a":"x y"}', "application/json")]);
      }, 60_000);

      test(`ENC-25: a null property is omitted from the body (${line})`, async () => {
        const sent = await sentOnce(line, ["form-create", "--body", '{"gone":null,"name":"n"}']);

        expect(sent).toEqual(formSent("name=n"));
      }, 60_000);

      test(`ENC-29: form pairs follow the schema's property order, not the flags' order (${line})`, async () => {
        const sent = await sentOnce(line, [
          "form-create",
          "--zone",
          "z",
          "--name",
          "n",
          "--meta.a",
          "m",
        ]);

        expect(sent).toEqual(formSent("meta=%7B%22a%22%3A%22m%22%7D&name=n&zone=z"));
      }, 60_000);

      test(`ENC-30: an array repeats its name, once per item, in form and multipart bodies (${line})`, async () => {
        const form = await sentOnce(line, ["form-create", "--tags", "a", "--tags", "b c"]);
        const multipart = await parts(line, ["parts-upload", "--note", "n", "--tags", "a"]);
        const repeated = await parts(line, ["parts-upload", "--tags", "a", "--tags", "b"]);

        expect(form).toEqual(formSent("tags=a&tags=b+c"));
        expect(multipart.map((part) => part.headers[0])).toEqual([
          disposition("note"),
          disposition("tags"),
        ]);
        expect(repeated.map((part) => [part.headers[0], part.body])).toEqual([
          [disposition("tags"), "a"],
          [disposition("tags"), "b"],
        ]);
      }, 60_000);

      test(`ENC-31: a base64 form property reads a file, and its base64 padding is percent-encoded as %3D (${line})`, async () => {
        const sent = await sentOnce(line, ["form-create", "--data", file("small.bin")]);

        expect(sent).toEqual(formSent("data=YWIAAQo%3D"));
      }, 60_000);

      test(`ENC-32: form-data is not percent-encoded: the value and the file name are sent as supplied (${line})`, async () => {
        const sent = await parts(line, [
          "names-upload",
          "--doc",
          file(oddName),
          "--naive",
          "a%41 b&c=d",
        ]);

        expect(sent).toEqual([
          filePart("doc", utf8("café %22q%22 a%41.bin"), "abc"),
          text(utf8("naïve"), "a%41 b&c=d"),
        ]);
      }, 60_000);

      test(`ENC-34: each part carries form-data disposition with its property name; a file part's filename is its basename, or the part name for stdin (${line})`, async () => {
        const named = await parts(line, [
          "names-upload",
          "--x-y",
          'v "1"',
          "--doc",
          file("three.bin"),
        ]);
        const fromStdin = await parts(line, ["names-upload", "--doc", "-"], stdinBytes);

        expect(named).toEqual([filePart("doc", "three.bin", "abc"), text("x%22y", 'v "1"')]);
        expect(fromStdin).toEqual([filePart("doc", "doc", "from stdin")]);
      }, 60_000);

      test(`ENC-35: non-ASCII part names and filenames are sent as raw UTF-8 (${line})`, async () => {
        const sent = await parts(line, ["names-upload", "--naive", "é", "--doc", file(oddName)]);

        expect(sent).toEqual([
          filePart("doc", utf8("café %22q%22 a%41.bin"), "abc"),
          text(utf8("naïve"), utf8("é")),
        ]);
      }, 60_000);

      test(`ENC-36: no Content-Transfer-Encoding is added unless declared, and a declared one is sent once (${line})`, async () => {
        const plain = await parts(line, [
          "parts-upload",
          "--note",
          "n",
          "--blob",
          file("three.bin"),
        ]);
        const declared = await parts(line, ["declared-upload", "--file", file("three.bin")]);

        expect(plain).toEqual([filePart("blob", "three.bin", "abc"), text("note", "n")]);
        expect(declared).toEqual([base64Part("file", "three.bin", "YWJj")]);
      }, 60_000);
    });
  }

  for (const line of ["3.0.4", "3.1.2"] as const) {
    test(`ENC-23: an array part's type comes from its items schema (${line})`, async () => {
      const sent = await parts(line, ["parts-upload", "--nums", "1", "--tags", "a"]);

      expect(sent).toEqual([text("nums", "1"), text("tags", "a")]);
    }, 60_000);

    test(`ENC-27: a form body is encoded once, RFC 1866 compatible, after serializing complex values (${line})`, async () => {
      const sent = await sentOnce(line, [
        "form-create",
        "--name",
        "a b&c=d/é~*+%",
        "--meta.a",
        "x",
      ]);

      expect(sent).toEqual(
        formSent("meta=%7B%22a%22%3A%22x%22%7D&name=a+b%26c%3Dd%2F%C3%A9%7E*%2B%25"),
      );
    }, 60_000);
  }

  test("ENC-23: a 3.0 array of format: binary items sends file parts under application/octet-stream", async () => {
    const sent = await parts("3.0.4", [
      "parts-upload",
      "--files",
      file("three.bin"),
      "--files",
      file("small.bin"),
    ]);

    expect(sent).toEqual([
      filePart("files", "three.bin", "abc"),
      filePart("files", "small.bin", latin1(small)),
    ]);
  }, 60_000);

  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`ENC-17: a part with no type defaults to application/octet-stream (${line})`, async () => {
      expect(await parts(line, ["parts-upload", "--blob", file("three.bin")])).toEqual([
        filePart("blob", "three.bin", "abc"),
      ]);
    }, 60_000);

    test(`ENC-19: a string part with contentEncoding defaults to application/octet-stream (${line})`, async () => {
      const [part] = await parts(line, ["parts-upload", "--encoded", file("small.bin")]);

      expect(part?.headers.at(-1)).toBe("Content-Type: application/octet-stream");
    }, 60_000);

    test(`ENC-37: contentEncoding base64 on a part sends the file's base64 under Content-Transfer-Encoding: base64 (${line})`, async () => {
      const sent = await parts(line, ["parts-upload", "--encoded", file("small.bin")]);

      expect(sent).toEqual([base64Part("encoded", "small.bin", "YWIAAQo=")]);
    }, 60_000);

    test(`ENC-37: identity contentEncoding binary, 7bit and 8BIT parts send the file's raw bytes with no Content-Transfer-Encoding (${line})`, async () => {
      const sent = await parts(line, [
        "parts-upload",
        "--binary",
        file("small.bin"),
        "--seven",
        file("three.bin"),
        "--eight",
        file("three.bin"),
      ]);

      expect(sent).toEqual([
        filePart("binary", "small.bin", latin1(small)),
        filePart("eight", "three.bin", "abc"),
        filePart("seven", "three.bin", "abc"),
      ]);
    }, 60_000);

    test(`ENC-40: an exploded form-style part sends its name and each raw value as a text/plain part (${line})`, async () => {
      const sent = await parts(line, ["styled-upload", "--tags", "a b", "--tags", "c%41"]);

      expect(sent).toEqual([text("tags", "a b"), text("tags", "c%41")]);
    }, 60_000);
  }

  test("ENC-18: 3.0 format: binary and format: byte string parts default to application/octet-stream", async () => {
    const sent = await parts("3.0.4", [
      "parts-upload",
      "--bin",
      file("three.bin"),
      "--byte",
      file("small.bin"),
    ]);

    expect(sent).toEqual([
      filePart("bin", "three.bin", "abc"),
      base64Part("byte", "small.bin", "YWIAAQo="),
    ]);
  }, 60_000);

  test("ENC-26: a 3.0 part with no type is treated as untyped 3.1: application/octet-stream", async () => {
    expect(await parts("3.0.4", ["parts-upload", "--blob", file("three.bin")])).toEqual([
      filePart("blob", "three.bin", "abc"),
    ]);
  }, 60_000);

  test("ENC-38: 3.0 format: byte on a part sends the file's base64 under Content-Transfer-Encoding: base64", async () => {
    const sent = await parts("3.0.4", ["parts-upload", "--byte", file("small.bin")]);

    expect(sent).toEqual([base64Part("byte", "small.bin", "YWIAAQo=")]);
  }, 60_000);

  test("ENC-24: each item part of a top-level array of strings or integers takes its item type's default text/plain (3.2.1)", async () => {
    const sent = await parts("3.2.1", ["parts-upload", "--nums", "1", "--tags", "a"]);

    expect(sent).toEqual([text("nums", "1"), text("tags", "a")]);
  }, 60_000);

  test("ENC-28: a 3.2 form body is percent-encoded per WHATWG URL, once", async () => {
    const sent = await sentOnce("3.2.1", [
      "form-create",
      "--name",
      "a b&c=d/é~*+%",
      "--meta.a",
      "x",
    ]);

    expect(sent).toEqual(
      formSent("meta=%7B%22a%22%3A%22x%22%7D&name=a+b%26c%3Dd%2F%C3%A9%7E*%2B%25"),
    );
  }, 60_000);
});

// In process generation of a small document of a line; the diagnostics of a refused run are the
// refusal's.
const withMultipart = (line: Line, media: Members): Members => ({
  info: { title: "Encoding rule rows", version: "1.0.0" },
  openapi: line,
  paths: {
    "/a": {
      post: {
        requestBody: { content: { "multipart/form-data": media } },
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

interface Generated {
  readonly diagnostics: readonly Diagnostic[];
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
    return { diagnostics: exit.value.diagnostics };
  }

  const [failure] = exit.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" && reason.error instanceof GenerateRefused ? [reason.error] : [],
  );
  if (failure === undefined) {
    throw new Error(`generate failed for a reason other than a refusal: ${String(exit.cause)}`);
  }

  return { diagnostics: failure.diagnostics };
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

const media = "/paths/~1a/post/requestBody/content/multipart~1form-data";

const base64Schema = (line: Line): Members =>
  line === "3.0.4"
    ? { format: "byte", type: "string" }
    : { contentEncoding: "base64", type: "string" };

describe("ENC rule rows through generate()", () => {
  for (const line of ["3.0.4", "3.1.2"] as const) {
    test(`ENC-33: a multipart body without a schema is refused at element scope (${line})`, async () => {
      const found = await inProcess(withMultipart(line, {}));

      expect(summary(found)).toEqual([["ENC-33/missing-schema", "refusal", "element", media]]);
    });
  }

  for (const line of lines) {
    test(`ENC-39: a Content-Transfer-Encoding header schema that excludes base64 on a base64 part is refused (${line})`, async () => {
      const found = await inProcess(
        withMultipart(line, {
          encoding: {
            file: {
              headers: {
                "Content-Transfer-Encoding": { schema: { enum: ["8bit"], type: "string" } },
              },
            },
          },
          schema: { properties: { file: base64Schema(line) }, type: "object" },
        }),
      );

      expect(anchored(found)).toEqual([
        [
          "ENC-39/conflicting-transfer-encoding",
          "refusal",
          "element",
          media,
          `${media}/encoding/file/headers/Content-Transfer-Encoding/schema/enum`,
        ],
      ]);
    });
  }

  for (const line of ["3.1.2", "3.2.1"] as const) {
    for (const style of ["spaceDelimited", "pipeDelimited", "deepObject"] as const) {
      test(`ENC-40: a ${style} multipart part is refused alone at element scope (${line})`, async () => {
        const found = await inProcess(
          withMultipart(line, {
            encoding: { tags: { style } },
            schema: {
              properties: {
                note: { type: "string" },
                tags: { items: { type: "string" }, type: "array" },
              },
              type: "object",
            },
          }),
        );

        expect(summary(found)).toEqual([
          ["ENC-40/unsupported-part-style", "refusal", "element", `${media}/encoding/tags`],
        ]);
      });
    }
  }

  test("ENC-41: contentMediaType and contentEncoding in a 3.0 multipart part schema are refused by 3.0 schema validation", async () => {
    const found = await inProcess(
      withMultipart("3.0.4", {
        schema: {
          properties: {
            file: { contentEncoding: "identity", contentMediaType: "image/png", type: "string" },
          },
          type: "object",
        },
      }),
    );

    expect(summary(found)).toEqual([
      [
        "VAL-02/schema-invalid",
        "refusal",
        "document",
        `${media}/schema/properties/file/contentEncoding`,
      ],
      [
        "VAL-02/schema-invalid",
        "refusal",
        "document",
        `${media}/schema/properties/file/contentMediaType`,
      ],
    ]);
  });
});
