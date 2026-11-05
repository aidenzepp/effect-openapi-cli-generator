import { describe, expect, test } from "bun:test";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Result,
  Runtime,
  Schema,
  Stdio,
  Stream,
} from "effect";
import { Headers, HttpClientRequest, UrlParams } from "effect/http";
import { CredentialMissing, UsageError } from "../../src/runtime-src/domain/errors.ts";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";

const table: Auth.SecurityTable = {
  schemes: {
    apiKey: { in: "header", kind: "apiKey", name: "X-Key" },
    basicAuth: { kind: "http", scheme: "basic" },
    bearerAuth: { kind: "http", scheme: "bearer" },
    other: { env: "OTHER_TOKEN", kind: "http", scheme: "bearer" },
    queryKey: { in: "query", kind: "apiKey", name: "api_key" },
    sessionCookie: { in: "cookie", kind: "apiKey", name: "sid" },
  },
};

const secret = "s3cr3t-value";

const bytes = (text: string) => new TextEncoder().encode(text);

interface World {
  readonly env?: Record<string, string>;
  readonly files?: Record<string, string>;
  readonly given?: Record<string, string>;
  readonly stdin?: string;
}

const run = (world: World, requirement: Auth.SecurityRequirement) => {
  const files = world.files ?? {};
  const fs = FileSystem.layerNoop({
    stream: (path) => Stream.make(bytes(files[path] ?? "")),
  });
  // Real stdin is one-shot: a second read finds it drained.
  let drained = false;
  const stdio = Stdio.layerTest({
    stdin: Stream.suspend(() => {
      const chunk = drained ? new Uint8Array() : bytes(world.stdin ?? "");
      drained = true;

      return Stream.make(chunk);
    }),
  });
  let provided = Auth.evaluate("users-update", requirement);
  for (const [scheme, path] of Object.entries(world.given ?? {})) {
    provided = provided.pipe(
      Effect.provideService(Auth.credentialFileSetting(scheme), Option.some(path)),
    );
  }

  return Effect.runPromise(
    provided.pipe(
      Effect.provide(Layer.mergeAll(Auth.layer(table, "EXAMPLE"), fs, stdio)),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(world.env ?? {}))),
      Effect.result,
    ),
  );
};

const succeeded = (result: Result.Result<readonly Auth.Credential[], unknown>) =>
  Result.isSuccess(result)
    ? result.success.map((credential) => [credential.scheme, Redacted.value(credential.value)])
    : ["failed"];

const failure = (result: Result.Result<readonly Auth.Credential[], unknown>) =>
  Result.isFailure(result) ? result.failure : undefined;

const Single = Schema.Struct({ name: Schema.String, typeName: Schema.String });

const Optional = Schema.Struct({ param: Single });

describe("credentialFileSetting", () => {
  test("is named <scheme>-file with metavar path|-", () => {
    const setting = Auth.credentialFileSetting("bearerAuth");
    const flag = Schema.decodeUnknownSync(Optional)(setting.flag);

    expect(setting.id).toBe("bearer-auth-file");
    expect(flag.param.name).toBe("bearer-auth-file");
    expect(flag.param.typeName).toBe("path|-");
  });

  test("returns one setting per scheme", () => {
    expect(Auth.credentialFileSetting("apiKey")).toBe(Auth.credentialFileSetting("apiKey"));
  });
});

describe("Auth.layer", () => {
  test("provides Schemes with the table and the env prefix", async () => {
    const schemes = await Effect.runPromise(
      Effect.service(Auth.Schemes).pipe(Effect.provide(Auth.layer(table, "EXAMPLE"))),
    );

    expect(schemes.table).toBe(table);
    expect(schemes.envPrefix).toBe("EXAMPLE");
  });
});

