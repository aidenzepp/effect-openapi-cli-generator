import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunCrypto, BunFileSystem, BunPath } from "@effect/platform-bun";
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

// The Milestone 2 witness for the Encoding Object field and style rows ENC-01 to ENC-16: part types
// from `contentType`, part headers, `style`, `explode` and `allowReserved` on form and multipart
// bodies, and 3.2 nested encoding. One generated package per version line, built once, run against
// the capture server; the diagnostic rows call `generate()` in process. A row the product gets
// wrong is a `test.todo` with what was observed. One nested level is sent: by name (ENC-07, ENC-16)
// since M3-MP2, by position (ENC-08, ENC-09) since M3-MP3.

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

const fixtures = nodePath.join(repoRoot, "corpus/fixtures/rows/enc-fields");

type Line = "3.0.4" | "3.1.2" | "3.2.1";

const lines: readonly Line[] = ["3.0.4", "3.1.2", "3.2.1"];

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layerDigest);

// Generated packages and input files live under the worktree's git-ignored `work/`, never the
// system temp directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "wt-enc-fields-"));

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

const file = (name: string): string => nodePath.join(work, name);

beforeAll(async () => {
  nodeFs.writeFileSync(file("three.bin"), encoder.encode("abc"));

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

const header = (request: RecordedRequest, name: string): string | undefined =>
  request.headers.find(([candidate]) => candidate.toLowerCase() === name)?.[1];

interface Sent {
  readonly body: string;
  readonly contentType: string | undefined;
  readonly target: string;
}

// One invocation of the line's built CLI against the bound server. `runBin` is asynchronous, so
// the in-process capture server keeps answering.
const invoke = (line: Line, args: readonly string[]) => {
  const generated = packages.get(line);
  if (generated === undefined) {
    throw new Error(`no package built for ${line}`);
  }

  return Effect.runPromise(
    runBin(generated, {
      args: ["--server", "0", "--server-variable", `port=${port}`, ...args],
      stdin: new Uint8Array(),
      timeoutMs: 30_000,
    }).pipe(Effect.provide(layer)),
  );
};

// The one request an invocation of the line's built CLI sent to the bound server.
const sentOnce = async (line: Line, args: readonly string[]): Promise<Sent> => {
  const before = capture.requests().length;
  const result = await invoke(line, args);
  if (result.exitCode !== 0) {
    throw new Error(`unexpected exit ${String(result.exitCode)}: ${latin1(result.stderr)}`);
  }

  const requests = capture.requests().slice(before);
  expect(requests).toHaveLength(1);

  const [request] = requests;
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

const form = (line: Line, args: readonly string[]): Promise<Sent> =>
  sentOnce(line, ["form-send", ...args]);

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

const parts = async (line: Line, args: readonly string[]): Promise<readonly Part[]> =>
  partsOf(await sentOnce(line, ["parts-send", ...args]));

const text = (name: string, body: string, type = "text/plain"): Part => ({
  body,
  headers: [`Content-Disposition: form-data; name="${name}"`, `Content-Type: ${type}`],
});

// A nested part (ENC-07, ENC-16): its outer headers, the nested Content-Type's boundary replaced by
// `<nested>`, and its nested parts, split at that boundary.
interface NestedSent {
  readonly headers: readonly string[];
  readonly parts: readonly Part[];
}

const withoutBoundary = (part: Part): NestedSent => {
  const at = part.headers.findIndex((line) => line.startsWith("Content-Type: multipart/"));
  const boundary = /; boundary=(?<boundary>.+)$/u.exec(part.headers[at] ?? "")?.groups?.boundary;
  if (boundary === undefined) {
    throw new Error("the nested part's Content-Type names no boundary");
  }

  const segments = part.body.split(`--${boundary}`);
  expect(segments.at(-1)).toBe("--");

  return {
    headers: part.headers.map((line, index) =>
      index === at ? line.replace(boundary, "<nested>") : line,
    ),
    parts: segments.slice(1, -1).map((segment) => {
      const headEnd = segment.indexOf("\r\n\r\n");

      return {
        body: segment.slice(headEnd + 4, -2),
        headers: segment.slice(2, headEnd).split("\r\n"),
      };
    }),
  };
};

const nestedSent = async (args: readonly string[]): Promise<readonly Part[]> =>
  partsOf(await sentOnce("3.2.1", ["nested-send", ...args]));

const nestedRun = (args: readonly string[]) => invoke("3.2.1", ["nested-send", ...args]);

const positionsSent = async (args: readonly string[]): Promise<readonly Part[]> =>
  partsOf(await sentOnce("3.2.1", ["positions-send", ...args]));

const positionsRun = (args: readonly string[]) => invoke("3.2.1", ["positions-send", ...args]);

describe("ENC field rows through the built CLI", () => {
  for (const line of lines) {
    describe(line, () => {
      test(`ENC-01: an Encoding Object applies to the part its key names, and only that part (${line})`, async () => {
        const sent = await parts(line, ["--img", file("three.bin"), "--note", "n"]);

        expect(sent).toEqual([
          {
            body: "abc",
            headers: [
              'Content-Disposition: form-data; name="img"; filename="three.bin"',
              "Content-Type: image/png",
            ],
          },
          text("note", "n"),
        ]);
      }, 60_000);

      test(`ENC-02: a declared contentType is the part's Content-Type (${line})`, async () => {
        expect(await parts(line, ["--csv", "a,b"])).toEqual([text("csv", "a,b", "text/csv")]);
      }, 60_000);

      test(`ENC-02: a form contentType equal to the default type is accepted and changes nothing on the wire (${line})`, async () => {
        expect(await form(line, ["--typed", "a b"])).toEqual(formSent("typed=a+b"));
      }, 60_000);

      test(`ENC-04: style spaceDelimited, pipeDelimited and deepObject shape a form value as for a query parameter, encoded once (${line})`, async () => {
        const spaced = await form(line, ["--spaced", "a", "--spaced", "b"]);
        const pipes = await form(line, ["--pipes", "a", "--pipes", "b"]);
        const deep = await form(line, ["--deep.a", "x", "--deep.b", "2"]);

        expect(spaced).toEqual(formSent("spaced=a+b"));
        expect(pipes).toEqual(formSent("pipes=a%7Cb"));
        expect(deep).toEqual(formSent("deep%5Ba%5D=x&deep%5Bb%5D=2"));
      }, 60_000);

      test(`ENC-05: explode false joins a form array with a raw comma delimiter, as the query vector does, and encodes a comma inside a value (${line})`, async () => {
        const sent = await form(line, ["--joined", "a", "--joined", "b c,d"]);

        expect(sent).toEqual(formSent("joined=a,b+c%2Cd"));
      }, 60_000);

      test(`ENC-06: allowReserved keeps reserved characters in a form value, except the delimiters = & + (${line})`, async () => {
        const sent = await form(line, ["--reserved", "a/b?c:d@e!$'()*,;&=+ f"]);

        expect(sent).toEqual(formSent("reserved=a/b?c:d@e!$'()*,;%26%3D%2B+f"));
      }, 60_000);

      test(`ENC-11: a Content-Type entry in part headers is not sent; the part type comes from contentType (${line})`, async () => {
        expect(await parts(line, ["--typed", "a,b"])).toEqual([text("typed", "a,b", "text/csv")]);
      }, 60_000);

      test(`ENC-12: style fields on a form value take the query-parameter defaults (${line})`, async () => {
        const listed = await form(line, ["--listed", "a", "--listed", "b"]);
        const deepDefault = await form(line, ["--deep-default.a", "x", "--deep-default.b", "2"]);

        expect(listed).toEqual(formSent("listed=a&listed=b"));
        expect(deepDefault).toEqual(formSent("deepDefault%5Ba%5D=x&deepDefault%5Bb%5D=2"));
      }, 60_000);

      test(`ENC-13: an explicit style, explode or allowReserved makes contentType ignored, each field alone (${line})`, async () => {
        const styled = await form(line, ["--styled.a", "x", "--styled.b", "2"]);
        const unexploded = await form(line, ["--unexploded.a", "x", "--unexploded.b", "2"]);
        const reserving = await form(line, ["--reserving.a", "x/y", "--reserving.b", "2"]);

        expect(styled).toEqual(formSent("a=x&b=2"));
        expect(unexploded).toEqual(formSent("unexploded=a,x,b,2"));
        expect(reserving).toEqual(formSent("a=x/y&b=2"));
      }, 60_000);
    });
  }

  test("ENC-14: in 3.0 one explicit style field takes defaults for the others, and none encodes by contentType only", async () => {
    const joined = await form("3.0.4", ["--joined", "a", "--joined", "b"]);
    const tags = await form("3.0.4", ["--tags", "a", "--tags", "b"]);

    expect(joined).toEqual(formSent("joined=a,b"));
    expect(tags).toEqual(formSent("tags=a&tags=b"));
  }, 60_000);

  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`ENC-15: multipart/form-data values are not percent-encoded, and allowReserved has no effect (${line})`, async () => {
      const value = "a/b c%41&=+é";
      const sent = await parts(line, ["--note", value, "--verbatim", value]);

      expect(sent).toEqual([text("note", utf8(value)), text("verbatim", utf8(value))]);
    }, 60_000);
  }
});

// In process generation of a small document of a line; the diagnostics of a refused run are the
// refusal's.
const withBody = (line: Line, mediaType: string, media: Members): Members => ({
  info: { title: "Encoding field rows", version: "1.0.0" },
  openapi: line,
  paths: {
    "/a": {
      post: {
        requestBody: { content: { [mediaType]: media } },
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

const multipart = "multipart/form-data";

const urlEncoded = "application/x-www-form-urlencoded";

interface Generated {
  // The emitted commands' paths; empty for a refused run.
  readonly commands: readonly (readonly string[])[];
  readonly diagnostics: readonly Diagnostic[];
  /**
   * The generated package directory of a run that was not refused.
   */
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

// Each diagnostic as code, severity, scope, pointer, and the pointer of its first related entry
// (the keyword that caused a refusal anchored at its media type).
const summary = (found: Generated) =>
  found.diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.severity,
    diagnostic.scope,
    String(diagnostic.pointer),
    String(diagnostic.related?.[0]?.pointer),
  ]);

const multipartAt = "/paths/~1a/post/requestBody/content/multipart~1form-data";

const formAt = "/paths/~1a/post/requestBody/content/application~1x-www-form-urlencoded";

const string: Members = { type: "string" };

const objectOf = (properties: Members): Members => ({ properties, type: "object" });

const strings: Members = { items: string, type: "array" };

const mixedPart = "multipart/mixed";

// What a refused operation leaves: the one EMT-1 refusal, no command, and a CLI that never calls
// the operation's request builder, so nothing can be sent for it.
const refusedOperation = (found: Generated) => ({
  builderCalled: nodeFs
    .readFileSync(nodePath.join(found.out ?? "", "src/cli/root.ts"), "utf-8")
    .includes("postA"),
  commands: found.commands,
  diagnostics: summary(found),
});

const unsupportedBody = {
  builderCalled: false,
  commands: [],
  diagnostics: [["EMT-1/unsupported-body", "refusal", "operation", "/paths/~1a/post", "undefined"]],
};

describe("ENC field rows through generate()", () => {
  for (const line of lines) {
    test(`ENC-02: a multipart contentType that is not a list of media ranges is refused at element scope (${line})`, async () => {
      const found = await inProcess(
        withBody(line, multipart, {
          encoding: { a: { contentType: "not a type" } },
          schema: objectOf({ a: string }),
        }),
      );

      expect(summary(found)).toEqual([
        [
          "ENC-02/invalid-content-type",
          "refusal",
          "element",
          multipartAt,
          `${multipartAt}/encoding/a/contentType`,
        ],
      ]);
    });

    test(`ENC-02: a form contentType other than the default type refuses the optional property at field scope (${line})`, async () => {
      const found = await inProcess(
        withBody(line, urlEncoded, {
          encoding: { a: { contentType: "application/json" } },
          schema: objectOf({ a: string }),
        }),
      );

      expect(summary(found)).toEqual([
        [
          "ENC-02/form-content-type",
          "refusal",
          "field",
          `${formAt}/encoding/a`,
          `${formAt}/encoding/a/contentType`,
        ],
      ]);
    });

    // The built CLI sending the header values in the part's head is tests/emit/phdr.test.ts.
    test(`ENC-03: each declared part header is a --<part>-<header> flag serialized as a header parameter, and the writer's own headers get a notice (${line})`, async () => {
      const found = await inProcess(
        withBody(line, multipart, {
          encoding: {
            a: {
              headers: {
                "Content-Transfer-Encoding": { schema: string },
                "X-Trace": { required: true, schema: string },
              },
            },
          },
          schema: objectOf({ a: string }),
        }),
      );
      const cli = nodeFs.readFileSync(nodePath.join(found.out ?? "", "src/cli/root.ts"), "utf-8");

      expect(summary(found)).toEqual([
        [
          "ENC-03/writer-owned-header",
          "notice",
          "element",
          `${multipartAt}/encoding/a/headers/Content-Transfer-Encoding`,
          "undefined",
        ],
      ]);
      expect(cli).toContain('["a-x-trace", Option.isSome(flags.aXTrace), true]');
      expect(cli).toContain('Serialize.header("X-Trace", Option.getOrUndefined(flags.aXTrace), {');
      expect(cli).not.toContain("Content-Transfer-Encoding");
    });

    test(`ENC-10: a part contentType of two media types is a --<part>-content-type choice, required with the part and with no sniffing default (${line})`, async () => {
      const found = await inProcess(
        withBody(line, multipart, {
          encoding: { a: { contentType: "text/csv, text/plain" } },
          schema: objectOf({ a: string }),
        }),
      );
      const cli = nodeFs.readFileSync(nodePath.join(found.out ?? "", "src/cli/root.ts"), "utf-8");

      expect(summary(found)).toEqual([]);
      expect(cli).toContain('Flag.Literals("a-content-type", ["text/csv", "text/plain"])');
      expect(cli).toContain('["a-content-type", Option.isSome(flags.aContentType), true]');
    });

    test(`ENC-11: part headers under a form alternative are ignored with a notice (${line})`, async () => {
      const found = await inProcess(
        withBody(line, urlEncoded, {
          encoding: { a: { headers: { "X-Trace": { schema: string } } } },
          schema: objectOf({ a: string }),
        }),
      );

      expect(summary(found)).toEqual([
        [
          "ENC-11/headers-ignored",
          "notice",
          "element",
          `${formAt}/encoding/a/headers`,
          "undefined",
        ],
      ]);
    });

    test(`ENC-11: a Content-Type entry in multipart part headers is ignored with a notice (${line})`, async () => {
      const found = await inProcess(
        withBody(line, multipart, {
          encoding: {
            a: { contentType: "text/csv", headers: { "Content-Type": { schema: string } } },
          },
          schema: objectOf({ a: string }),
        }),
      );

      expect(summary(found)).toEqual([
        [
          "ENC-11/content-type-header-ignored",
          "notice",
          "element",
          `${multipartAt}/encoding/a/headers/Content-Type`,
          "undefined",
        ],
      ]);
    });
  }

  for (const line of ["3.0.4", "3.1.2"] as const) {
    test(`ENC-03: a part header name that is not an HTTP field name refuses the multipart alternative at element scope (${line})`, async () => {
      const found = await inProcess(
        withBody(line, multipart, {
          encoding: { a: { headers: { "X Bad": { schema: string } } } },
          schema: objectOf({ a: string }),
        }),
      );

      expect(summary(found)).toEqual([
        [
          "ENC-03/invalid-header-name",
          "refusal",
          "element",
          multipartAt,
          `${multipartAt}/encoding/a/headers/X Bad`,
        ],
        [
          "HDR-01/invalid-header-name",
          "refusal",
          "element",
          `${multipartAt}/encoding/a/headers/X Bad`,
          "undefined",
        ],
      ]);
    });

    test(`ENC-12: a form deepObject with explode omitted carries a notice per occurrence, as for STY-26 (${line})`, async () => {
      const found = await inProcess(
        withBody(line, urlEncoded, {
          encoding: { a: { style: "deepObject" }, b: { style: "deepObject" } },
          schema: objectOf({ a: objectOf({ x: string }), b: objectOf({ y: string }) }),
        }),
      );

      expect(summary(found).filter(([code]) => code === "ENC-12/explode-no-effect")).toEqual([
        ["ENC-12/explode-no-effect", "notice", "element", `${formAt}/encoding/a`, "undefined"],
        ["ENC-12/explode-no-effect", "notice", "element", `${formAt}/encoding/b`, "undefined"],
      ]);
    });
  }

  test("ENC-12: style fields on a 3.0 multipart part are ignored with a notice, and the part keeps its default type", async () => {
    const found = await inProcess(
      withBody("3.0.4", multipart, {
        encoding: { a: { explode: false, style: "form" } },
        schema: objectOf({ a: strings }),
      }),
    );

    expect(summary(found)).toEqual([
      ["ENC-12/style-ignored", "notice", "element", `${multipartAt}/encoding/a`, "undefined"],
    ]);
  });

  for (const line of ["3.1.2", "3.2.1"] as const) {
    test(`ENC-13: a multipart part with style and contentType ignores contentType with a notice (${line})`, async () => {
      const found = await inProcess(
        withBody(line, multipart, {
          encoding: { a: { contentType: "text/csv", style: "form" } },
          schema: objectOf({ a: strings }),
        }),
      );

      expect(summary(found)).toEqual([
        [
          "ENC-13/content-type-ignored",
          "notice",
          "element",
          `${multipartAt}/encoding/a`,
          "undefined",
        ],
      ]);
    });
  }

  test("ENC-07: a nested encoding under a form alternative is ignored with a notice (3.2.1)", async () => {
    const found = await inProcess(
      withBody("3.2.1", urlEncoded, {
        encoding: { a: { encoding: { x: {} } } },
        schema: objectOf({ a: objectOf({ x: string }) }),
      }),
    );

    expect(summary(found)).toEqual([
      [
        "ENC-07/nested-encoding-ignored",
        "notice",
        "element",
        `${formAt}/encoding/a/encoding`,
        "undefined",
      ],
    ]);
  });

  test("ENC-08: a nested prefixEncoding under a form alternative is ignored with a notice (3.2.1)", async () => {
    const found = await inProcess(
      withBody("3.2.1", urlEncoded, {
        encoding: { a: { prefixEncoding: [{}] } },
        schema: objectOf({ a: { prefixItems: [string], type: "array" } }),
      }),
    );

    expect(summary(found)).toEqual([
      [
        "ENC-08/prefix-encoding-ignored",
        "notice",
        "element",
        `${formAt}/encoding/a/prefixEncoding`,
        "undefined",
      ],
    ]);
  });

  test("ENC-09: a nested itemEncoding under a form alternative is ignored with a notice (3.2.1)", async () => {
    const found = await inProcess(
      withBody("3.2.1", urlEncoded, {
        encoding: { a: { itemEncoding: {} } },
        schema: objectOf({ a: strings }),
      }),
    );

    expect(summary(found)).toEqual([
      [
        "ENC-09/item-encoding-ignored",
        "notice",
        "element",
        `${formAt}/encoding/a/itemEncoding`,
        "undefined",
      ],
    ]);
  });

  // Milestone 3 sends one nested level: by name (M3-MP2) and by position (M3-MP3).
  test("ENC-07: a nested encoding by name under a multipart/mixed part sends one nested part from its dotted part flags, in nested property order, with no nested part names (3.2.1)", async () => {
    const sent = await nestedSent([
      "--envelope.scan",
      file("three.bin"),
      "--envelope.note",
      "n",
      "--envelope.meta",
      '{"id":1}',
    ]);

    expect(sent.map(withoutBoundary)).toEqual([
      {
        headers: [
          'Content-Disposition: form-data; name="envelope"',
          "Content-Type: multipart/mixed; boundary=<nested>",
        ],
        parts: [
          { body: '{"id":1}', headers: ["Content-Type: application/json"] },
          { body: "n", headers: ["Content-Type: text/plain"] },
          { body: "abc", headers: ["Content-Type: image/png"] },
        ],
      },
    ]);
  }, 60_000);

  test("ENC-07: a nested part none of whose dotted part flags is given is not sent (3.2.1)", async () => {
    const sent = await nestedSent(["--form.y", "2"]);

    expect(sent.map(({ headers }) => headers[0])).toEqual([
      'Content-Disposition: form-data; name="form"',
    ]);
  }, 60_000);

  test("ENC-08: a nested prefixEncoding under a multipart/mixed part sends one nested part from the part's repeated file flag, file i under prefixEncoding[i], with no nested names (3.2.1)", async () => {
    nodeFs.writeFileSync(file("meta.json"), '{"id":1}');
    nodeFs.writeFileSync(file("rows.csv"), "a,b");

    const sent = await positionsSent(["--pages", file("meta.json"), "--pages", file("rows.csv")]);

    expect(sent.map(withoutBoundary)).toEqual([
      {
        headers: [
          'Content-Disposition: form-data; name="pages"',
          "Content-Type: multipart/mixed; boundary=<nested>",
        ],
        parts: [
          { body: '{"id":1}', headers: ["Content-Type: application/json"] },
          { body: "a,b", headers: ["Content-Type: text/csv"] },
        ],
      },
    ]);
  }, 60_000);

  test("ENC-08: a part nested by position with no itemEncoding takes at most its prefixEncoding count of files, else exits 2 and nothing is sent (3.2.1)", async () => {
    const before = capture.requests().length;
    const over = await positionsRun([
      "--pages",
      file("three.bin"),
      "--pair",
      file("three.bin"),
      "--pair",
      file("three.bin"),
    ]);
    const between = capture.requests().length;
    const sent = await positionsSent(["--pages", file("three.bin"), "--pair", file("three.bin")]);

    expect([over.exitCode, between - before]).toEqual([2, 0]);
    expect(sent.map(withoutBoundary).map(({ parts: nested }) => nested)).toEqual([
      [{ body: "abc", headers: ["Content-Type: application/json"] }],
      [{ body: "abc", headers: ["Content-Type: text/plain"] }],
    ]);
  }, 60_000);

  test("ENC-09: a nested itemEncoding sends every file after the nested prefixEncoding under its rule (3.2.1)", async () => {
    const sent = await positionsSent([
      "--pages",
      file("three.bin"),
      "--pages",
      file("three.bin"),
      "--pages",
      file("three.bin"),
      "--pages",
      file("three.bin"),
    ]);

    expect(
      sent.map(withoutBoundary).map(({ parts: nested }) => nested.map(({ headers }) => headers)),
    ).toEqual([
      [
        ["Content-Type: application/json"],
        ["Content-Type: text/csv"],
        ["Content-Type: image/png"],
        ["Content-Type: image/png"],
      ],
    ]);
  }, 60_000);

  test("ENC-09: a nested itemEncoding is a nested item rule, not a refusal, and the operation is generated (3.2.1)", async () => {
    const found = await inProcess(
      withBody("3.2.1", multipart, {
        encoding: { a: { contentType: mixedPart, itemEncoding: { contentType: "image/png" } } },
        schema: objectOf({ a: strings }),
      }),
    );

    expect(found.commands.length).toBe(1);
    expect(summary(found)).toEqual([]);
  });

  test("ENC-16: one nested level is sent: a multipart/form-data part's nested parts carry their names and rules (3.2.1)", async () => {
    const sent = await nestedSent(["--form.y", "2", "--form.x", "a,b"]);

    expect(sent.map(withoutBoundary)).toEqual([
      {
        headers: [
          'Content-Disposition: form-data; name="form"',
          "Content-Type: multipart/form-data; boundary=<nested>",
        ],
        parts: [
          {
            body: "a,b",
            headers: ['Content-Disposition: form-data; name="x"', "Content-Type: text/csv"],
          },
          {
            body: "2",
            headers: ['Content-Disposition: form-data; name="y"', "Content-Type: text/plain"],
          },
        ],
      },
    ]);
  }, 60_000);

  test("ENC-16: a nested part is asserted as its object, so a missing required nested member exits 2 and nothing is sent (3.2.1)", async () => {
    const before = capture.requests().length;
    const missing = await nestedRun(["--form.x", "a"]);
    const between = capture.requests().length;
    const given = await nestedRun(["--form.x", "a", "--form.y", "2"]);

    expect([missing.exitCode, between - before]).toEqual([2, 0]);
    expect([given.exitCode, capture.requests().length - between]).toEqual([0, 1]);
  }, 60_000);

  test("ENC-08: one nested encoding level by position generates the operation with no refusal (3.2.1)", async () => {
    const byPosition = await inProcess(
      withBody("3.2.1", multipart, {
        encoding: { a: { contentType: mixedPart, prefixEncoding: [{ contentType: mixedPart }] } },
        schema: objectOf({ a: strings }),
      }),
    );

    expect([byPosition.commands.length, summary(byPosition)]).toEqual([1, []]);
  });

  // A part nested by position is one repeated file flag, so no position is left without a flag
  // (design 8.5 at generation, the Mind's ruling on M3-MP3): a required one is checked for presence.
  test("ENC-09: a required part nested by position gets its repeated file flag: with no file it exits 2 before any request, with one it is sent (3.2.1)", async () => {
    const before = capture.requests().length;
    const missing = await positionsRun(["--pair", file("three.bin")]);
    const between = capture.requests().length;
    const given = await positionsRun(["--pages", file("three.bin")]);

    expect([missing.exitCode, between - before]).toEqual([2, 0]);
    expect([given.exitCode, capture.requests().length - between]).toEqual([0, 1]);
  }, 60_000);

  // A nested property that gets no flag (an array of files) is never left to fail every run: a
  // required one makes its part unrepresentable, so a required part refuses the operation and an
  // optional part is not offered (design 8.5 at generation, the Mind's ruling on M3-MP3).
  test("ENC-07: a required nested property with no flag refuses the operation when its part is required, so nothing is sent (3.2.1)", async () => {
    const files: Members = { items: { format: "binary", type: "string" }, type: "array" };
    const found = await inProcess(
      withBody("3.2.1", multipart, {
        encoding: { a: { contentType: mixedPart, encoding: { note: {} } } },
        schema: {
          properties: { a: { ...objectOf({ files, note: string }), required: ["files"] } },
          required: ["a"],
          type: "object",
        },
      }),
    );

    expect(refusedOperation(found)).toEqual({
      ...unsupportedBody,
      diagnostics: [
        ["EMT-1/unsupported-body", "refusal", "operation", "/paths/~1a/post", "undefined"],
        ["RQB-03/unnamed-property", "notice", "element", multipartAt, "undefined"],
      ],
    });
  });

  test("ENC-07: a required nested property with no flag leaves an optional part without flags, so the part is never sent half-built (3.2.1)", async () => {
    const files: Members = { items: { format: "binary", type: "string" }, type: "array" };
    const found = await inProcess(
      withBody("3.2.1", multipart, {
        encoding: { a: { contentType: mixedPart, encoding: { note: {} } } },
        schema: objectOf({
          a: { ...objectOf({ files, note: string }), required: ["files"] },
          b: string,
        }),
      }),
    );
    const cli = nodeFs.readFileSync(nodePath.join(found.out ?? "", "src/cli/root.ts"), "utf-8");

    expect([found.commands.length, cli.includes('"a.note"'), cli.includes('"b"')]).toEqual([
      1,
      false,
      true,
    ]);
    expect(summary(found)).toEqual([
      ["RQB-03/unnamed-property", "notice", "element", multipartAt, "undefined"],
    ]);
  });

  test("ENC-16: encoding nested two levels deep is refused at element scope, by name and by position (3.2.1)", async () => {
    const mixed = "multipart/mixed";
    const byName = await inProcess(
      withBody("3.2.1", multipart, {
        encoding: {
          a: { contentType: mixed, encoding: { x: { contentType: mixed, encoding: { y: {} } } } },
        },
        schema: objectOf({ a: objectOf({ x: objectOf({ y: string }) }) }),
      }),
    );
    const byPosition = await inProcess(
      withBody("3.2.1", multipart, {
        encoding: {
          a: { contentType: mixed, prefixEncoding: [{ contentType: mixed, prefixEncoding: [{}] }] },
        },
        schema: objectOf({ a: strings }),
      }),
    );

    expect(summary(byName)).toEqual([
      [
        "ENC-16/nesting-too-deep",
        "refusal",
        "element",
        multipartAt,
        `${multipartAt}/encoding/a/encoding/x`,
      ],
    ]);
    expect(summary(byPosition)).toEqual([
      [
        "ENC-16/nesting-too-deep",
        "refusal",
        "element",
        multipartAt,
        `${multipartAt}/encoding/a/prefixEncoding/0`,
      ],
    ]);
  });
});
