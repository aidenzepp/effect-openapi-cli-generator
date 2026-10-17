import { expect, test } from "bun:test";
import { Effect, Redacted, Schema } from "effect";
import { Cookies, HttpClientRequest } from "effect/http";
import * as Auth from "../examples/resend-reference/src/builtins/auth.js";
import * as Errors from "../examples/resend-reference/src/builtins/errors.js";
import * as Url from "../examples/resend-reference/src/builtins/url.js";

test("security definitions reject unsupported mechanisms and invalid configuration", async () => {
  await Promise.all(
    [
      { in: "body", name: "key", type: "apiKey" },
      { in: "header", type: "apiKey" },
      { scheme: "digest", type: "http" },
      { type: "oauth2" },
    ].map(async (definition) => {
      const error = await Effect.runPromise(
        Effect.flip(Schema.decodeUnknownEffect(Auth.SecurityScheme)(definition)),
      );
      expect(error._tag).toBe("SchemaError");
    }),
  );

  const scheme = await Effect.runPromise(
    Schema.decodeUnknownEffect(Auth.SecurityScheme)({ scheme: "bearer", type: "http" }),
  );
  expect(scheme).toEqual({ scheme: "bearer", type: "http" });
});

test("native bearer and checked basic authentication retain wire behavior and redaction", async () => {
  const token = Redacted.make("opaque token/+==");
  const bearer = HttpClientRequest.get("https://example.test").pipe(
    HttpClientRequest.bearerToken(token),
  );
  expect(bearer.headers.authorization).toBe("Bearer opaque token/+==");
  expect(JSON.stringify(token)).not.toContain("opaque token");

  const credentials = await Effect.runPromise(
    Schema.decodeUnknownEffect(Auth.BasicCredentials)({
      password: Redacted.make("secret"),
      username: Redacted.make("alice"),
    }),
  );
  const basic = await Effect.runPromise(
    Auth.basicAuth(credentials)(HttpClientRequest.get("https://example.test")),
  );
  expect(basic.headers.authorization).toBe("Basic YWxpY2U6c2VjcmV0");
  expect(JSON.stringify(credentials)).not.toContain("secret");

  const error = await Effect.runPromise(
    Effect.flip(
      Auth.basicAuth({
        password: Redacted.make("private-secret"),
        username: Redacted.make("\u{1F600}"),
      })(HttpClientRequest.get("https://example.test")),
    ),
  );
  expect(error).toBeInstanceOf(Errors.AuthenticationError);
  expect(error.reason).toBe("BasicEncoding");
  expect(JSON.stringify(error)).not.toContain("private-secret");
  expect(Errors.toCliError(error).userMessage).not.toContain("private-secret");
});

test("API keys honor explicit names and locations, including cookie preservation and encoding", async () => {
  const request = HttpClientRequest.get("https://example.test/prefix").pipe(
    HttpClientRequest.setHeader("cookie", "session=existing%20value; key=old"),
    HttpClientRequest.setUrlParam("keep", "yes"),
  );
  const credential = Redacted.make("value /;=+%");
  const header = await Effect.runPromise(
    Auth.apiKey({ in: "header", name: "X-Custom-Key", type: "apiKey" }, credential)(request),
  );
  expect(header.headers["x-custom-key"]).toBe("value /;=+%");

  const query = await Effect.runPromise(
    Auth.apiKey({ in: "query", name: "custom_key", type: "apiKey" }, credential)(request),
  );
  expect(query.urlParams).toContainEqual(["keep", "yes"]);
  expect(query.urlParams).toContainEqual(["custom_key", "value /;=+%"]);

  const cookie = await Effect.runPromise(
    Auth.apiKey({ in: "cookie", name: "key", type: "apiKey" }, credential)(request),
  );
  expect(Cookies.parseHeader(cookie.headers.cookie ?? "")).toEqual({
    key: "value /;=+%",
    session: "existing value",
  });
  expect(cookie.headers.cookie).toContain("key=value%20%2F%3B%3D%2B%25");
  await Promise.all(
    (
      [
        ["invalid;name", "private-secret"],
        ["key", "\uD800"],
      ] as const
    ).map(async ([name, value]) => {
      const error = await Effect.runPromise(
        Effect.flip(
          Auth.apiKey({ in: "cookie", name, type: "apiKey" }, Redacted.make(value))(request),
        ),
      );
      expect(error).toBeInstanceOf(Errors.AuthenticationError);
      expect(JSON.stringify(error)).not.toContain("private-secret");
    }),
  );
});

test("literal path failures remain tagged until the CLI boundary", async () => {
  await Promise.all(
    (
      [
        [".", "DotSegment"],
        ["..", "DotSegment"],
        ["\uD800", "InvalidUnicode"],
      ] as const
    ).map(async ([segment, reason]) => {
      const error = await Effect.runPromise(Effect.flip(Url.encodePathSegment(segment)));
      expect(error).toBeInstanceOf(Errors.PathError);
      expect(error.reason).toBe(reason);
      expect(Errors.toCliError(error).userMessage).toContain("no request was sent");
    }),
  );

  const request = await Effect.runPromise(
    Url.appendPathSegments(
      "files",
      "folder/report.json",
    )(HttpClientRequest.get("https://example.test/api/")),
  );
  expect(request.url).toBe("https://example.test/api/files/folder%2Freport.json");
});

test("Basic rejects ambiguous or controlled credentials but permits password colons", async () => {
  await Promise.all(
    [
      { password: "secret", username: "alice:admin" },
      { password: "secret\n", username: "alice" },
      { password: "secret", username: "alice\u007F" },
    ].map(async ({ password, username }) => {
      const error = await Effect.runPromise(
        Effect.flip(
          Auth.basicAuth({
            password: Redacted.make(password),
            username: Redacted.make(username),
          })(HttpClientRequest.get("https://example.test")),
        ),
      );
      expect(error).toBeInstanceOf(Errors.AuthenticationError);
      expect(JSON.stringify(error)).not.toContain("secret");
    }),
  );
  const request = await Effect.runPromise(
    Auth.basicAuth({
      password: Redacted.make("a:b"),
      username: Redacted.make("alice"),
    })(HttpClientRequest.get("https://example.test")),
  );
  expect(request.headers.authorization).toBe("Basic YWxpY2U6YTpi");
});
