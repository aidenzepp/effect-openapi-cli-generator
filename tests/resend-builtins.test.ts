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

  await Promise.all(
    (
      [
        ["bearer", "bearer"],
        ["Bearer", "bearer"],
        ["bEaReR", "bearer"],
        ["Basic", "basic"],
        ["BASIC", "basic"],
      ] as const
    ).map(async ([input, canonical]) => {
      const scheme = await Effect.runPromise(
        Schema.decodeUnknownEffect(Auth.SecurityScheme)({ scheme: input, type: "http" }),
      );
      expect(scheme).toEqual({ scheme: canonical, type: "http" });
    }),
  );
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
  expect(error.message).toBe(error.reason.message);
  expect(Errors.toCliError(error).userMessage).toBe(error.message);
  expect(error.reason._tag).toBe("BasicEncodingError");

  const encoded = await Effect.runPromise(Schema.encodeEffect(Errors.AuthenticationError)(error));
  const decoded = await Effect.runPromise(
    Schema.decodeUnknownEffect(Errors.AuthenticationError)(encoded),
  );
  expect(decoded).toBeInstanceOf(Errors.AuthenticationError);
  expect(decoded.reason).toBeInstanceOf(Errors.BasicEncodingError);
  expect(decoded.reason.message).toBe(error.reason.message);
  expect(decoded.message).toBe(decoded.reason.message);
  expect(Errors.toCliError(decoded).userMessage).toBe(decoded.message);

  expect(Errors.toCliError(error).userMessage).toContain("Basic authentication encoding");
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
        ["invalid;name", "private-secret", "InvalidConfiguration"],
        ["key", "\uD800", "Encoding"],
      ] as const
    ).map(async ([name, value, reason]) => {
      const error = await Effect.runPromise(
        Effect.flip(
          Auth.apiKey({ in: "cookie", name, type: "apiKey" }, Redacted.make(value))(request),
        ),
      );
      expect(error).toBeInstanceOf(Errors.AuthenticationError);
      expect(error.message).toBe(error.reason.message);
      expect(Errors.toCliError(error).userMessage).toBe(error.message);
      expect(error.reason._tag).toBe(
        reason === "Encoding" ? "CookieEncodingError" : "CookieConfigurationError",
      );
      expect(Errors.toCliError(error).userMessage).toContain("cookie authentication");
      expect(Errors.toCliError(error).userMessage).toContain(
        reason === "Encoding" ? "valid Unicode" : "configured name",
      );
      expect(JSON.stringify(error)).not.toContain("private-secret");
      expect(JSON.stringify(error)).not.toContain("invalid;name");
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
    (
      [
        { password: "secret", reason: "UsernameInvalid", username: "alice:admin" },
        { password: "secret\n", reason: "PasswordInvalid", username: "alice" },
        { password: "secret", reason: "UsernameInvalid", username: "alice\u007F" },
      ] as const
    ).map(async ({ password, reason, username }) => {
      const error = await Effect.runPromise(
        Effect.flip(
          Auth.basicAuth({
            password: Redacted.make(password),
            username: Redacted.make(username),
          })(HttpClientRequest.get("https://example.test")),
        ),
      );
      expect(error).toBeInstanceOf(Errors.AuthenticationError);
      expect(error.message).toBe(error.reason.message);
      expect(Errors.toCliError(error).userMessage).toBe(error.message);
      expect(error.reason._tag).toBe("InvalidBasicCredential");
      expect(error.reason).toMatchObject({
        field: reason === "UsernameInvalid" ? "username" : "password",
      });
      expect(Errors.toCliError(error).userMessage).toContain(
        reason === "UsernameInvalid" ? "username is invalid" : "password is invalid",
      );
      expect(JSON.stringify(error)).not.toContain("secret");
      expect(Errors.toCliError(error).userMessage).not.toContain("secret");
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

test("erased API keys preserve location and report credential access rather than encoding", async () => {
  const messages = await Promise.all(
    (["header", "query", "cookie"] as const).map(async (location) => {
      const credential = Redacted.make("private-erased-key");
      Redacted.wipeUnsafe(credential);

      const error = await Effect.runPromise(
        Effect.flip(
          Auth.apiKey(
            { in: location, name: "private-key-name", type: "apiKey" },
            credential,
          )(HttpClientRequest.get("https://example.test")),
        ),
      );
      expect(error).toBeInstanceOf(Errors.AuthenticationError);
      expect(error.message).toBe(error.reason.message);
      expect(Errors.toCliError(error).userMessage).toBe(error.message);
      expect(error.reason._tag).toBe("CredentialUnavailable");
      expect(error.reason).toMatchObject({ credential: { location, mechanism: "apiKey" } });
      expect(JSON.stringify(error)).not.toContain("private-erased-key");

      const message = Errors.toCliError(error).userMessage;
      expect(message).toContain(`${location} authentication`);
      expect(message).toContain("Supply the credential again");
      expect(message).not.toContain("private-key-name");
      expect(message).not.toContain("private-erased-key");

      return message;
    }),
  );
  expect(new Set(messages).size).toBe(3);
});

test("erased Basic credentials identify the missing field without storing secrets", async () => {
  await Promise.all(
    (["username", "password"] as const).map(async (field) => {
      const credentials = {
        password: Redacted.make("private-password"),
        username: Redacted.make("private-username"),
      };
      Redacted.wipeUnsafe(credentials[field]);

      const error = await Effect.runPromise(
        Effect.flip(Auth.basicAuth(credentials)(HttpClientRequest.get("https://example.test"))),
      );
      expect(error).toBeInstanceOf(Errors.AuthenticationError);
      expect(error.message).toBe(error.reason.message);
      expect(Errors.toCliError(error).userMessage).toBe(error.message);
      expect(error.reason._tag).toBe("CredentialUnavailable");
      expect(error.reason).toMatchObject({ credential: { field, mechanism: "basic" } });
      expect(Errors.toCliError(error).userMessage).toContain(`${field} is unavailable`);
      expect(JSON.stringify(error)).not.toContain("private-");
    }),
  );
});
