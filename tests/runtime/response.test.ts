import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Runtime } from "effect";
import { HttpClientError, HttpClientRequest, HttpClientResponse, UrlParams } from "effect/http";
import { ApiResponseError, TransportError } from "../../src/runtime-src/domain/errors.ts";
import type { ResponseTable } from "../../src/runtime-src/runtime/response.ts";
import {
  classify,
  mapClientError,
  matchResponse,
  toApiResponseError,
} from "../../src/runtime-src/runtime/response.ts";

const table: ResponseTable = {
  operation: "users-update",
  requestIdHeader: "x-request-id",
  responses: { "200": ["application/json"], "404": [], "4XX": ["application/json"], default: [] },
};

const request = HttpClientRequest.get("https://api.example.com/users/1");

const respond = (status: number, headers: Record<string, string> = {}) =>
  HttpClientResponse.fromWeb(request, new Response(null, { headers, status }));

const redacting = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.provideService(effect, UrlParams.CurrentRedactedNames, ["access_token", "api_key"]);

const apiError = (response: HttpClientResponse.HttpClientResponse, using = table) =>
  Effect.runPromise(Effect.flip(redacting(classify(using, response))));

const transport = (cause?: unknown) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      cause,
      request: HttpClientRequest.get("https://api.example.com/users?api_key=SECRET&page=2"),
    }),
  });

const systemError = (code: string, message = "failed") =>
  Object.assign(new Error(message), { code });

const transportError = (cause?: unknown) =>
  Effect.runPromise(Effect.flip(redacting(mapClientError(transport(cause)))));

describe("matchResponse precedence", () => {
  test("an explicit code beats its range and default", () => {
    expect(matchResponse(table.responses, 404)).toBe("404");
    expect(matchResponse(table.responses, 200)).toBe("200");
  });

  test("a range beats default", () => {
    expect(matchResponse(table.responses, 418)).toBe("4XX");
  });

  test("default covers codes no key matches", () => {
    expect(matchResponse(table.responses, 500)).toBe("default");
  });

  test("no key and no default is undeclared", () => {
    expect(matchResponse({ "200": [] }, 500)).toBe("undeclared");
  });
});

describe("classify", () => {
  test("2xx is success whichever key matched", async () => {
    const onlyDefault: ResponseTable = { operation: "op", responses: { default: [] } };
    const response = respond(204);

    expect(await Effect.runPromise(classify(onlyDefault, response))).toBe(response);
    expect(await Effect.runPromise(classify(table, respond(200)))).toBeDefined();
  });

  test("a non-2xx status fails with the matched key and exit 1", async () => {
    const error = await apiError(
      respond(404, { "content-type": "application/json; charset=utf-8" }),
    );

    expect(error).toBeInstanceOf(ApiResponseError);
    expect(error).toMatchObject({
      matched: "404",
      mediaType: "application/json",
      operation: "users-update",
      status: 404,
    });
    expect(Runtime.getErrorExitCode(error)).toBe(1);
  });

  test("a status that only default covers is matched default", async () => {
    const error = await apiError(respond(500));

    expect(error).toMatchObject({ matched: "default", status: 500 });
    expect(Runtime.getErrorExitCode(error)).toBe(1);
  });

  test("an undeclared status is reported, not a decode failure", async () => {
    const bare: ResponseTable = { operation: "op", responses: { "200": [] } };

    expect(await apiError(respond(500), bare)).toMatchObject({
      matched: "undeclared",
      status: 500,
    });
  });

  test.each([401, 403])("%i exits 3", async (status) => {
    const error = await apiError(respond(status));

    expect(error).toBeInstanceOf(ApiResponseError);
    expect(Runtime.getErrorExitCode(error)).toBe(3);
  });

  test("the request id comes from the declared header and is bounded", async () => {
    const found = await apiError(respond(404, { "X-Request-Id": "req-1" }));
    const long = await apiError(respond(404, { "x-request-id": "r".repeat(300) }));
    const absent = await apiError(respond(404));
    const undeclared = await apiError(respond(404, { "x-request-id": "req-1" }), {
      ...table,
      requestIdHeader: undefined,
    });

    expect(found.requestId).toBe("req-1");
    expect(long.requestId).toHaveLength(256);
    expect(absent).not.toHaveProperty("requestId");
    expect(undeclared).not.toHaveProperty("requestId");
  });

  test("an unfollowed 3xx carries the Location with query credentials redacted, exit 1", async () => {
    const error = await apiError(
      respond(302, { location: "https://login.example.com/next?access_token=SECRET&state=ok" }),
    );

    expect(error).toBeInstanceOf(ApiResponseError);
    expect(error.status).toBe(302);
    expect(error.bodyExcerpt).toContain("access_token=REDACTED");
    expect(error.bodyExcerpt).toContain("state=ok");
    expect(error.bodyExcerpt).not.toContain("SECRET");
    expect(Runtime.getErrorExitCode(error)).toBe(1);
  });

  test("a 3xx without a Location is still an exit 1 error", async () => {
    const error = await apiError(respond(304));

    expect(error.status).toBe(304);
    expect(error.bodyExcerpt).toBe("");
    expect(Runtime.getErrorExitCode(error)).toBe(1);
  });

  test("every declared key is reported as matched, not only four literals", () => {
    const declared: ResponseTable = {
      operation: "users-get",
      responses: { "401": [], "500": [], "5XX": [] },
    };

    expect(toApiResponseError(declared, respond(500)).matched).toBe("500");
    expect(toApiResponseError(declared, respond(503)).matched).toBe("5XX");
    expect(toApiResponseError(declared, respond(401)).matched).toBe("401");
  });

  test("toApiResponseError keeps the excerpt it is given", () => {
    expect(toApiResponseError(table, respond(404), "not found").bodyExcerpt).toBe("not found");
  });
});

