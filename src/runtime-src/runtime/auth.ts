import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Stdio,
  Stream,
} from "effect";
import { Flag, GlobalFlag } from "effect/cli";
import { CredentialMissing, UsageError } from "../domain/errors.ts";

/**
 * A scheme's security requirement list: alternatives in document order, each the scheme names that
 * must all be satisfied. `[]` is no requirement and `[]` inside the list is anonymous.
 */
export type SecurityRequirement = readonly (readonly string[])[];

/**
 * A scheme the runtime sends. `env` overrides the default environment name `<PREFIX>_<SCHEME>`.
 */
export type SecurityScheme =
  | {
      readonly env?: string | undefined;
      readonly in: "cookie" | "header" | "query";
      readonly kind: "apiKey";
      readonly name: string;
    }
  | {
      readonly env?: string | undefined;
      readonly kind: "http";
      readonly scheme: "basic" | "bearer";
    };

/**
 * The emitted `api/security.ts`: every scheme the operations name, by component name.
 */
export interface SecurityTable {
  readonly schemes: Readonly<Record<string, SecurityScheme>>;
}

/**
 * A configured credential and the scheme it answers.
 */
export interface Credential {
  readonly definition: SecurityScheme;
  readonly scheme: string;
  readonly value: Redacted.Redacted;
}

/**
 * Ceiling for a credential read from a file or stdin, in bytes. A runtime choice: design 6.5 says
 * only "bounded".
 */
export const maxCredentialBytes = 65_536;

/**
 * The security table and environment prefix, provided once by the root `services` layer.
 */
export class Schemes extends Context.Service<
  Schemes,
  { readonly envPrefix: string; readonly table: SecurityTable }
>()("openapi-cli/runtime/Schemes") {}

export const layer = (table: SecurityTable, envPrefix: string): Layer.Layer<Schemes> =>
  Layer.succeed(Schemes)({ envPrefix, table });

/**
 * The flag spelling of a scheme name: `bearerAuth` is `bearer-auth`.
 */
export const schemeSlug = (scheme: string): string =>
  scheme
    .replaceAll(/(?<head>[a-z0-9])(?<tail>[A-Z])/gu, "$<head>-$<tail>")
    .replaceAll(/[^A-Za-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .toLowerCase();

/**
 * The environment name of a scheme's credential: the scheme's own `env`, else `<PREFIX>_<SCHEME>`.
 */
export const envName = (envPrefix: string, scheme: string, definition: SecurityScheme): string =>
  definition.env ?? `${envPrefix}_${schemeSlug(scheme).toUpperCase().replaceAll("-", "_")}`;

type FileSetting = GlobalFlag.Setting<string, Option.Option<string>>;

const fileSettings = new Map<string, FileSetting>();

/**
 * The root global setting `--<scheme>-file <path|->`. One setting per scheme: a second call
 * returns the first, so the flag registration and the evaluation read the same service key.
 */
export const credentialFileSetting = (scheme: string): FileSetting => {
  const name = `${schemeSlug(scheme)}-file`;
  const known = fileSettings.get(name);
  if (known !== undefined) {
    return known;
  }

  const created = GlobalFlag.Setting(name)({
    flag: Flag.String(name).pipe(Flag.withMetavar("path|-"), Flag.optional),
  });
  fileSettings.set(name, created);

  return created;
};

class OverLimit {
  readonly _tag = "OverLimit";
}

class ReadFailed {
  readonly _tag = "ReadFailed";
}

const usage = (scheme: string, message: string): UsageError =>
  new UsageError({ flag: `${schemeSlug(scheme)}-file`, message });

const decodeUtf8 = (scheme: string, bytes: Uint8Array): Effect.Effect<string, UsageError> =>
  Effect.try({
    catch: () => usage(scheme, `the credential for ${scheme} is not valid UTF-8`),
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  });

const stripLineEnd = (text: string): string => text.replace(/\r?\n$/u, "");

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  let size = 0;
  for (const chunk of chunks) {
    size += chunk.length;
  }

  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }

  return joined;
};

