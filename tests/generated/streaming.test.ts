import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { PacedChunk, ScriptedResponse } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage, runBin } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// Milestone 3 streaming witness on the 3.2 line (design 4.6, 9 I5, 7.1 ResponseStreamError): one
// generated package from `sequential.json`, run against the capture server's paced streams. Each
// sequential item reaches stdout as one JSON line before the server sends the next chunk; `--raw`
// writes the bytes received; a record over `--max-record-bytes`, a body cut inside a record and a
// stalled body exit 5 with the stream error's reason; a reader that closes early ends it cleanly.

const specPath = nodePath.resolve(import.meta.dir, "../fixtures/specs/sequential.json");

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = mkdtempSync(nodePath.join(tmpdir(), "ws1a-streaming-"));

const configPath = nodePath.join(work, "author-config.json");

writeFileSync(
  configPath,
  `${JSON.stringify({
    binName: "seq",
    envPrefix: "SEQ",
    package: { name: "sequential-cli", version: "0.1.0" },
  })}\n`,
);

const capture = startCaptureServer();

const base = capture.origins["127.0.0.1"];

const scope = Effect.runSync(Scope.make());

const ready = Promise.withResolvers<GeneratedPackage>();

beforeAll(async () => {
  const prepare = generateFixture({ configPath, specPath }).pipe(
    Effect.tap(preparePackage),
    Scope.provide(scope),
    Effect.provide(layer),
  );
  ready.resolve(await Effect.runPromise(prepare));
}, 600_000);

afterAll(async () => {
  capture.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(work, { force: true, recursive: true });
});

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const PackageBin = Schema.fromJsonString(
  Schema.Struct({ bin: Schema.Record(Schema.String, Schema.String) }),
);

// The bin entry's absolute path, read from the generated package.json as runBin reads it.
const binPath = async (generated: GeneratedPackage) => {
  const manifest = await Bun.file(nodePath.join(generated.dir, "package.json")).text();
  const [entry = ""] = Object.values(Schema.decodeUnknownSync(PackageBin)(manifest).bin);

  return nodePath.join(generated.dir, ...entry.split("/"));
};

// The global flags first, then the `feed` group's operation.
const command = (operation: string) => [
  "--base-url",
  base,
  "--error-format",
  "json",
  "feed",
  operation,
];

interface Exchange {
  readonly exitCode: number | null;
  readonly reason: string | undefined;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

// The stream error's reason is the ResponseStreamError.reason literal its message names (design
// 7.1); `kind` names the class. A retry hint may follow the reason, so it is matched, not split.
const ErrorLine = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ kind: Schema.String, message: Schema.String }) }),
);

const streamReason = /: (?<reason>idleTimeout|invalidFraming|recordTooLarge|truncated)\b/u;

const reasonOf = (stderr: string): string | undefined => {
  const line = stderr.trim().split("\n").at(-1) ?? "";
  const parsed = Schema.decodeUnknownOption(ErrorLine)(line);

  return parsed._tag === "Some" && parsed.value.error.kind === "ResponseStreamError"
    ? streamReason.exec(parsed.value.error.message)?.groups?.reason
    : undefined;
};

const exchange = async (
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<Exchange> => {
  const generated = await ready.promise;
  const run = await Effect.runPromise(
    runBin(generated, { args, env, timeoutMs: 30_000 }).pipe(Effect.provide(layer)),
  );
  const stderr = decode(run.stderr);

  return {
    exitCode: run.exitCode,
    reason: reasonOf(stderr),
    stderr,
    stdout: decode(run.stdout),
    timedOut: run.timedOut,
  };
};

interface TimedLine {
  readonly at: number;
  readonly text: string;
}

interface Watched {
  readonly exitCode: number | null;
  readonly lines: readonly TimedLine[];
}

interface Reader {
  readonly read: () => Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
}

// Reads stdout to its end, stamping each complete line with the time it arrived.
const readLines = async (
  reader: Reader,
  lines: TimedLine[] = [],
  pending = "",
): Promise<readonly TimedLine[]> => {
  const { done, value } = await reader.read();
  if (done || value === undefined) {
    return pending === "" ? lines : [...lines, { at: performance.now(), text: pending }];
  }

  const at = performance.now();
  const parts = (pending + decode(value)).split("\n");
  const rest = parts.pop() ?? "";

  return await readLines(reader, [...lines, ...parts.map((text) => ({ at, text }))], rest);
};

// Runs the bin and watches stdout as it is written, on the same clock the capture server stamps
// each sent chunk with.
const watch = async (args: readonly string[]): Promise<Watched> => {
  const child = Bun.spawn([process.execPath, await binPath(await ready.promise), ...args], {
    env: {},
    stderr: "ignore",
    stdin: "ignore",
    stdout: "pipe",
  });
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 30_000);
  const [lines, exitCode] = await Promise.all([
    readLines(child.stdout.getReader()),
    child.exited,
  ]).finally(() => {
    clearTimeout(timer);
  });

  return { exitCode, lines };
};

