import { describe, expect, test } from "bun:test";
import { Effect, Option, Redacted, Stream } from "effect";
import { Headers, HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";
import * as Client from "../../src/runtime-src/runtime/client.ts";

// Two bound origins (A over http, C over https) and one unbound origin (B).
const A = "http://127.0.0.1:1";

const B = "http://localhost:2";

const C = "https://127.0.0.1:3";

const originNamed = (name: string): string => {
  if (name === "B") {
    return B;
  }

  return name === "C" ? C : A;
};

const BODY = "request-body-bytes";

const bytes = (text: string) => new TextEncoder().encode(text);

const decode = (data: Uint8Array) => new TextDecoder().decode(data);

interface Seen {
  readonly body: string;
  readonly hash: Option.Option<string>;
  readonly headers: Headers.Headers;
  readonly method: string;
  readonly origin: string;
  readonly path: string;
  readonly signal: AbortSignal;
  readonly url: string;
}

interface Answer {
  readonly body?: ReadableStream<Uint8Array> | string;
  readonly location?: string;
  readonly status: number;
}

// The fixture server, routed by path:
//   /r/<status>/<A|B|C>   <status> with Location <origin>/final
//   /chain/<n>            302 to /chain/<n+1> on the same origin
//   /loc?to=<location>    302 with the raw Location given
//   /status/<status>?to=  <status> with an optional raw Location
//   /endless/<status>     <status> to A/final with a body that never ends
//   anything else         200 "final"
const route = (url: URL, endless: () => ReadableStream<Uint8Array>): Answer => {
  const parts = url.pathname.split("/").filter((part) => part !== "");
  const [head, first, second] = parts;
  const to = url.searchParams.get("to");
  if (head === "r" && first !== undefined && second !== undefined) {
    return { location: `${originNamed(second)}/final`, status: Number(first) };
  }

  if (head === "chain" && first !== undefined) {
    return { location: `/chain/${Number(first) + 1}`, status: 302 };
  }

  if (head === "loc" && to !== null) {
    return { location: to, status: 302 };
  }

  if (head === "status" && first !== undefined) {
    return to === null ? { status: Number(first) } : { location: to, status: Number(first) };
  }

  if (head === "endless" && first !== undefined) {
    return { body: endless(), location: `${A}/final`, status: Number(first) };
  }

  return { body: "final", status: 200 };
};

// The bytes a hop sends. A stream body is run here, as the transport would run it.
const bodyText = (body: HttpBody.HttpBody): Effect.Effect<string> => {
  if (body._tag === "Stream") {
    return body.stream.pipe(
      Stream.runCollect,
      Effect.map((chunks) => chunks.map(decode).join("")),
      Effect.orDie,
    );
  }

  if (body._tag === "Uint8Array") {
    return Effect.succeed(decode(body.body));
  }

  return Effect.succeed(body._tag === "Empty" ? "" : `<${body._tag}>`);
};

// A recording client over the fixture server. `pulls` counts chunks the endless body produced.
const fixture = () => {
  const seen: Seen[] = [];
  let pulls = 0;
  const endless = () =>
    new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulls += 1;
        controller.enqueue(new Uint8Array(65_536));
      },
    });
  const client = HttpClient.make((request, url, signal) =>
    Effect.gen(function* answer() {
      const body = yield* bodyText(request.body);
      const target = new URL(url.href);
      target.hash = "";
      seen.push({
        body,
        hash: request.hash,
        headers: request.headers,
        method: request.method,
        origin: target.origin,
        path: `${target.pathname}${target.search}`,
        signal,
        url: target.href,
      });

      const reply = route(target, endless);
      const init =
        reply.location === undefined
          ? { status: reply.status }
          : { headers: { location: reply.location }, status: reply.status };

      return HttpClientResponse.fromWeb(request, new Response(reply.body ?? null, init));
    }),
  );

  return { client, pulls: () => pulls, seen };
};

type Kind = "bearer" | "cookieKey" | "headerKey" | "queryKey";

const kinds: readonly Kind[] = ["bearer", "cookieKey", "headerKey", "queryKey"];

const definitions: Record<Kind, Auth.SecurityScheme> = {
  bearer: { kind: "http", scheme: "bearer" },
  cookieKey: { in: "cookie", kind: "apiKey", name: "session" },
  headerKey: { in: "header", kind: "apiKey", name: "X-Api-Key" },
  queryKey: { in: "query", kind: "apiKey", name: "api_key" },
};

const SECRET: Record<Kind, string> = {
  bearer: "S2-BEARER-SECRET",
  cookieKey: "S2-COOKIE-SECRET",
  headerKey: "S2-HEADER-SECRET",
  queryKey: "S2-QUERY-SECRET",
};

