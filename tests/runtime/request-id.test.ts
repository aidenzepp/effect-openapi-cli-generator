import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import { HttpClientRequest, HttpClientResponse } from "effect/http";
import type { Credential } from "../../src/runtime-src/runtime/auth.ts";
import type { ResponseTable } from "../../src/runtime-src/runtime/response.ts";
import { classify } from "../../src/runtime-src/runtime/response.ts";

const table: ResponseTable = {
  operation: "users-get",
  requestIdHeader: "x-request-id",
  responses: { "200": ["application/json"], "404": [] },
};

const request = HttpClientRequest.get("https://api.example.com/users/1");

// A web `Headers` cannot hold control or bidi characters in a value, so a scripted list stands in
// for it: Effect reads a source's headers by iterating them.
class ScriptedHeaders extends Headers {
  constructor(pairs: readonly (readonly [string, string])[]) {
    super();
    Object.defineProperty(this, Symbol.iterator, { value: () => pairs.values() });
  }
}

const scripted = (status: number, headers: Record<string, string>) =>
  HttpClientResponse.fromWeb(
    request,
    Object.defineProperty(
      new Response(null, { status: status === 200 ? 200 : status }),
      "headers",
      {
        value: new ScriptedHeaders(Object.entries(headers)),
      },
    ),
  );

const fail = (
  response: HttpClientResponse.HttpClientResponse,
  credentials: readonly Credential[] = [],
  using = table,
) => Effect.runPromise(Effect.flip(classify(using, response, credentials)));

describe("request id from the declared header (design 7.1, DM2-5)", () => {
  test("a 404 carrying the designated header sets requestId", async () => {
    const error = await fail(scripted(404, { "X-Request-Id": "req-1" }));

    expect(error.requestId).toBe("req-1");
  });

  test("a value over 256 is cut to 256", async () => {
    const error = await fail(scripted(404, { "x-request-id": "r".repeat(400) }));

    expect(error.requestId).toBe("r".repeat(256));
  });

  test("a configured credential value is scrubbed", async () => {
    const secret = "SECRETTOKEN-abcdefghijklmnopqrstuvwxyz01";
    const credential: Credential = {
      definition: { kind: "http", scheme: "bearer" },
      scheme: "bearer",
      value: Redacted.make(secret),
    };
    const error = await fail(scripted(404, { "x-request-id": `id-${secret}` }), [credential]);

    expect(error.requestId).not.toContain("SECRETTOKEN");
    expect(error.requestId).toBe("id-<redacted:bearer>");
  });

  test("control and bidi characters are removed", async () => {
    const error = await fail(scripted(404, { "x-request-id": "a\u001B[31mb‮c\u0000d\u007Fe" }));

    expect(error.requestId).toBe("a[31mbcde");
  });

  test("no designation leaves requestId unset", async () => {
    const error = await fail(scripted(404, { "x-request-id": "req-1" }), [], {
      ...table,
      requestIdHeader: undefined,
    });

    expect(error).not.toHaveProperty("requestId");
  });

  test("a 200 with the header raises nothing", async () => {
    const response = scripted(200, { "x-request-id": "req-1" });
    const result = await Effect.runPromise(classify(table, response, []));

    expect(result).toBe(response);
  });

  test.each(["\u202E", "\u200B", "\u0001"])(
    "a credential split by U+%#: invisible character is still scrubbed",
    async (split) => {
      const credential: Credential = {
        definition: { kind: "http", scheme: "bearer" },
        scheme: "bearer",
        value: Redacted.make("secretvalue"),
      };
      const error = await fail(scripted(404, { "x-request-id": `id-secret${split}value` }), [
        credential,
      ]);

      expect(error.requestId).toBe("id-<redacted:bearer>");
    },
  );
});
