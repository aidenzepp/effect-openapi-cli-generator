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
import { CredentialMissing } from "../../src/runtime-src/domain/errors.ts";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";

const table: Auth.SecurityTable = {
  schemes: {
    apiKey: { in: "header", kind: "apiKey", name: "X-Key" },
    bearerAuth: { kind: "http", scheme: "bearer" },
    other: { env: "OTHER_TOKEN", kind: "http", scheme: "bearer" },
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
    const result = await run({ env: { EXAMPLE_OTHER: secret } }, [["apiKey"], ["bearerAuth"]]);
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