const table: Auth.SecurityTable = { schemes: definitions };

const attachFor = (kind: Kind): Client.Attach =>
  Auth.attach(table, {
    credentials: [
      { definition: definitions[kind], scheme: kind, value: Redacted.make(SECRET[kind]) },
    ],
    origins: [A, C],
  });

const noAttach: Client.Attach = Effect.succeed;

const carries = (hop: Seen, secret: string): boolean =>
  hop.url.includes(secret) || Object.values(hop.headers).some((value) => value.includes(secret));

type Outcome = string;

const run = async (
  request: HttpClientRequest.HttpClientRequest,
  attach: Client.Attach = noAttach,
) => {
  const { client, pulls, seen } = fixture();
  const program = client
    .pipe(Client.redirectLoop(attach))
    .execute(request)
    .pipe(
      Effect.map((response): Outcome => `Response:${response.status}`),
      Effect.catchTag("RedirectRefused", (refused) =>
        Effect.succeed(`RedirectRefused:${refused.reason}`),
      ),
    );
  const outcome = await Effect.runPromise(program);

  return { outcome, pulls: pulls(), seen };
};

const refusal = (request: HttpClientRequest.HttpClientRequest) => {
  const { client } = fixture();

  return Effect.runPromise(
    client.pipe(Client.redirectLoop(noAttach)).execute(request).pipe(Effect.flip),
  );
};

const withBody = (method: "POST" | "PUT", url: string, body: HttpBody.HttpBody) =>
  HttpClientRequest.make(method)(url).pipe(HttpClientRequest.setBody(body));

const memoryBody = () => HttpBody.uint8Array(bytes(BODY), "text/plain");

// A stdin body: a chunked stream with no length that a second run finds drained.
const stdinBody = () => {
  let drained = false;

  return HttpBody.stream(
    Stream.suspend(() => {
      const chunk = drained ? new Uint8Array() : bytes(BODY);
      drained = true;

      return Stream.make(chunk);
    }),
  );
};

// A file body: `HttpBody.file` is a stream that re-opens the file and carries its length.
const fileBody = () =>
  HttpBody.stream(
    Stream.suspend(() => Stream.make(bytes(BODY))),
    "application/octet-stream",
    BODY.length,
  );

// The spike S2 matrix, expected bytes per hop written from the D-OQ6 (c) policy.
type Pair = "cross" | "down" | "same";

const pairStart: Record<Pair, string> = { cross: A, down: C, same: A };

const pairTarget: Record<Pair, "A" | "B"> = { cross: "B", down: "A", same: "A" };

interface ExpectedHop {
  readonly body: string;
  readonly credentials: boolean;
  readonly method: string;
  readonly origin: string;
}

interface Expected {
  readonly hops: readonly ExpectedHop[];
  readonly outcome: Outcome;
}

const expected = (status: number, pair: Pair, method: "GET" | "POST"): Expected => {
  const first: ExpectedHop = {
    body: method === "POST" ? BODY : "",
    credentials: true,
    method,
    origin: pairStart[pair],
  };
  if (pair === "down") {
    return { hops: [first], outcome: "RedirectRefused:downgrade" };
  }

  const toGet =
    ((status === 301 || status === 302) && method === "POST") ||
    (status === 303 && method !== "GET");
  const second = toGet ? "GET" : method;
  const body = second === "POST" ? BODY : "";
  if (pair === "cross" && body !== "") {
    return { hops: [first], outcome: "RedirectRefused:crossOriginBody" };
  }

  return {
    hops: [
      first,
      { body, credentials: pair === "same", method: second, origin: originNamed(pairTarget[pair]) },
    ],
    outcome: "Response:200",
  };
};

describe("the spike S2 matrix under the redirect loop", () => {
  const statuses = [301, 302, 303, 307, 308];
  const pairs: readonly Pair[] = ["same", "cross", "down"];
  const methods = ["GET", "POST"] as const;
  for (const status of statuses) {
    for (const pair of pairs) {
      for (const method of methods) {
        for (const kind of kinds) {
          test(`${status} ${pair} ${method} ${kind}`, async () => {
            const url = `${pairStart[pair]}/r/${status}/${pairTarget[pair]}`;
            const request =
              method === "POST" ? withBody("POST", url, memoryBody()) : HttpClientRequest.get(url);
            const { outcome, seen } = await run(request, attachFor(kind));
            const want = expected(status, pair, method);
            expect(outcome).toBe(want.outcome);
            expect(
              seen.map((hop) => ({
                body: hop.body,
                credentials: carries(hop, SECRET[kind]),
                method: hop.method,
                origin: hop.origin,
              })),
            ).toEqual([...want.hops]);
          });
        }
      }
    }
  }
});

