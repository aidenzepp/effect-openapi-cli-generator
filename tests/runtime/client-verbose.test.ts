/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import { Effect, Exit, Fiber, Sink, Stdio } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse, UrlParams } from "effect/http";
import { TestClock } from "effect/testing";
import * as Client from "../../src/runtime-src/runtime/client.ts";

const origin = "http://127.0.0.1:1";

const TOKEN = "t0ken-value";

const KEY = "s3cret-key";

// One scripted answer: a status, the response headers in the order the server sends them.
interface Answer {
  readonly headers?: readonly (readonly [string, string])[];
  readonly status: number;
}

// Call k gets `answers[k]`; a call past the script gets 200 with no headers.
const scripted = (answers: readonly Answer[]) => {
  let calls = 0;

  return HttpClient.make((request) =>
    Effect.sync(() => {
      const next = answers[calls] ?? { status: 200 };
      calls += 1;

      return HttpClientResponse.fromWeb(
        request,
        new Response(null, {
          headers: Object.fromEntries(next.headers ?? []),
          status: next.status,
        }),
      );
    }),
  );
};

const allowed: ReadonlySet<string> = new Set(["GET"]);

const sentinel: Client.DirectRoute = { cache: "no-store" };

const capture = (into: Buffer[]) => () =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      into.push(Buffer.from(chunk));
    }),
  );

// The RT-6 value scrubber `send` passes: each credential value of the chosen alternative.
const scrub = (text: string): string =>
  text.replaceAll(TOKEN, "<redacted:bearer>").replaceAll(KEY, "<redacted:key>");

interface Run {
  readonly retries?: boolean;
  readonly verbose?: boolean;
}

// One request through the verbose transform as the inner client of the redirect loop (m3-wire's
// order), optionally inside the retry transform, with the `key` query name on the redacted list
// as `Auth.redactedNames` puts an apiKey query name there (and `api_key` for the header cases).
const run = async (answers: readonly Answer[], options: Run = {}) => {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const looped = scripted(answers).pipe(
    Client.verboseTransform(scrub),
    Client.redirectLoop(Effect.succeed, sentinel, allowed, Client.noCertificate),
  );
  const client = options.retries === true ? looped.pipe(Client.retryTransform(scrub)) : looped;
  const request = HttpClientRequest.get(`${origin}/a?key=${KEY}&page=2`).pipe(
    HttpClientRequest.setHeader("x-first", "1"),
    HttpClientRequest.setHeader("authorization", `Bearer ${TOKEN}`),
    HttpClientRequest.setHeader("x-last", "z"),
  );
  const exchange = Effect.scoped(
    client.execute(request).pipe(Effect.map((response) => response.status)),
  ).pipe(
    Effect.provideService(Client.verboseSetting, options.verbose ?? true),
    Effect.provideService(UrlParams.CurrentRedactedNames, ["key", "api_key"]),
  );
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* drive() {
      const fiber = yield* Effect.forkChild(exchange);
      for (let step = 0; step < 100; step += 1) {
        yield* TestClock.adjust("1 second");
      }

      return yield* Fiber.join(fiber);
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provide(Stdio.layerTest({ stderr: capture(stderr), stdout: capture(stdout) })),
    ),
  );
  const lines = Buffer.concat(stderr)
    .toString("utf-8")
    .split("\n")
    .filter((line) => line !== "");

  return { exit, lines, stdout: Buffer.concat(stdout).toString("utf-8") };
};

const redirectThenOk: readonly Answer[] = [
  {
    headers: [
      ["location", "/b"],
      ["x-echo", TOKEN],
    ],
    status: 307,
  },
  { headers: [["x-echo", TOKEN]], status: 200 },
];

const requestBlock = (path: string) => [
  `> GET ${origin}${path} HTTP/1.1`,
  "> x-first: 1",
  "> authorization: <redacted>",
  "> x-last: z",
];

describe("--verbose", () => {
  test("each redirect hop writes its request and response block, credentials redacted", async () => {
    const { exit, lines } = await run(redirectThenOk);
    expect(exit).toEqual(Exit.succeed(200));
    expect(lines).toEqual([
      ...requestBlock("/a?key=<redacted>&page=2"),
      "< 307",
      "< location: /b",
      "< x-echo: <redacted:bearer>",
      ...requestBlock("/b"),
      "< 200",
      "< x-echo: <redacted:bearer>",
    ]);
  });

  test("no credential reaches stderr in clear and nothing is written to stdout", async () => {
    const { lines, stdout } = await run(redirectThenOk);
    const text = lines.join("\n");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(KEY);
    expect(stdout).toBe("");
  });

  test("a retry writes the second attempt's blocks", async () => {
    const { exit, lines } = await run([{ status: 503 }, { status: 200 }], { retries: true });
    expect(exit).toEqual(Exit.succeed(200));

    const blocks = lines.filter((line) => !line.startsWith("Notice: "));
    expect(blocks).toEqual([
      ...requestBlock("/a?key=<redacted>&page=2"),
      "< 503",
      ...requestBlock("/a?key=<redacted>&page=2"),
      "< 200",
    ]);
    expect(lines.filter((line) => line.startsWith("Notice: "))).toHaveLength(1);
  });

  test("without --verbose nothing is written", async () => {
    const { exit, lines, stdout } = await run(redirectThenOk, { verbose: false });
    expect(exit).toEqual(Exit.succeed(200));
    expect(lines).toEqual([]);
    expect(stdout).toBe("");
  });

  // A URL a response header carries is not a credential value the scrubber knows, so userinfo
  // and a query value on the redacted list are redacted by name, as in the request line.
  test("a Location with userinfo and a redacted query name prints neither", async () => {
    const location = "https://u:p@host/next?api_key=l0cation-secret&ok=1";
    const { lines } = await run([{ headers: [["location", location]], status: 307 }]);
    const shown = lines.find((line) => line.startsWith("< location: "));
    expect(shown).toBeDefined();
    expect(shown).not.toContain("u:p");
    expect(shown).not.toContain("l0cation-secret");
    expect(shown).toContain("&ok=1");
  });

  test("each URI in a Link header, relative or not, is redacted", async () => {
    const link = '</page?api_key=l1nk-secret&ok=1>; rel="next", <//u:p@host/x>; rel="alt"';
    const { lines } = await run([{ headers: [["link", link]], status: 200 }]);
    expect(lines).toContain(
      '< link: </page?api_key=<redacted>&ok=1>; rel="next", <//REDACTED:REDACTED@host/x>; rel="alt"',
    );
  });

  test("Content-Location and Refresh URLs are redacted", async () => {
    const { lines } = await run([
      {
        headers: [
          ["content-location", "/c?api_key=c0ntent-secret&ok=1"],
          ["refresh", "5; url='https://u:p@host/r?api_key=r3fresh-secret&ok=1'"],
        ],
        status: 200,
      },
    ]);
    expect(lines).toContain("< content-location: /c?api_key=<redacted>&ok=1");
    expect(lines).toContain(
      "< refresh: 5; url='https://REDACTED:REDACTED@host/r?api_key=<redacted>&ok=1'",
    );
  });
});