describe("credential sources", () => {
  test("env EXAMPLE_<SCHEME> is the default source", async () => {
    const result = await run({ env: { EXAMPLE_BEARER_AUTH: secret } }, [["bearerAuth"]]);

    expect(succeeded(result)).toEqual([["bearerAuth", secret]]);
  });

  test("a scheme env override replaces the default name", async () => {
    const result = await run({ env: { OTHER_TOKEN: secret } }, [["other"]]);

    expect(succeeded(result)).toEqual([["other", secret]]);
  });

  test("the file beats env", async () => {
    const result = await run(
      {
        env: { EXAMPLE_BEARER_AUTH: "from-env" },
        files: { "/run/token": `${secret}\n` },
        given: { bearerAuth: "/run/token" },
      },
      [["bearerAuth"]],
    );

    expect(succeeded(result)).toEqual([["bearerAuth", secret]]);
  });

  test("- reads stdin", async () => {
    const result = await run({ given: { bearerAuth: "-" }, stdin: `${secret}\r\n` }, [
      ["bearerAuth"],
    ]);

    expect(succeeded(result)).toEqual([["bearerAuth", secret]]);
  });

  test("an over-limit file is refused without the value", async () => {
    const big = `${secret}${"x".repeat(Auth.maxCredentialBytes)}`;
    const result = await run({ files: { "/big": big }, given: { bearerAuth: "/big" } }, [
      ["bearerAuth"],
    ]);
    const error = failure(result);

    expect(error).toMatchObject({ _tag: "UsageError", flag: "bearer-auth-file" });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  test("an empty file is refused, an empty env value is unset", async () => {
    const emptyFile = await run({ files: { "/e": "\n" }, given: { bearerAuth: "/e" } }, [
      ["bearerAuth"],
    ]);
    const emptyEnv = await run({ env: { EXAMPLE_BEARER_AUTH: "" } }, [["bearerAuth"]]);

    expect(failure(emptyFile)).toMatchObject({ _tag: "UsageError" });
    expect(failure(emptyEnv)).toMatchObject({ _tag: "CredentialMissing" });
  });

  test("a credential that is not UTF-8 is refused", async () => {
    const fs = FileSystem.layerNoop({ stream: () => Stream.make(new Uint8Array([0xff, 0xfe])) });
    const result = await Effect.runPromise(
      Auth.evaluate("users-update", [["bearerAuth"]]).pipe(
        Effect.provideService(Auth.credentialFileSetting("bearerAuth"), Option.some("/bin")),
        Effect.provide(Layer.mergeAll(Auth.layer(table, "EXAMPLE"), fs, Stdio.layerTest({}))),
        Effect.result,
      ),
    );

    expect(failure(result)).toMatchObject({ _tag: "UsageError" });
  });
});

describe("requirement evaluation", () => {
  const both = { EXAMPLE_API_KEY: "key-value", EXAMPLE_BEARER_AUTH: "bearer-value" };

  test("takes the first qualifying alternative in document order", async () => {
    const result = await run({ env: both }, [["apiKey"], ["bearerAuth"]]);

    expect(succeeded(result)).toEqual([["apiKey", "key-value"]]);
  });

  test("skips an alternative whose schemes are not all configured", async () => {
    const result = await run({ env: { EXAMPLE_BEARER_AUTH: "bearer-value" } }, [
      ["apiKey", "bearerAuth"],
      ["bearerAuth"],
    ]);

    expect(succeeded(result)).toEqual([["bearerAuth", "bearer-value"]]);
  });

  test("an AND alternative sends every scheme", async () => {
    const result = await run({ env: both }, [["apiKey", "bearerAuth"]]);

    expect(succeeded(result)).toEqual([
      ["apiKey", "key-value"],
      ["bearerAuth", "bearer-value"],
    ]);
  });

  test("{} only when no credentialed alternative qualifies", async () => {
    const withKey = await run({ env: { EXAMPLE_API_KEY: "key-value" } }, [[], ["apiKey"]]);
    const withoutKey = await run({}, [[], ["apiKey"]]);

    expect(succeeded(withKey)).toEqual([["apiKey", "key-value"]]);
    expect(succeeded(withoutKey)).toEqual([]);
  });

  test("anonymous: no requirement sends no credentials", async () => {
    expect(succeeded(await run({}, []))).toEqual([]);
    expect(succeeded(await run({}, [[]]))).toEqual([]);
  });

  test("CredentialMissing, exit 3, when nothing is set, with no value in the error", async () => {
    // `other` reads OTHER_TOKEN, so the canary is read during evaluation; `apiKey` is unset, so
    // the AND alternative fails after the canary is held.
    const result = await run({ env: { OTHER_TOKEN: secret } }, [
      ["other", "apiKey"],
      ["bearerAuth"],
    ]);
    const error = failure(result);

    expect(error).toMatchObject({ _tag: "CredentialMissing", operation: "users-update" });
    expect(error).toHaveProperty("alternatives.length", 2);
    expect(error instanceof CredentialMissing && error[Runtime.errorExitCode]).toBe(3);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  test("a scheme the table does not define cannot qualify", async () => {
    const result = await run({}, [["undeclared"]]);

    expect(failure(result)).toMatchObject({ _tag: "CredentialMissing" });
  });

  test("stdin is one-shot: a second scheme reading - finds it empty", async () => {
    const result = await run({ given: { apiKey: "-", bearerAuth: "-" }, stdin: secret }, [
      ["apiKey", "bearerAuth"],
    ]);

    expect(failure(result)).toMatchObject({ _tag: "UsageError" });
  });
});

const bound = "https://api.example.test";

const unbound = "https://evil.example.test";

const credential = (scheme: string, value: string): Auth.Credential => {
  const definition = table.schemes[scheme];
  if (definition === undefined) {
    throw new Error(`no scheme ${scheme}`);
  }

  return { definition, scheme, value: Redacted.make(value) };
};

const attachTo = (
  url: string,
  credentials: readonly Auth.Credential[],
  origins: readonly string[],
  prepare: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest = (
    request,
  ) => request,
) =>
  Effect.runPromise(
    Auth.attach(table, { credentials, origins })(prepare(HttpClientRequest.get(url))).pipe(
      Effect.result,
    ),
  );

const sent = (result: Result.Result<HttpClientRequest.HttpClientRequest, UsageError>) => {
  if (Result.isFailure(result)) {
    throw new Error("expected a request");
  }

  return result.success;
};

const header = (request: HttpClientRequest.HttpClientRequest, name: string) =>
  Option.getOrUndefined(Headers.get(request.headers, name));

const query = (request: HttpClientRequest.HttpClientRequest) =>
  UrlParams.toRecord(UrlParams.fromInput(request.urlParams));

const stale = (request: HttpClientRequest.HttpClientRequest) =>
  request.pipe(
    HttpClientRequest.setHeader("authorization", "Bearer stale"),
    HttpClientRequest.setHeader("x-key", "stale"),
    HttpClientRequest.setHeader("cookie", "theme=dark; sid=stale; lang=en"),
    HttpClientRequest.setUrlParam("api_key", "stale"),
    HttpClientRequest.setUrlParam("page", "2"),
  );

describe("Auth.attach", () => {
  test("a bound origin gets an apiKey header", async () => {
    const result = sent(await attachTo(`${bound}/v1`, [credential("apiKey", "key-1")], [bound]));

    expect(header(result, "x-key")).toBe("key-1");
  });

  test("a bound origin gets an apiKey query pair, redacted in inspection", async () => {
    const result = sent(await attachTo(`${bound}/v1`, [credential("queryKey", "key-2")], [bound]));

    expect(query(result)).toEqual({ api_key: "key-2" });
    expect(JSON.stringify(result.urlParams)).not.toContain("key-2");
  });

  test("a bound origin gets an apiKey cookie after the existing cookies", async () => {
    const result = sent(
      await attachTo(`${bound}/v1`, [credential("sessionCookie", "tok-3")], [bound], (request) =>
        HttpClientRequest.setHeader(request, "cookie", "theme=dark"),
      ),
    );

    expect(header(result, "cookie")).toBe("theme=dark; sid=tok-3");
  });

  test("a bound origin gets an apiKey cookie alone when no cookie exists", async () => {
    const result = sent(
      await attachTo(`${bound}/v1`, [credential("sessionCookie", "tok-3")], [bound]),
    );

    expect(header(result, "cookie")).toBe("sid=tok-3");
  });

  test("a bound origin gets http basic and http bearer", async () => {
    const basic = sent(
      await attachTo(`${bound}/v1`, [credential("basicAuth", "josé:sec:ret")], [bound]),
    );
    const bearer = sent(
      await attachTo(`${bound}/v1`, [credential("bearerAuth", "tok-4")], [bound]),
    );

    expect(header(basic, "authorization")).toBe(
      `Basic ${btoa(String.fromCodePoint(...new TextEncoder().encode("josé:sec:ret")))}`,
    );
    expect(header(bearer, "authorization")).toBe("Bearer tok-4");
  });

  test("an unbound origin is stripped of every managed credential", async () => {
    const everything = [
      credential("apiKey", "key-1"),
      credential("queryKey", "key-2"),
      credential("sessionCookie", "tok-3"),
      credential("bearerAuth", "tok-4"),
    ];
    const result = sent(await attachTo(`${unbound}/v1`, everything, [bound], stale));

    expect(header(result, "authorization")).toBeUndefined();
    expect(header(result, "x-key")).toBeUndefined();
    expect(header(result, "cookie")).toBe("theme=dark; lang=en");
    expect(query(result)).toEqual({ page: "2" });
  });

  test("a bound origin replaces stale managed values and keeps the rest", async () => {
    const result = sent(
      await attachTo(
        `${bound}/v1`,
        [credential("apiKey", "key-1"), credential("queryKey", "key-2")],
        [bound],
        stale,
      ),
    );

    expect(header(result, "authorization")).toBeUndefined();
    expect(header(result, "x-key")).toBe("key-1");
    expect(header(result, "cookie")).toBe("theme=dark; lang=en");
    expect(query(result)).toEqual({ api_key: "key-2", page: "2" });
  });

  test("a managed query name inside the url itself is stripped on an unbound origin", async () => {
    const result = sent(
      await attachTo(`${unbound}/v1?API_KEY=leak&page=2&api_key=leak`, [], [bound]),
    );

    expect(result.url).toBe(`${unbound}/v1?API_KEY=leak&page=2`);
  });

  test("an origin matches by origin, not by prefix or case", async () => {
    const sibling = sent(
      await attachTo(`https://api.example.test.evil.test/v1`, [credential("apiKey", "k")], [bound]),
    );
    const upper = sent(
      await attachTo(`HTTPS://API.EXAMPLE.TEST:443/v1`, [credential("apiKey", "k")], [bound]),
    );

    expect(header(sibling, "x-key")).toBeUndefined();
    expect(header(upper, "x-key")).toBe("k");
  });

  test("a url that does not parse carries nothing", async () => {
    const result = sent(await attachTo("not a url", [credential("apiKey", "k")], [bound]));

    expect(header(result, "x-key")).toBeUndefined();
  });

  test("apiKey header value with CR, LF, NUL or edge whitespace", async () => {
    const values = [
      `ab\rcd-${secret}`,
      `ab\ncd-${secret}`,
      `ab\u0000cd-${secret}`,
      ` ${secret}`,
      `${secret} `,
    ];
    const results = await Promise.all(
      values.map((value) => attachTo(`${bound}/v1`, [credential("apiKey", value)], [bound])),
    );

    for (const result of results) {
      const error = Result.isFailure(result) ? result.failure : undefined;

      expect(error).toMatchObject({ _tag: "UsageError", flag: "api-key-file" });
      expect(error instanceof UsageError && error[Runtime.errorExitCode]).toBe(2);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  test("a bearer value with a line break is refused without the value", async () => {
    const result = await attachTo(
      `${bound}/v1`,
      [credential("bearerAuth", `${secret}\r\nX: y`)],
      [bound],
    );
    const error = Result.isFailure(result) ? result.failure : undefined;

    expect(error).toMatchObject({ _tag: "UsageError", flag: "bearer-auth-file" });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  test("a bad value is not checked when the origin gets no credential", async () => {
    const result = await attachTo(`${unbound}/v1`, [credential("apiKey", ` ${secret}`)], [bound]);

    expect(Result.isSuccess(result)).toBe(true);
  });

  test("an apiKey cookie value outside cookie-octet is refused without the value", async () => {
    const values = [
      `a;b${secret}`,
      `a b${secret}`,
      `a"b${secret}`,
      `a,b${secret}`,
      `a\\b${secret}`,
      `é${secret}`,
    ];
    const results = await Promise.all(
      values.map((value) => attachTo(`${bound}/v1`, [credential("sessionCookie", value)], [bound])),
    );

    for (const result of results) {
      const error = Result.isFailure(result) ? result.failure : undefined;

      expect(error).toMatchObject({ _tag: "UsageError", flag: "session-cookie-file" });
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  test("a bad basic user-id or password names the scheme only", async () => {
    const values = [
      `us\u0007er:${secret}`,
      `us\u0085er:${secret}`,
      `user:${secret}\u007F`,
      `us\uD800er:${secret}`,
      `user${secret}`,
    ];
    const results = await Promise.all(
      values.map((value) => attachTo(`${bound}/v1`, [credential("basicAuth", value)], [bound])),
    );

    for (const result of results) {
      const error = Result.isFailure(result) ? result.failure : undefined;

      expect(error).toMatchObject({ _tag: "UsageError", flag: "basic-auth-file" });
      expect(error instanceof UsageError && error[Runtime.errorExitCode]).toBe(2);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  test("an empty password is allowed", async () => {
    const result = sent(await attachTo(`${bound}/v1`, [credential("basicAuth", "user:")], [bound]));

    expect(header(result, "authorization")).toBe(`Basic ${btoa("user:")}`);
  });
});

const gate = (overrides: Partial<Auth.CredentialGate>): Auth.CredentialGate => ({
  allowUnboundBase: false,
  baseOrigin: unbound,
  boundOrigins: [bound],
  provenance: "operator",
  ...overrides,
});

describe("Auth.credentialOrigins", () => {
  test("an operator base on an unbound origin gets no credential without the flag", () => {
    expect(Auth.credentialOrigins(gate({}))).toEqual([bound]);
  });

  test("an operator base on an unbound origin gets credentials with the flag", async () => {
    const origins = Auth.credentialOrigins(gate({ allowUnboundBase: true }));
    const result = sent(await attachTo(`${unbound}/v1`, [credential("apiKey", "k")], origins));

    expect(origins).toEqual([bound, unbound]);
    expect(header(result, "x-key")).toBe("k");
  });

  test("the flag leaves a server base alone", () => {
    expect(Auth.credentialOrigins(gate({ allowUnboundBase: true, provenance: "server" }))).toEqual([
      bound,
    ]);
  });

  test("a bound operator base needs no flag", () => {
    expect(Auth.credentialOrigins(gate({ baseOrigin: bound }))).toEqual([bound]);
  });

  test("the flag does not widen to a redirect target", async () => {
    const origins = Auth.credentialOrigins(gate({ allowUnboundBase: true }));
    const hop = sent(
      await attachTo("https://other.example.test/v1", [credential("apiKey", "k")], origins),
    );

    expect(header(hop, "x-key")).toBeUndefined();
  });

  test("an unparseable base origin adds nothing", () => {
    expect(Auth.credentialOrigins(gate({ allowUnboundBase: true, baseOrigin: "nope" }))).toEqual([
      bound,
    ]);
  });
});

describe("allowCredentialsForBaseUrl", () => {
  test("is the root setting --allow-credentials-for-base-url", () => {
    expect(Auth.allowCredentialsForBaseUrl.id).toBe("allow-credentials-for-base-url");
  });
});

describe("Auth.redactedNames", () => {
  test("adds apiKey header and query names to the defaults, per list", async () => {
    const names = await Effect.runPromise(
      Effect.all({
        headers: Effect.service(Headers.CurrentRedactedNames),
        params: Effect.service(UrlParams.CurrentRedactedNames),
      }).pipe(Effect.provide(Auth.redactedNames(table))),
    );

    expect(names.headers).toContain("authorization");
    expect(names.headers).toContain("X-Key");
    expect(names.headers).not.toContain("api_key");
    expect(names.params).toContain("api_key");
    expect(names.params).not.toContain("X-Key");
    expect(Headers.isRedactedName("x-key", names.headers)).toBe(true);
    expect(UrlParams.redactUrl(`${bound}/v1?api_key=${secret}&page=2`, names.params)).not.toContain(
      secret,
    );
  });
});