describe("attach runs on every hop", () => {
  test("a same-origin chain re-attaches the query apiKey on each hop", async () => {
    const { outcome, seen } = await run(
      HttpClientRequest.get(`${A}/loc`).pipe(
        HttpClientRequest.setUrlParam("to", "/loc?to=%2Ffinal"),
      ),
      attachFor("queryKey"),
    );
    expect(outcome).toBe("Response:200");
    expect(seen.map((hop) => carries(hop, SECRET.queryKey))).toEqual([true, true, true]);
  });

  test("the step is called once per hop, on the hop's own request", async () => {
    const calls: string[] = [];
    const counting: Client.Attach = (request) =>
      Effect.sync(() => {
        calls.push(request.url);

        return HttpClientRequest.setHeader(request, "x-hop", String(calls.length));
      });
    const { seen } = await run(
      HttpClientRequest.get(`${A}/chain/0`).pipe(HttpClientRequest.setUrl(`${A}/r/302/B`)),
      counting,
    );
    expect(calls).toEqual([`${A}/r/302/B`, `${B}/final`]);
    expect(seen.map((hop) => Headers.get(hop.headers, "x-hop"))).toEqual([
      Option.some("1"),
      Option.some("2"),
    ]);
  });

  test("a hop never inherits the previous hop's attach output", async () => {
    // Audit D F3: a cookie name that the strip cannot parse back. The next hop is built from the
    // request before attach, so the attached cookie never reaches it.
    const hostile: Auth.SecurityScheme = { in: "cookie", kind: "apiKey", name: "a; admin=1" };
    const attach = Auth.attach(
      { schemes: { hostile } },
      {
        credentials: [{ definition: hostile, scheme: "hostile", value: Redacted.make("COOKIE-X") }],
        origins: [A],
      },
    );
    const { outcome, seen } = await run(HttpClientRequest.get(`${A}/r/302/B`), attach);
    expect(outcome).toBe("Response:200");
    expect(seen.map((hop) => carries(hop, "COOKIE-X"))).toEqual([true, false]);
    expect(seen.map((hop) => Option.isSome(Headers.get(hop.headers, "cookie")))).toEqual([
      true,
      false,
    ]);
  });
});

describe("refusals happen before the next hop is sent", () => {
  test("hopLimit: ten redirects are followed, the eleventh is refused", async () => {
    const { outcome, seen } = await run(HttpClientRequest.get(`${A}/chain/0`));
    expect(outcome).toBe("RedirectRefused:hopLimit");
    expect(seen.length).toBe(Client.maxRedirects + 1);
  });

  test("scheme: a file: Location", async () => {
    const { outcome, seen } = await run(
      HttpClientRequest.get(`${A}/loc`).pipe(
        HttpClientRequest.setUrlParam("to", "file:///etc/passwd"),
      ),
    );
    expect(outcome).toBe("RedirectRefused:scheme");
    expect(seen.length).toBe(1);
  });

  test("userinfo: reported by origin only", async () => {
    const error = await refusal(
      HttpClientRequest.get(`${A}/loc`).pipe(
        HttpClientRequest.setUrlParam("to", "http://evil-user:evil-pass@localhost:2/final"),
      ),
    );
    expect(error).toMatchObject({ _tag: "RedirectRefused", from: A, reason: "userinfo", to: B });
  });

  test("downgrade: https to http", async () => {
    const error = await refusal(HttpClientRequest.get(`${C}/r/302/A`));
    expect(error).toMatchObject({ _tag: "RedirectRefused", from: C, reason: "downgrade", to: A });
  });

  test("crossOriginBody wins over unreplayableBody on a cross-origin 307 of stdin", async () => {
    const { outcome, seen } = await run(withBody("POST", `${A}/r/307/B`, stdinBody()));
    expect(outcome).toBe("RedirectRefused:crossOriginBody");
    expect(seen.length).toBe(1);
  });
});

