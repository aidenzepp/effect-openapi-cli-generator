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

const authorization = "Bearer canary-secret";

interface Answer {
  readonly retryAfter: string | null;
  readonly status: number;
}

// Sends `times` requests one after another, so the server sees them in order.
const sendInOrder = async (url: string, times: number, init?: RequestInit): Promise<Answer[]> => {
  if (times === 0) {
    return [];
  }

  const response = await fetch(url, init);
  await response.arrayBuffer();
  const answer = { retryAfter: response.headers.get("retry-after"), status: response.status };

  return [answer, ...(await sendInOrder(url, times - 1, init))];
};

test("a scripted sequence answers in order and the counter reads every request", async () => {
  const server = start();
  const url = `${server.origins["127.0.0.1"]}/flaky`;
  const body = "attempt-body";

  server.sequence("/flaky", [
    { body: "busy", headers: [["Retry-After", "1"]], status: 503 },
    { body: "busy", headers: [["Retry-After", "1"]], status: 503 },
    { body: "done", status: 200 },
  ]);

  const answers = await sendInOrder(url, 3, { body, method: "POST" });

  expect(answers).toEqual([
    { retryAfter: "1", status: 503 },
    { retryAfter: "1", status: 503 },
    { retryAfter: null, status: 200 },
  ]);
  expect(server.count("/flaky")).toBe(3);
  expect(server.count("/other")).toBe(0);

  // Replayed attempts carry the same body bytes.
  const bodies = server.requests().map((request) => Buffer.from(request.body).toString("latin1"));
  expect(bodies).toEqual([body, body, body]);
});

test("a finished sequence keeps answering with its last response", async () => {
  const server = start();
  const url = `${server.origins["127.0.0.1"]}/settled`;

  server.sequence("/settled", [{ status: 503 }, { body: "done", status: 200 }]);

  const answers = await sendInOrder(url, 4);

  expect(answers.map((answer) => answer.status)).toEqual([503, 200, 200, 200]);
  expect(server.count("/settled")).toBe(4);
});

test("canary mode echoes Authorization and the request body in a 503 body", async () => {
  const server = start({ canary: true });
  const body = "canary-body-bytes";

  server.script("/unavailable", { body: "busy", status: 503 });

  const response = await fetch(`${server.origins["127.0.0.1"]}/unavailable`, {
    body,
    headers: { Authorization: authorization },
    method: "POST",
  });
  const text = await response.text();

  expect(response.status).toBe(503);
  expect(text).toContain(authorization);
  expect(text).toContain(body);
});

test("canary mode echoes the request body in 401 and 500 bodies", async () => {
  const server = start({ canary: true });
  const origin = server.origins["127.0.0.1"];
  const body = "canary-body-bytes";
  const init = { body, headers: { Authorization: authorization }, method: "POST" };

  server.script("/denied", { body: "denied", status: 401 });
  server.script("/broken", { body: "broken", status: 500 });

  const deniedResponse = await fetch(`${origin}/denied`, init);
  const denied = await deniedResponse.text();
  const brokenResponse = await fetch(`${origin}/broken`, init);
  const broken = await brokenResponse.text();

  expect(denied).toContain(authorization);
  expect(denied).toContain(body);
  expect(broken).toContain(authorization);
  expect(broken).toContain(body);
});

test("canary mode echoes Authorization in a 307 Location", async () => {
  const server = start({ canary: true });
  const location = `${server.origins.localhost}/landing`;

  server.script("/moved", { location, status: 307 });

  const response = await fetch(`${server.origins["127.0.0.1"]}/moved`, {
    headers: { Authorization: authorization },
    redirect: "manual",
  });

  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toStartWith(location);
  expect(response.headers.get("location")).toContain(authorization);
});

test("without canary mode a 307 Location is returned unchanged", async () => {
  const server = start();
  const location = `${server.origins.localhost}/landing`;

  server.script("/moved", { location, status: 307 });

  const response = await fetch(`${server.origins["127.0.0.1"]}/moved`, {
    headers: { Authorization: authorization },
    redirect: "manual",
  });

  expect(response.headers.get("location")).toBe(location);
});
