import { afterEach, expect, test } from "bun:test";
import { connect } from "node:net";
import { startCaptureServer } from "./capture-server.ts";
import { startRecordingProxy } from "./recording-proxy.ts";
import type { ProxyTarget } from "./recording-proxy.ts";

// TEST-NET-1 (RFC 5737): not loopback, so a generated CLI routes it through the proxy (design §6.5).
const testNet = "192.0.2.10";

const timeout = 30_000;

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const waitFor = async (ready: () => boolean, attempts = 200): Promise<boolean> => {
  if (ready() || attempts === 0) {
    return ready();
  }

  await Bun.sleep(10);

  return await waitFor(ready, attempts - 1);
};

const start = async (label: string, targets: Readonly<Record<string, ProxyTarget>>) => {
  const proxy = await startRecordingProxy({ label, targets });
  cleanups.push(() => {
    proxy.stop();
  });

  return proxy;
};

// A plain TCP listener that records what it receives and answers each chunk with "pong".
const startListener = () => {
  const received: Uint8Array[] = [];
  let opens = 0;
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data: (socket, chunk) => {
        received.push(chunk);
        socket.write("pong");
      },
      open: () => {
        opens += 1;
      },
    },
  });
  cleanups.push(() => {
    listener.stop(true);
  });

  return {
    opens: () => opens,
    port: listener.port,
    received: () => Buffer.concat(received).toString("latin1"),
  };
};

const rawClient = (url: string) => {
  const received: Buffer[] = [];
  let closed = false;
  const socket = connect(Number(new URL(url).port), "127.0.0.1");
  socket.on("data", (chunk: Buffer) => {
    received.push(chunk);
  });
  socket.on("close", () => {
    closed = true;
  });
  socket.on("error", () => {
    socket.destroy();
  });
  cleanups.push(() => {
    socket.destroy();
  });

  return {
    closed: () => closed,
    received: () => Buffer.concat(received).toString("latin1"),
    write: (text: string) => socket.write(text),
  };
};

test("a CONNECT to a mapped TEST-NET-1 authority is recorded and tunnelled both ways", async () => {
  const listener = startListener();
  const authority = `${testNet}:${listener.port}`;
  const proxy = await start("P1", { [authority]: { hostname: "127.0.0.1", port: listener.port } });
  const client = rawClient(proxy.url);

  client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nX-Probe: one\r\n\r\n`);
  await waitFor(() => proxy.records().length === 1 && client.received().includes("\r\n\r\n"));

  expect(proxy.records()).toEqual([
    {
      headerLines: [`Host: ${authority}`, "X-Probe: one"],
      kind: "connect",
      proxy: "P1",
      requestLine: `CONNECT ${authority} HTTP/1.1`,
      target: authority,
    },
  ]);
  expect(client.received()).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");

  client.write("ping");
  await waitFor(() => listener.received() === "ping" && client.received().endsWith("pong"));

  expect(listener.opens()).toBe(1);
  expect(listener.received()).toBe("ping");
  expect(client.received()).toBe("HTTP/1.1 200 Connection Established\r\n\r\npong");
});

test("a CONNECT to an unmapped target gets 502 and dials nothing", async () => {
  const listener = startListener();
  const mapped = `${testNet}:${listener.port}`;
  const unmapped = `192.0.2.11:${listener.port}`;
  const proxy = await start("P1", { [mapped]: { hostname: "127.0.0.1", port: listener.port } });
  const client = rawClient(proxy.url);

  client.write(`CONNECT ${unmapped} HTTP/1.1\r\nHost: ${unmapped}\r\n\r\n`);
  await waitFor(() => proxy.records().length === 1 && client.closed());

  expect(proxy.records()).toEqual([
    {
      headerLines: [`Host: ${unmapped}`],
      kind: "connect",
      proxy: "P1",
      requestLine: `CONNECT ${unmapped} HTTP/1.1`,
      target: unmapped,
    },
  ]);
  expect(client.received()).toStartWith("HTTP/1.1 502 ");
  expect(client.closed()).toBe(true);

  await Bun.sleep(50);

  expect(listener.opens()).toBe(0);
});

const child = `
  const response = await fetch(process.argv[1]);
  console.log(response.status + " " + (await response.text()));
`;

test(
  "a Bun child with HTTP_PROXY sends one forward request that reaches the origin in origin form",
  async () => {
    const capture = startCaptureServer();
    cleanups.push(() => {
      capture.stop();
    });

    const originPort = Number(new URL(capture.origins["127.0.0.1"]).port);
    const authority = `${testNet}:${originPort}`;
    const targets = { [authority]: { hostname: "127.0.0.1", port: originPort } };
    const p1 = await start("P1", targets);
    const p2 = await start("P2", targets);
    const proxyUrl = p1.urlWithUserinfo("px@user", "px:pass");

    expect(proxyUrl).toBe(`http://px%40user:px%3Apass@${new URL(p1.url).host}`);

    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && !/proxy/iu.test(name)) {
        env[name] = value;
      }
    }

    const run = Bun.spawn([process.execPath, "-e", child, `http://${authority}/`], {
      env: { ...env, HTTP_PROXY: proxyUrl },
      stderr: "inherit",
      stdout: "pipe",
    });
    cleanups.push(() => {
      run.kill();
    });

    const output = await new Response(run.stdout).text();
    const exitCode = await run.exited;
    const records = p1.records();

    expect(
      records.map(({ kind, proxy, requestLine, target }) => [proxy, kind, requestLine, target]),
    ).toEqual([["P1", "forward", `GET http://${authority}/ HTTP/1.1`, authority]]);
    expect(exitCode).toBe(0);
    expect(output.trim()).toBe("200 ok");

    const proxyAuthorization = (records[0]?.headerLines ?? [])
      .filter((line) => /^proxy-authorization:/iu.test(line))
      .map((line) => line.slice(line.indexOf(":") + 1).trim());
    expect(proxyAuthorization).toEqual([
      `Basic ${Buffer.from("px@user:px:pass").toString("base64")}`,
    ]);
    expect(p2.records()).toEqual([]);

    const requests = capture.requests();
    expect(requests).toHaveLength(1);

    const headers = (name: string) =>
      (requests[0]?.headers ?? [])
        .filter(([candidate]) => candidate.toLowerCase() === name)
        .map(([, value]) => value);
    expect(requests[0]?.target).toBe("/");
    expect(headers("host")).toEqual([authority]);
    expect(headers("proxy-authorization")).toEqual([]);
    expect(headers("proxy-connection")).toEqual([]);
    expect(headers("connection")).toEqual(["close"]);

    p1.reset();

    expect(p1.records()).toEqual([]);
  },
  timeout,
);