const paced = (contentType: string, data: readonly string[], delayMs = 400): ScriptedResponse => ({
  chunks: data.map((item, index): PacedChunk => ({
    data: item,
    delayMs: index === 0 ? 0 : delayMs,
  })),
  headers: [["Content-Type", contentType]],
  status: 200,
});

// The send times of the chunks answering the latest request for `path`.
const sentFor = (path: string) => {
  let connection: number | null = null;
  for (const request of capture.requests()) {
    if (request.target === path) {
      ({ connection } = request);
    }
  }

  return capture
    .sent()
    .filter((chunk) => chunk.connection === connection)
    .map((chunk) => chunk.at);
};

// Every line but the last arrived before the chunk after the one that carried it was sent.
const arrivedBeforeNext = (lines: readonly TimedLine[], sent: readonly number[]) =>
  lines.slice(0, -1).every((line, index) => line.at < (sent[index + 1] ?? 0));

describe("sequential output through a generated CLI", () => {
  test("MED-03 (response): an itemSchema text/event-stream response prints each event as one JSON line before the next chunk is sent", async () => {
    capture.script(
      "/events",
      paced("text/event-stream", [
        'event: tick\nid: 1\ndata: {"n":1}\n\n',
        'event: tick\nid: 2\ndata: {"n":2}\n\n',
        'event: tick\nid: 3\ndata: {"n":3}\n\n',
      ]),
    );

    const watched = await watch(command("events"));

    expect(watched.exitCode).toBe(0);
    expect(watched.lines.map((line) => line.text)).toEqual([
      '{"data":"{\\"n\\":1}","event":"tick","id":"1"}',
      '{"data":"{\\"n\\":2}","event":"tick","id":"2"}',
      '{"data":"{\\"n\\":3}","event":"tick","id":"3"}',
    ]);
    expect(arrivedBeforeNext(watched.lines, sentFor("/events"))).toBe(true);
  }, 60_000);

  test("MED-16: x-ndjson and jsonl items print one JSON line each, in arrival order, before the next chunk is sent", async () => {
    const cases = [
      { contentType: "application/x-ndjson", operation: "lines", path: "/lines" },
      { contentType: "application/jsonl", operation: "jsonl", path: "/jsonl" },
    ];

    const observed = [];
    for (const { contentType, operation, path } of cases) {
      capture.script(
        path,
        paced(
          contentType,
          [1, 2, 3].map((n) => `{"n":${n}}\n`),
        ),
      );

      // Serial by design: one bin at a time, each against its own scripted path.
      // oxlint-disable-next-line no-await-in-loop
      const watched = await watch(command(operation));
      observed.push({
        before: arrivedBeforeNext(watched.lines, sentFor(path)),
        exitCode: watched.exitCode,
        lines: watched.lines.map((line) => line.text),
        operation,
      });
    }

    expect(observed).toEqual(
      cases.map(({ operation }) => ({
        before: true,
        exitCode: 0,
        lines: ['{"n":1}', '{"n":2}', '{"n":3}'],
        operation,
      })),
    );
  }, 120_000);

  test("MED-16: json-seq records print one JSON line each, in arrival order", async () => {
    capture.script(
      "/records",
      paced(
        "application/json-seq",
        [1, 2, 3].map((n) => `\u001E{"n":${n}}\n`),
      ),
    );

    const watched = await watch(command("records"));

    expect(watched.exitCode).toBe(0);
    expect(watched.lines.map((line) => line.text)).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
  }, 60_000);

  test("MED-16: each json-seq record reaches stdout at its closing LF, before the next chunk is sent", async () => {
    capture.script(
      "/records",
      paced(
        "application/json-seq",
        [1, 2, 3].map((n) => `\u001E{"n":${n}}\n`),
      ),
    );

    const watched = await watch(command("records"));

    expect(arrivedBeforeNext(watched.lines, sentFor("/records"))).toBe(true);
  }, 60_000);

  test("MED-17: NDJSON lines print compacted, never re-serialized: 2^53+1 keeps its digits", async () => {
    capture.script(
      "/lines",
      paced("application/x-ndjson", [
        '{ "n" : 9007199254740993 , "s" : "a b" }\n',
        '{"big": [ 1.50, -0e0 ] }\n',
      ]),
    );

    const observed = await exchange(command("lines"));

    expect(observed.exitCode).toBe(0);
    expect(observed.stdout).toBe('{"n":9007199254740993,"s":"a b"}\n{"big":[1.50,-0e0]}\n');
  }, 60_000);

  test("MED-18: SSE comments and unknown fields are ignored, multi-line data is joined, retry is an integer and data stays a string", async () => {
    capture.script(
      "/events",
      paced("text/event-stream", [
        ': a comment\nevent: tick\nid: 7\nretry: 1500\nunknown: field\ndata: {"n":1}\ndata: second\n\n',
        "event: tock\nid: 8\ndata: 9007199254740993\n\n",
      ]),
    );

    const observed = await exchange(command("events"));

    expect(observed.exitCode).toBe(0);
    expect(observed.stdout).toBe(
      [
        '{"data":"{\\"n\\":1}\\nsecond","event":"tick","id":"7","retry":1500}',
        '{"data":"9007199254740993","event":"tock","id":"8"}',
        "",
      ].join("\n"),
    );
  }, 60_000);

  test("MED-19: a json-seq response with both schema and itemSchema is split into one JSON line per record", async () => {
    capture.script(
      "/records",
      paced("application/json-seq", [
        '\u001E{"n":1}\n\u001E{"n":2}\n',
        '\u001E{"n":9007199254740993}\n',
      ]),
    );

    const observed = await exchange(command("records"));

    expect(observed.exitCode).toBe(0);
    expect(observed.stdout).toBe('{"n":1}\n{"n":2}\n{"n":9007199254740993}\n');
  }, 60_000);
});

