import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Exit, Option, Schema } from "effect";
import type { UsageError } from "../../src/runtime-src/domain/errors.ts";
import { runtimeFallback } from "../../src/emit/entry.ts";
import { AuthorConfig } from "../../src/model/author-config.ts";
import * as Client from "../../src/runtime-src/runtime/client.ts";
import { effectiveIdleTimeoutSeconds } from "../../src/runtime-src/runtime/output.ts";

// Design D-AD7: the author defaults reach the runtime's own resolvers through the provider the
// emitted `main.ts` composes, `ConfigProvider.orElse(<env>, ConfigProvider.fromUnknown(<fallback>))`.
// The fallback keys each default by its explicit prefixed env name, so a key the resolvers do not
// read leaves the author default unused and fails here.

const prefix = "ACME";

const base = { binName: "acme", envPrefix: prefix, package: { name: "acme", version: "1.0.0" } };

const bare = Schema.decodeUnknownSync(AuthorConfig)(base);

const authored = Schema.decodeUnknownSync(AuthorConfig)({
  ...base,
  runtime: { idleTimeoutSeconds: 11, retries: 5, timeoutSeconds: 7 },
});

const resolve = (
  resolver: Effect.Effect<number, UsageError>,
  env: Record<string, string>,
  fallback: Readonly<Record<string, number>>,
) =>
  Effect.runSyncExit(
    resolver.pipe(
      Effect.provideService(Client.timeoutSetting, Option.none()),
      Effect.provideService(Client.retriesSetting, Option.none()),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.orElse(
          ConfigProvider.fromEnv({ env }),
          ConfigProvider.fromUnknown(fallback),
        ),
      ),
    ),
  );

const settings = [
  {
    authored: 7,
    builtIn: 30,
    name: "timeout",
    resolver: Client.effectiveTimeoutSeconds(prefix),
    variable: `${prefix}_TIMEOUT`,
  },
  {
    authored: 5,
    builtIn: 2,
    name: "retries",
    resolver: Client.effectiveRetries(prefix),
    variable: `${prefix}_RETRIES`,
  },
  {
    authored: 11,
    builtIn: 300,
    name: "idle timeout",
    resolver: effectiveIdleTimeoutSeconds(prefix),
    variable: `${prefix}_IDLE_TIMEOUT`,
  },
] as const;

describe("runtimeFallback", () => {
  test("keys each author default by its prefixed env name, nothing nested", () => {
    expect(runtimeFallback(authored)).toEqual({
      ACME_IDLE_TIMEOUT: 11,
      ACME_RETRIES: 5,
      ACME_TIMEOUT: 7,
    });
  });

  test("without an author runtime object the built-in values fill every key", () => {
    expect(runtimeFallback(bare)).toEqual({
      ACME_IDLE_TIMEOUT: 300,
      ACME_RETRIES: 2,
      ACME_TIMEOUT: 30,
    });
  });

  test("the prefix defaults to the bin name in SCREAMING_SNAKE", () => {
    const config = Schema.decodeUnknownSync(AuthorConfig)({
      binName: "example-cli",
      package: { name: "example-cli", version: "1.0.0" },
    });

    expect(Object.keys(runtimeFallback(config))).toEqual([
      "EXAMPLE_CLI_IDLE_TIMEOUT",
      "EXAMPLE_CLI_RETRIES",
      "EXAMPLE_CLI_TIMEOUT",
    ]);
  });

  for (const setting of settings) {
    test(`${setting.name}: env over author default over the built-in`, () => {
      const env = { [setting.variable]: "9" };
      expect(resolve(setting.resolver, env, runtimeFallback(authored))).toEqual(Exit.succeed(9));
      expect(resolve(setting.resolver, {}, runtimeFallback(authored))).toEqual(
        Exit.succeed(setting.authored),
      );
      expect(resolve(setting.resolver, {}, runtimeFallback(bare))).toEqual(
        Exit.succeed(setting.builtIn),
      );
      expect(resolve(setting.resolver, {}, {})).toEqual(Exit.succeed(setting.builtIn));
    });

    test(`${setting.name}: an unprefixed variable is never read`, () => {
      const unprefixed = { [setting.variable.slice(prefix.length + 1)]: "9" };
      expect(resolve(setting.resolver, unprefixed, runtimeFallback(authored))).toEqual(
        Exit.succeed(setting.authored),
      );
    });
  }
});
