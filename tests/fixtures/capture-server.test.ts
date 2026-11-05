import { afterEach, expect, test } from "bun:test";
import { startCaptureServer } from "./capture-server.ts";
import type { CaptureServer, CaptureServerOptions } from "./capture-server.ts";

const started: CaptureServer[] = [];

const start = (options?: CaptureServerOptions) => {
  const server = startCaptureServer(options);
  started.push(server);

  return server;
};

afterEach(() => {
  for (const server of started.splice(0)) {
    server.stop();
  }
});

const encode = (text: string) => new TextEncoder().encode(text);

const port = (origin: string) => Number(new URL(origin).port);

// Sends raw bytes and resolves with everything the server wrote before it closed the socket.
const exchange = (origin: string, request: Uint8Array) => {
  const done = Promise.withResolvers<string>();
  const received: Uint8Array[] = [];

  void Bun.connect({
    hostname: "127.0.0.1",
    port: port(origin),
    socket: {
      close: () => {
        done.resolve(Buffer.concat(received).toString("latin1"));
      },
      data: (_socket, chunk) => {
        received.push(chunk);
      },
      open: (socket) => {
        socket.write(request);
      },
    },
  });

  return done.promise;
};

const waitFor = async (ready: () => boolean, attempts = 200): Promise<boolean> => {
  if (ready() || attempts === 0) {
    return ready();
  }

  await Bun.sleep(10);

  return await waitFor(ready, attempts - 1);
};

test("a request is recorded byte for byte", async () => {
  const server = start();
  const body = Uint8Array.of(0, 255, 13, 10, 128);
  const head = encode(
    "PURGE /a%2Fb/%7e?x=%7e&y&x=2 HTTP/1.1\r\nHost: 127.0.0.1\r\nX-B: 1\r\nauthorization: Token z\r\nX-A: 2\r\nX-B: 3\r\nContent-Length: 5\r\nConnection: close\r\n\r\n",
  );

  await exchange(server.origins["127.0.0.1"], Buffer.concat([head, body]));
  await waitFor(() => server.requests().length === 1);

  const [request] = server.requests();
  expect(request?.method).toBe("PURGE");
  expect(request?.target).toBe("/a%2Fb/%7e?x=%7e&y&x=2");
  expect(request?.origin).toBe("127.0.0.1");
  expect(request?.headers).toEqual([
    ["Host", "127.0.0.1"],
    ["X-B", "1"],
    ["authorization", "Token z"],
    ["X-A", "2"],
    ["X-B", "3"],
    ["Content-Length", "5"],
    ["Connection", "close"],
  ]);
  expect([...(request?.body ?? [])]).toEqual([...body]);
});

test("a chunked body is recorded as its decoded bytes", async () => {
  const server = start();
  const request =
    "POST /c HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n";

  await exchange(server.origins["127.0.0.1"], encode(request));
  await waitFor(() => server.requests().length === 1);

  expect(new TextDecoder().decode(server.requests()[0]?.body)).toBe("abcde");
});

test("both origins answer on separate ports", async () => {
  const server = start();
  const loopback = server.origins["127.0.0.1"];
  const named = server.origins.localhost;

  expect(new URL(loopback).hostname).toBe("127.0.0.1");
  expect(new URL(named).hostname).toBe("localhost");
  expect(port(loopback)).not.toBe(port(named));

  const first = await fetch(`${loopback}/one`);
  const second = await fetch(`${named}/two`);

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(server.requests().map((request) => [request.origin, request.target])).toEqual([
    ["127.0.0.1", "/one"],
    ["localhost", "/two"],
  ]);
});

test("the connection counter stays zero with no client", async () => {
  const server = start();

  await Bun.sleep(50);

  expect(server.connections()).toBe(0);
  expect(server.events()).toEqual([]);
  expect(server.requests()).toEqual([]);
});

test("a scripted redirect returns its Location", async () => {
  const server = start();
  const location = `${server.origins.localhost}/landing`;

  server.script("/moved", { location, status: 302 });

  const response = await fetch(`${server.origins["127.0.0.1"]}/moved`, { redirect: "manual" });

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(location);
});

test("scripted status, headers and body are returned", async () => {
  const server = start();

  server.script("/scripted", {
    body: "payload",
    headers: [["X-Scripted", "yes"]],
    status: 409,
  });

  const response = await fetch(`${server.origins["127.0.0.1"]}/scripted`);

  expect(response.status).toBe(409);
  expect(response.headers.get("x-scripted")).toBe("yes");
  expect(await response.text()).toBe("payload");
});

test("canary mode echoes Authorization in 401 and 500 bodies only", async () => {
  const server = start({ canary: true });
  const origin = server.origins["127.0.0.1"];
  const headers = { Authorization: "Bearer canary-secret" };

  server.script("/denied", { body: "denied", status: 401 });
  server.script("/broken", { body: "broken", status: 500 });
  server.script("/fine", { body: "fine", status: 200 });

  const denied = await fetch(`${origin}/denied`, { headers });
  const broken = await fetch(`${origin}/broken`, { headers });
  const fine = await fetch(`${origin}/fine`, { headers });

  expect(await denied.text()).toContain("canary-secret");
  expect(await broken.text()).toContain("canary-secret");
  expect(await fine.text()).toBe("fine");
});

test("connection open and close are recorded in order", async () => {
  const server = start();

  await exchange(
    server.origins["127.0.0.1"],
    encode("GET /e HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
  );
  await waitFor(() => server.events().length === 2);

  expect(server.connections()).toBe(1);
  expect(server.events().map((event) => event.kind)).toEqual(["open", "close"]);
});

test("a client abort of a never-ending body is observed as a close", async () => {
  const server = start();
  const controller = new AbortController();

  server.script("/endless", { endless: true, status: 200 });

  const response = await fetch(`${server.origins["127.0.0.1"]}/endless`, {
    signal: controller.signal,
  });
  const reader = response.body?.getReader();
  const first = await reader?.read();

  expect(first?.done).toBe(false);
  expect(server.events().map((event) => event.kind)).toEqual(["open"]);

  controller.abort();
  await waitFor(() => server.events().length === 2);

  expect(server.events().map((event) => event.kind)).toEqual(["open", "close"]);
});
