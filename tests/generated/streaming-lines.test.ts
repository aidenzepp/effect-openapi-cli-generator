import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { startCaptureServer } from "../fixtures/capture-server.ts";
import type { PacedChunk, ScriptedResponse } from "../fixtures/capture-server.ts";
import { generateFixture, preparePackage } from "../support/generated-cli.ts";
import type { GeneratedPackage } from "../support/generated-cli.ts";

// Milestone 3 streaming witness on the 3.1.2 and 3.0.4 lines (design 4.6, D-OC7): those lines have
// no `itemSchema`, so `text/event-stream` and `application/x-ndjson` are sequential by media type.
// One generated package per line, built serially, each run against the capture server's paced
// streams: every item reaches stdout as one JSON line before the server sends the next chunk.

const lines = [
  { line: "3.1.2", spec: "sequential-3.1.json" },
  { line: "3.0.4", spec: "sequential-3.0.json" },
] as const;

const layer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const work = mkdtempSync(nodePath.join(tmpdir(), "ws1b-streaming-lines-"));

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

const ready = Promise.withResolvers<ReadonlyMap<string, GeneratedPackage>>();

beforeAll(async () => {
  const prepare = Effect.forEach(
    lines,
    ({ line, spec }) =>
      generateFixture({
        configPath,
        specPath: nodePath.resolve(import.meta.dir, "../fixtures/specs", spec),
      }).pipe(
        Effect.tap(preparePackage),
        Effect.map((generated) => [line, generated] as const),
      ),
    { concurrency: 1 },
  ).pipe(Scope.provide(scope), Effect.provide(layer));
  ready.resolve(new Map(await Effect.runPromise(prepare)));
}, 1_200_000);

afterAll(async () => {
  capture.stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(work, { force: true, recursive: true });
});

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const PackageBin = Schema.fromJsonString(
  Schema.Struct({ bin: Schema.Record(Schema.String, Schema.String) }),
);

// The bin entry's absolute path for one line's package, read from its generated package.json.
const binPath = async (line: string) => {
  const packages = await ready.promise;
  const generated = packages.get(line);
  if (generated === undefined) {
    throw new Error(`no generated package for the ${line} line`);
  }

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

interface TimedLine {
  readonly at: number;
  readonly text: string;
}

interface Reader {
  readonly read: () => Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
}

// Reads stdout to its end, stamping each complete line with the time it arrived.
const readLines = async (
  reader: Reader,
  read: TimedLine[] = [],
  pending = "",
): Promise<readonly TimedLine[]> => {
  const { done, value } = await reader.read();
  if (done || value === undefined) {
    return pending === "" ? read : [...read, { at: performance.now(), text: pending }];
  }

  const at = performance.now();
  const parts = (pending + decode(value)).split("\n");
  const rest = parts.pop() ?? "";

  return await readLines(reader, [...read, ...parts.map((text) => ({ at, text }))], rest);
};

// Runs one line's bin and watches stdout as it is written, on the same clock the capture server
// stamps each sent chunk with.
const watch = async (line: string, args: readonly string[]) => {
  const child = Bun.spawn([process.execPath, await binPath(line), ...args], {
    env: {},
    stderr: "ignore",
    stdin: "ignore",
    stdout: "pipe",
  });
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 30_000);
  const [watched, exitCode] = await Promise.all([
    readLines(child.stdout.getReader()),
    child.exited,
  ]).finally(() => {
    clearTimeout(timer);
  });

  return { exitCode, lines: watched };
};

const paced = (contentType: string, data: readonly string[]): ScriptedResponse => ({
  chunks: data.map((item, index): PacedChunk => ({ data: item, delayMs: index === 0 ? 0 : 400 })),
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
const arrivedBeforeNext = (watched: readonly TimedLine[], sent: readonly number[]) =>
  watched.slice(0, -1).every((item, index) => item.at < (sent[index + 1] ?? 0));

// One operation per sequential media type, each declared with a plain `schema`. The NDJSON lines
// carry whitespace, so a framed line (compacted) differs from the raw bytes.
const cases = [
  {
    chunks: [1, 2, 3].map((n) => `event: tick\nid: ${n}\ndata: {"n":${n}}\n\n`),
    contentType: "text/event-stream",
    expected: [1, 2, 3].map((n) => `{"data":"{\\"n\\":${n}}","event":"tick","id":"${n}"}`),
    operation: "events",
    path: "/events",
  },
  {
    chunks: [1, 2, 3].map((n) => `{ "n" : ${n} }\n`),
    contentType: "application/x-ndjson",
    expected: ['{"n":1}', '{"n":2}', '{"n":3}'],
    operation: "lines",
    path: "/lines",
  },
];

describe("sequential output on the 3.1.2 and 3.0.4 lines through a generated CLI", () => {
  for (const { line } of lines) {
    test(`MED-20: on the ${line} line, text/event-stream and application/x-ndjson responses with a plain schema print one JSON line per item before the next chunk is sent`, async () => {
      const observed = [];
      for (const { chunks, contentType, operation, path } of cases) {
        capture.script(path, paced(contentType, chunks));

        // Serial by design: one bin at a time, each against its own scripted path.
        // oxlint-disable-next-line no-await-in-loop
        const watched = await watch(line, command(operation));
        observed.push({
          before: arrivedBeforeNext(watched.lines, sentFor(path)),
          exitCode: watched.exitCode,
          lines: watched.lines.map((item) => item.text),
          operation,
        });
      }

      expect(observed).toEqual(
        cases.map(({ expected, operation }) => ({
          before: true,
          exitCode: 0,
          lines: expected,
          operation,
        })),
      );
    }, 120_000);
  }
});