interface Linked {
  cause?: unknown;
  name: string;
}

describe("mapClientError", () => {
  const abort = new DOMException("The operation was aborted.", "AbortError");

  const cases = [
    ["timeout", new Cause.TimeoutError("Operation request")],
    ["aborted", abort],
    ["aborted", new TypeError("fetch failed", { cause: abort })],
    ["dns", new TypeError("fetch failed", { cause: systemError("ENOTFOUND") })],
    ["dns", systemError("EAI_AGAIN")],
    ["tls", new TypeError("fetch failed", { cause: systemError("SELF_SIGNED_CERT_IN_CHAIN") })],
    ["tls", systemError("UNABLE_TO_VERIFY_LEAF_SIGNATURE")],
    ["tls", systemError("ERR_TLS_CERT_ALTNAME_INVALID")],
    ["connect", new TypeError("fetch failed", { cause: systemError("ECONNREFUSED") })],
    ["connect", undefined],
  ] as const;

  test.each(cases)("a transport failure is reason %s", async (reason, cause) => {
    const error = await transportError(cause);

    expect(error).toBeInstanceOf(TransportError);
    expect(error.reason).toBe(reason);
    expect(Runtime.getErrorExitCode(error)).toBe(4);
  });

  test("the URL is redacted by the redacted-name lists", async () => {
    const error = await transportError();

    expect(error.url).toContain("api_key=REDACTED");
    expect(error.url).toContain("page=2");
    expect(error.url).not.toContain("SECRET");
  });

  test("an InvalidUrlError is a defect, never a TransportError", async () => {
    const invalid = new HttpClientError.HttpClientError({
      reason: new HttpClientError.InvalidUrlError({ request }),
    });
    const exit = await Effect.runPromiseExit(mapClientError(invalid));

    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false);
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
  });

  test("a self-referential cause terminates with a reason", async () => {
    const loop: Linked = { name: "Loop" };
    loop.cause = loop;
    const error = await transportError(loop);

    expect(error).toBeInstanceOf(TransportError);
    expect(error.reason).toBe("connect");
  });

  test("a two-link cyclic cause terminates with a reason", async () => {
    const a: Linked = { name: "A" };
    const b: Linked = { cause: a, name: "B" };
    a.cause = b;
    const error = await transportError(a);

    expect(error).toBeInstanceOf(TransportError);
    expect(error.reason).toBe("connect");
  });
});