const readBounded = (
  scheme: string,
  source: Stream.Stream<Uint8Array, unknown>,
): Effect.Effect<string, UsageError> =>
  source.pipe(
    Stream.mapError((): OverLimit | ReadFailed => new ReadFailed()),
    Stream.limitBytes(maxCredentialBytes, (): Stream.Stream<Uint8Array, OverLimit | ReadFailed> =>
      Stream.fail(new OverLimit()),
    ),
    Stream.runCollect,
    Effect.mapError((cause) =>
      cause instanceof OverLimit
        ? usage(scheme, `the credential for ${scheme} is over ${maxCredentialBytes} bytes`)
        : usage(scheme, `cannot read the credential for ${scheme}`),
    ),
    Effect.map(concat),
    Effect.flatMap((joined) => decodeUtf8(scheme, joined)),
    Effect.map(stripLineEnd),
  );

const fromFile = (
  scheme: string,
  path: string,
): Effect.Effect<string, UsageError, FileSystem.FileSystem | Stdio.Stdio> =>
  path === "-"
    ? Effect.flatMap(Effect.service(Stdio.Stdio), (stdio) => readBounded(scheme, stdio.stdin))
    : Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
        readBounded(scheme, fs.stream(path, { bytesToRead: maxCredentialBytes + 1 })),
      );

const fromEnv = (scheme: string, name: string): Effect.Effect<Option.Option<string>, UsageError> =>
  Config.option(Config.Redacted(name)).pipe(
    Effect.map(Option.map(Redacted.value)),
    Effect.map(Option.filter((value) => value !== "")),
    Effect.mapError(() => usage(scheme, `cannot read ${name} for ${scheme}`)),
  );

const credentialOf = (
  scheme: string,
  definition: SecurityScheme,
  envPrefix: string,
): Effect.Effect<Option.Option<Credential>, UsageError, FileSystem.FileSystem | Stdio.Stdio> =>
  Effect.gen(function* readCredential() {
    const file = Option.flatten(yield* Effect.serviceOption(credentialFileSetting(scheme)));
    const value = Option.isSome(file)
      ? yield* fromFile(scheme, file.value).pipe(
          Effect.filterOrFail(
            (text) => text !== "",
            () => usage(scheme, `the credential for ${scheme} is empty`),
          ),
          Effect.map(Option.some),
        )
      : yield* fromEnv(scheme, envName(envPrefix, scheme, definition));

    return value.pipe(
      Option.map((text) => ({
        definition,
        scheme,
        value: Redacted.make(text),
      })),
    );
  });

const describeAlternative = (
  envPrefix: string,
  table: SecurityTable,
  alternative: readonly string[],
): string =>
  alternative
    .map((scheme) => {
      const definition = table.schemes[scheme];
      const env = definition === undefined ? "" : `, env ${envName(envPrefix, scheme, definition)}`;

      return `${scheme} (--${schemeSlug(scheme)}-file${env})`;
    })
    .join(" + ");

/**
 * Choose the credentials one operation sends (design 6.5 Run-time choice): the first alternative,
 * in document order, that names a scheme and whose every scheme has a configured credential. A
 * `{}` alternative, or no requirement at all, sends no credentials and is used only when no
 * credentialed alternative qualifies. Otherwise `CredentialMissing`. A scheme the table does not
 * define cannot be configured. Each scheme is resolved once, so stdin is read at most once.
 */
export const evaluate = (
  operation: string,
  requirement: SecurityRequirement,
): Effect.Effect<
  readonly Credential[],
  CredentialMissing | UsageError,
  Schemes | FileSystem.FileSystem | Stdio.Stdio
> =>
  Effect.gen(function* evaluateRequirement() {
    const { envPrefix, table } = yield* Schemes;
    const resolved = new Map<string, Option.Option<Credential>>();
    const resolve = Effect.fnUntraced(function* resolveScheme(scheme: string) {
      const known = resolved.get(scheme);
      if (known !== undefined) {
        return known;
      }

      const definition = table.schemes[scheme];
      const found =
        definition === undefined
          ? Option.none()
          : yield* credentialOf(scheme, definition, envPrefix);
      resolved.set(scheme, found);

      return found;
    });

    for (const alternative of requirement) {
      if (alternative.length === 0) {
        continue;
      }

      const credentials: Credential[] = [];
      for (const scheme of alternative) {
        const credential = yield* resolve(scheme);
        if (Option.isNone(credential)) {
          break;
        }

        credentials.push(credential.value);
      }

      if (credentials.length === alternative.length) {
        return credentials;
      }
    }

    if (requirement.length === 0 || requirement.some((alternative) => alternative.length === 0)) {
      return [];
    }

    return yield* new CredentialMissing({
      alternatives: requirement.map((alternative) =>
        describeAlternative(envPrefix, table, alternative),
      ),
      operation,
    });
  });