describe("SP1: one-shot bodies are never re-sent", () => {
  test("a stdin-body 307 is refused with unreplayableBody", async () => {
    const { outcome, seen } = await run(withBody("POST", `${A}/r/307/A`, stdinBody()));
    expect(outcome).toBe("RedirectRefused:unreplayableBody");
    expect(seen.map((hop) => hop.body)).toEqual([BODY]);
  });

  test("a stdin-body 308 is refused with unreplayableBody", async () => {
    const { outcome } = await run(withBody("PUT", `${A}/r/308/A`, stdinBody()));
    expect(outcome).toBe("RedirectRefused:unreplayableBody");
  });

  test("a stdin-body PUT 302 keeps its body, so it is refused too", async () => {
    const { outcome } = await run(withBody("PUT", `${A}/r/302/A`, stdinBody()));
    expect(outcome).toBe("RedirectRefused:unreplayableBody");
  });

  test("a stdin-body POST 303 becomes a body-less GET and is followed", async () => {
    const { outcome, seen } = await run(withBody("POST", `${A}/r/303/A`, stdinBody()));
    expect(outcome).toBe("Response:200");
    expect(seen.map((hop) => [hop.method, hop.body])).toEqual([
      ["POST", BODY],
      ["GET", ""],
    ]);
    expect(seen.map((hop) => Option.isSome(Headers.get(hop.headers, "content-type")))).toEqual([
      true,
      false,
    ]);
  });

  test("a file body re-runs on a 307", async () => {
    const { outcome, seen } = await run(withBody("POST", `${A}/r/307/A`, fileBody()));
    expect(outcome).toBe("Response:200");
    expect(seen.map((hop) => hop.body)).toEqual([BODY, BODY]);
  });

  test("an in-memory body re-runs on a 308", async () => {
    const { outcome, seen } = await run(withBody("PUT", `${A}/r/308/A`, memoryBody()));
    expect(outcome).toBe("Response:200");
    expect(seen.map((hop) => [hop.method, hop.body])).toEqual([
      ["PUT", BODY],
      ["PUT", BODY],
    ]);
  });
});

describe("SP2: the discarded 3xx response is aborted, not drained", () => {
  test("a 3xx body that never ends neither hangs nor is read", async () => {
    const { outcome, pulls, seen } = await run(HttpClientRequest.get(`${A}/endless/302`));
    expect(outcome).toBe("Response:200");
    expect(seen.map((hop) => hop.signal.aborted)).toEqual([true, false]);
    expect(pulls).toBeLessThan(4);
  }, 10_000);

  test("a refused hop aborts its 3xx too", async () => {
    const { outcome, seen } = await run(HttpClientRequest.get(`${C}/endless/302`));
    expect(outcome).toBe("RedirectRefused:downgrade");
    expect(seen.map((hop) => hop.signal.aborted)).toEqual([true]);
  }, 10_000);

  test("the final response stays readable", async () => {
    const { client } = fixture();
    const text = await Effect.runPromise(
      client
        .pipe(Client.redirectLoop(noAttach))
        .execute(HttpClientRequest.get(`${A}/endless/307`))
        .pipe(
          // Read only a 200: a 3xx here carries the endless body.
          Effect.flatMap((response) =>
            response.status === 200 ? response.text : Effect.succeed(`status ${response.status}`),
          ),
        ),
    );
    expect(text).toBe("final");
  }, 10_000);
});

const follow = (location: string) =>
  run(HttpClientRequest.get(`${A}/loc`).pipe(HttpClientRequest.setUrlParam("to", location)));

describe("SP3: Location forms", () => {
  test("absolute-form goes to the named origin", async () => {
    const { seen } = await follow(`${B}/final?x=1`);
    expect(seen[1]).toMatchObject({ origin: B, path: "/final?x=1" });
  });

  test("a //host Location keeps the current scheme", async () => {
    const { seen } = await follow("//localhost:2/final");
    expect(seen[1]).toMatchObject({ origin: B, path: "/final" });
  });

  test("a fragment moves to the request hash and is not part of the URL", async () => {
    const { seen } = await follow("/final?x=1#frag");
    expect(seen[1]).toMatchObject({ hash: Option.some("frag"), origin: A, path: "/final?x=1" });
  });

  test("a query-only Location resolves against the sent URL", async () => {
    const { seen } = await follow("?page=2");
    expect(seen[1]).toMatchObject({ origin: A, path: "/loc?page=2" });
  });

  test("an unparseable Location returns the 3xx as the final response", async () => {
    const { outcome, seen } = await follow("http://[::1");
    expect(outcome).toBe("Response:302");
    expect(seen.length).toBe(1);
  });
});

describe("responses the loop does not follow", () => {
  test("a 300 with a Location is returned", async () => {
    const { outcome, seen } = await run(
      HttpClientRequest.get(`${A}/status/300`).pipe(HttpClientRequest.setUrlParam("to", "/final")),
    );
    expect(outcome).toBe("Response:300");
    expect(seen.length).toBe(1);
  });

  test("a 302 without a Location is returned", async () => {
    const { outcome, seen } = await run(HttpClientRequest.get(`${A}/status/302`));
    expect(outcome).toBe("Response:302");
    expect(seen.length).toBe(1);
  });
});
