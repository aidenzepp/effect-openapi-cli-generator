import { afterEach, expect, test } from "bun:test";
import { startCaptureServer } from "./capture-server.ts";
import type { CaptureServer } from "./capture-server.ts";

const started: CaptureServer[] = [];

const start = () => {
  const server = startCaptureServer();
  started.push(server);

  return server;
};

afterEach(() => {
  for (const server of started.splice(0)) {
    server.stop();
  }
});

const waitFor = async (ready: () => boolean, attempts = 200): Promise<boolean> => {
  if (ready() || attempts === 0) {
    return ready();
  }

  await Bun.sleep(10);

  return await waitFor(ready, attempts - 1);
};

type Reader = Pick<ReadableStreamDefaultReader, "read">;

// Narrows a read result's untyped value to the bytes it carries.
const bytesOf = (result: { readonly value?: unknown } | undefined) =>
  result?.value instanceof Uint8Array ? result.value : new Uint8Array(0);

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// Reads until at least `count` bytes have arrived.
const readAtLeast = async (reader: Reader, count: number, received = ""): Promise<string> => {
  if (received.length >= count) {
    return received;
  }

  return await readAtLeast(reader, count, received + decode(bytesOf(await reader.read())));
};

test("a paced response delivers each chunk before the next one is sent", async () => {
  const server = start();
  server.script("/paced", {
    chunks: [
      { data: "data: 1\n\n", delayMs: 0 },
      { data: "data: 2\n\n", delayMs: 150 },
    ],
    headers: [["Content-Type", "text/event-stream"]],
    status: 200,
  });

  const response = await fetch(`${server.origins["127.0.0.1"]}/paced`);
  const reader = response.body?.getReader();
  const first = await reader?.read();
  const firstArrived = performance.now();
  const second = await reader?.read();
  const end = await reader?.read();

  expect(response.status).toBe(200);
  expect(decode(bytesOf(first))).toBe("data: 1\n\n");
  expect(decode(bytesOf(second))).toBe("data: 2\n\n");
  expect(end?.done).toBe(true);

  const sent = server.sent();
  expect(sent.map((chunk) => [chunk.connection, chunk.index])).toEqual([
    [1, 0],
    [1, 1],
  ]);
  expect(firstArrived).toBeLessThan(sent[1]?.at ?? 0);
});

test("a stalled body delivers exactly N bytes and then nothing until the client aborts", async () => {
  const server = start();
  const controller = new AbortController();
  server.script("/stall", { body: "0123456789", stallAfter: 4, status: 200 });

  const response = await fetch(`${server.origins["127.0.0.1"]}/stall`, {
    signal: controller.signal,
  });
  const reader = response.body?.getReader();
  const received = reader === undefined ? "" : await readAtLeast(reader, 4);
  const pending = reader?.read();
  const outcome = await Promise.race([
    pending?.then(() => "data"),
    Bun.sleep(200).then(() => "silent"),
  ]);

  expect(response.headers.get("content-length")).toBe("10");
  expect(received).toBe("0123");
  expect(outcome).toBe("silent");
  expect(server.events().map((event) => event.kind)).toEqual(["open"]);

  controller.abort();
  expect(
    await pending?.then(
      () => "data",
      () => "aborted",
    ),
  ).toBe("aborted");
  await waitFor(() => server.events().length === 2);

  expect(server.events().map((event) => event.kind)).toEqual(["open", "close"]);
});

test("a header delay of D ms makes the first byte arrive after D ms", async () => {
  const server = start();
  const delay = 150;
  const done = Promise.withResolvers<number>();
  server.script("/late", { body: "ok", headerDelayMs: delay, status: 200 });
  let written = 0;

  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: Number(new URL(server.origins["127.0.0.1"]).port),
    socket: {
      data: () => {
        done.resolve(performance.now() - written);
      },
    },
  });
  written = performance.now();
  socket.write("GET /late HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");

  const elapsed = await done.promise;
  socket.end();

  expect(elapsed).toBeGreaterThanOrEqual(delay);
});