describe("raw output, bounds and the idle timeout through a generated CLI", () => {
  test("MED-16: --raw writes a sequential response as the bytes received", async () => {
    const chunks = [": a comment\nevent: tick\ndata: 1\n\n", "data: two\ndata:  lines\n\n"];
    capture.script("/events", paced("text/event-stream", chunks, 50));

    const observed = await exchange(["--raw", ...command("events")]);

    expect(observed.exitCode).toBe(0);
    expect(observed.stdout).toBe(chunks.join(""));
  }, 60_000);

  test("MED-16: a record over --max-record-bytes exits 5 with recordTooLarge after the records before it", async () => {
    capture.script(
      "/lines",
      paced("application/x-ndjson", ['{"n":1}\n', `{"s":"${"x".repeat(64)}"}\n`], 50),
    );

    const observed = await exchange(["--max-record-bytes", "16", ...command("lines")]);

    expect(observed.exitCode).toBe(5);
    expect(observed.reason).toBe("recordTooLarge");
    expect(observed.stdout).toBe('{"n":1}\n');
  }, 60_000);

  test("MED-16: a stream cut inside a record exits 5 with truncated after the records before it", async () => {
    capture.script("/lines", paced("application/x-ndjson", ['{"n":1}\n', '{"n":'], 50));

    const observed = await exchange(command("lines"));

    expect(observed.exitCode).toBe(5);
    expect(observed.reason).toBe("truncated");
    expect(observed.stdout).toBe('{"n":1}\n');
  }, 60_000);

  test("MED-16: a stalled raw body exits 5 with idleTimeout at SEQ_IDLE_TIMEOUT", async () => {
    capture.script("/document", {
      body: '{"a":1,"b":2}',
      headers: [["Content-Type", "application/json"]],
      stallAfter: 5,
      status: 200,
    });

    const started = performance.now();
    const observed = await exchange(command("document"), { SEQ_IDLE_TIMEOUT: "1" });
    const elapsed = performance.now() - started;

    expect(observed.timedOut).toBe(false);
    expect(observed.exitCode).toBe(5);
    expect(observed.reason).toBe("idleTimeout");
    expect(observed.stdout).toBe('{"a":');
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(20_000);
  }, 60_000);

  test("MED-16: a stalled sequential body exits 5 with idleTimeout at SEQ_IDLE_TIMEOUT after the items before it", async () => {
    capture.script("/lines", {
      body: '{"n":1}\n{"n":2}\n',
      headers: [["Content-Type", "application/x-ndjson"]],
      stallAfter: 8,
      status: 200,
    });

    const started = performance.now();
    const observed = await exchange(command("lines"), { SEQ_IDLE_TIMEOUT: "1" });
    const elapsed = performance.now() - started;

    expect(observed.timedOut).toBe(false);
    expect(observed.exitCode).toBe(5);
    expect(observed.reason).toBe("idleTimeout");
    expect(observed.stdout).toBe('{"n":1}\n');
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(20_000);
  }, 60_000);

  test("MED-16: piping a sequential response to head -1 exits 0", async () => {
    capture.script(
      "/lines",
      paced("application/x-ndjson", ['{"n":1}\n', '{"n":2}\n', '{"n":3}\n'], 200),
    );

    const bin = await binPath(await ready.promise);
    const child = Bun.spawn(
      [
        "bash",
        "-o",
        "pipefail",
        "-c",
        '"$@" | head -1',
        "bash",
        process.execPath,
        bin,
        ...command("lines"),
      ],
      { env: { PATH: process.env.PATH ?? "" }, stderr: "pipe", stdin: "ignore", stdout: "pipe" },
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 30_000);
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]).finally(() => {
      clearTimeout(timer);
    });

    expect(exitCode).toBe(0);
    expect(stdout).toBe('{"n":1}\n');
  }, 60_000);
});
