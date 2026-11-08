import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Scope } from "effect";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { RecordedRequest } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { BinRun, GeneratedPackage } from "../support/generated-cli.ts";
import { setEnv } from "../support/env.ts";

// Design 6.6 through the built CLI and the capture server: `--content-type` chooses among every
// declared request media alternative, JSON is the default even when multipart is listed first, and
// the chosen key's encoder sends its bytes (form pairs by the Encoding rules, multipart with the
// writer's boundary, NDJSON as given). A flag that does not apply to the chosen key is exit 2
// before any connection. The package's own `tsc` build proves the builder infers
// `Serialize.Chosen<<Op>Bodies>` from the cli/ choice.

const repoRoot = nodePath.resolve(import.meta.dir, "../..");

const fixture = nodePath.join(repoRoot, "tests/fixtures/body-alternatives");

// Generated packages live under the worktree's git-ignored `work/`, never the system temp directory.
const scratch = nodePath.join(repoRoot, "work");

nodeFs.mkdirSync(scratch, { recursive: true });

const work = nodeFs.mkdtempSync(nodePath.join(scratch, "body-alternatives-program-"));

const restoreTmpdir = setEnv("TMPDIR", work);

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const scope = Effect.runSync(Scope.make());

const capture = startCaptureServer();

const origin = capture.origins["127.0.0.1"];

const encoder = new TextEncoder();

const fileBytes = encoder.encode("avatar bytes\u0000\u0001\n");

const filePath = nodePath.join(work, "avatar.bin");

let generated: GeneratedPackage | undefined;

beforeAll(async () => {
  nodeFs.writeFileSync(filePath, fileBytes);
  for (const path of ["/channels/c1/messages", "/files", "/events"]) {
    capture.script(path, { status: 204 });
  }

  generated = await Effect.runPromise(
    generateFixture({
      configPath: nodePath.join(fixture, "author-config.json"),
      specPath: nodePath.join(fixture, "openapi.json"),
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
    throw new Error("the body-alternatives package was not built");
  }

  return generated;
};

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

interface Exchange {
  readonly connections: number;
  readonly requests: readonly RecordedRequest[];
  readonly result: BinRun;
}

const exchange = async (args: readonly string[], stdin?: Uint8Array): Promise<Exchange> => {
  const before = capture.requests().length;
  const opened = capture.connections();
  const result = await Effect.runPromise(
    runBin(built(), {
      args: ["--base-url", origin, ...args],
      stdin: stdin ?? new Uint8Array(),
      timeoutMs: 30_000,
    }).pipe(Effect.provide(layer)),
  );

  return {
    connections: capture.connections() - opened,
    requests: capture.requests().slice(before),
    result,
  };
};

const header = (seen: RecordedRequest | undefined, name: string) =>
  seen?.headers.find(([candidate]) => candidate.toLowerCase() === name)?.[1];

const sent = (run: Exchange): RecordedRequest => {
  expect(run.result.exitCode, decode(run.result.stderr)).toBe(0);
  expect(run.requests).toHaveLength(1);

  const [seen] = run.requests;
  if (seen === undefined) {
    throw new Error("the capture server saw no request");
  }

  return seen;
};

describe("body alternatives: the built CLI", () => {
  test("with no --content-type the request is JSON", async () => {
    const seen = sent(await exchange(["messages", "create", "c1", "--content", "hi"]));

    expect(header(seen, "content-type")).toBe("application/json");
    expect(JSON.parse(decode(seen.body))).toEqual({ content: "hi" });
  }, 60_000);

  test("JSON is the default also when multipart is listed first", async () => {
    const seen = sent(await exchange(["files", "upload", "--purpose", "fine-tune"]));

    expect(header(seen, "content-type")).toBe("application/json");
    expect(JSON.parse(decode(seen.body))).toEqual({ purpose: "fine-tune" });
  }, 60_000);

  test("with form chosen the pairs follow the Encoding rules", async () => {
    const seen = sent(
      await exchange([
        "messages",
        "create",
        "c1",
        "--content-type",
        "application/x-www-form-urlencoded",
        "--content",
        "hi",
        "--tags",
        "a",
        "--tags",
        "b",
        "--ids",
        "1",
        "--ids",
        "2",
      ]),
    );
    const pairs = new URLSearchParams(decode(seen.body));

    expect(header(seen, "content-type")).toBe("application/x-www-form-urlencoded");
    expect([...pairs.keys()]).toEqual(["content", "tags", "ids", "ids"]);
    expect(pairs.get("content")).toBe("hi");
    expect(pairs.get("tags")).toBe("a,b");
    expect(pairs.getAll("ids")).toEqual(["1", "2"]);
  }, 60_000);

  test("with multipart chosen a file part is sent and Content-Type carries the boundary", async () => {
    const seen = sent(
      await exchange([
        "messages",
        "create",
        "c1",
        "--content-type",
        "multipart/form-data",
        "--content",
        "hi",
        "--file",
        filePath,
      ]),
    );
    const contentType = header(seen, "content-type") ?? "";
    const boundary = /^multipart\/form-data; boundary=(?<boundary>.+)$/u.exec(contentType)?.groups
      ?.boundary;
    const text = Buffer.from(seen.body).toString("latin1");

    expect(boundary).toBeDefined();
    expect(text).toContain(`--${boundary}`);
    expect(text).toContain('Content-Disposition: form-data; name="content"');
    expect(text).toContain('Content-Disposition: form-data; name="file"; filename="avatar.bin"');
    expect(text).toContain(Buffer.from(fileBytes).toString("latin1"));
  }, 60_000);

  test("NDJSON chosen beside JSON is sent unchanged and chunked from stdin", async () => {
    const ndjson = encoder.encode('{"name":"a"}\nnot json\n');
    const seen = sent(
      await exchange(
        ["events", "send", "--content-type", "application/x-ndjson", "--body-file", "-"],
        ndjson,
      ),
    );

    expect(header(seen, "content-type")).toBe("application/x-ndjson");
    expect(header(seen, "transfer-encoding")).toBe("chunked");
    expect([...seen.body]).toEqual([...ndjson]);
  }, 60_000);

  test("a part flag under the JSON default is exit 2 with no connection", async () => {
    const run = await exchange(["messages", "create", "c1", "--file", filePath]);

    expect(run.result.exitCode).toBe(2);
    expect(decode(run.result.stderr)).toContain(
      "--file: does not apply to --content-type application/json",
    );
    expect(run.connections).toBe(0);
    expect(run.requests).toEqual([]);
  }, 60_000);

  test("--body with multipart chosen is exit 2 with no connection", async () => {
    const run = await exchange([
      "messages",
      "create",
      "c1",
      "--content-type",
      "multipart/form-data",
      "--body",
      "{}",
    ]);

    expect(run.result.exitCode).toBe(2);
    expect(decode(run.result.stderr)).toContain(
      "--body: does not apply to --content-type multipart/form-data",
    );
    expect(run.connections).toBe(0);
    expect(run.requests).toEqual([]);
  }, 60_000);

  test("a media type the operation does not declare is the existing --content-type error", async () => {
    const run = await exchange([
      "messages",
      "create",
      "c1",
      "--content-type",
      "text/plain",
      "--content",
      "hi",
    ]);

    expect(run.result.exitCode).toBe(2);
    expect(decode(run.result.stderr)).toContain(
      "names a media type this operation does not declare",
    );
    expect(run.connections).toBe(0);
  }, 60_000);
});
