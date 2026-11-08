import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Stdio,
  Stream,
  Terminal,
} from "effect";
import { Flag, GlobalFlag, Prompt, TerminalCapabilities } from "effect/cli";
import type { FetchHttpClient } from "effect/http";
import { Headers, HttpClientRequest, UrlParams } from "effect/http";
import { CredentialMissing, UsageError } from "../domain/errors.ts";
import type { Provenance } from "./base-url.ts";
import { StdinClaim } from "./input.ts";

/**
 * A scheme's security requirement list: alternatives in document order, each the scheme names that
 * must all be satisfied. `[]` is no requirement and `[]` inside the list is anonymous.
 */
export type SecurityRequirement = readonly (readonly string[])[];

/**
 * A scheme the runtime sends. `env` overrides the default environment name `<PREFIX>_<SCHEME>`;
 * `deprecated` marks a 3.2 scheme the runtime names on stderr when it sends it. An `oauth2` or
 * `openIdConnect` scheme is operator-supplied token pass-through (design 6.5, D-SEC1): the token is
 * sent as `Authorization: Bearer`, and no token is acquired, no discovery is run, and no scope or
 * role is sent. A `mutualTLS` scheme is a client certificate (design 6.5, D-SEC3): its paths are
 * read from `Config` by the names it carries, `certEnv`, `keyEnv` and `caEnv`, which the name plan
 * derives once (design 4.4) and the runtime never folds itself; it is never a header.
 */
export type SecurityScheme =
  | {
      readonly deprecated?: true;
      readonly env?: string | undefined;
      readonly in: "cookie" | "header" | "query";
      readonly kind: "apiKey";
      readonly name: string;
    }
  | {
      readonly deprecated?: true;
      readonly env?: string | undefined;
      readonly kind: "http";
      readonly scheme: "basic" | "bearer";
    }
  | {
      readonly deprecated?: true;
      readonly env?: string | undefined;
      readonly kind: "oauth2";
    }
  | {
      readonly deprecated?: true;
      readonly env?: string | undefined;
      readonly kind: "openIdConnect";
    }
  | {
      readonly caEnv: string;
      readonly certEnv: string;
      readonly deprecated?: true;
      readonly keyEnv: string;
      readonly kind: "mutualTLS";
    };

/**
 * A `mutualTLS` scheme: a client certificate, not a header credential.
 */
export type MutualTlsScheme = Extract<SecurityScheme, { readonly kind: "mutualTLS" }>;

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
 * The environment name of a token scheme's credential: the scheme's own `env`, else
 * `<PREFIX>_<SCHEME>`. A `mutualTLS` scheme has no single credential name: the runtime reads its
 * `certEnv`, `keyEnv` and `caEnv` instead and never calls this for one.
 */
export const envName = (envPrefix: string, scheme: string, definition: SecurityScheme): string =>
  ("env" in definition ? definition.env : undefined) ??
  `${envPrefix}_${schemeSlug(scheme).toUpperCase().replaceAll("-", "_")}`;

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
): Effect.Effect<string, UsageError, FileSystem.FileSystem | Stdio.Stdio | StdinClaim> =>
  path === "-"
    ? Effect.service(StdinClaim).pipe(
        Effect.flatMap((claim) => claim.claim(`${schemeSlug(scheme)}-file`)),
        Effect.flatMap(() => Effect.service(Stdio.Stdio)),
        Effect.flatMap((stdio) => readBounded(scheme, stdio.stdin)),
      )
    : Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
        readBounded(scheme, fs.stream(path, { bytesToRead: maxCredentialBytes + 1 })),
      );

const fromEnv = (scheme: string, name: string): Effect.Effect<Option.Option<string>, UsageError> =>
  Config.option(Config.Redacted(name)).pipe(
    Effect.map(Option.map(Redacted.value)),
    Effect.map(Option.filter((value) => value !== "")),
    Effect.mapError(() => usage(scheme, `cannot read ${name} for ${scheme}`)),
  );

/**
 * The configured client-certificate paths of one `mutualTLS` scheme.
 */
export interface ClientCertificatePaths {
  readonly ca: Option.Option<string>;
  readonly cert: string;
  readonly key: string;
}

// An empty variable is unset, as for every other credential.
const certificatePath = (name: string): Config.Config<Option.Option<string>> =>
  Config.option(Config.String(name)).pipe(Config.map(Option.filter((path) => path !== "")));

/**
 * The `Config` descriptor of a `mutualTLS` scheme's three paths, read by exactly the names the
 * scheme carries: some when both `certEnv` and `keyEnv` are set, the CA optional, none otherwise.
 * `bin.ts` reads it to build the certificate init; `evaluate` reads it to decide satisfaction.
 */
export const clientCertificatePaths = (
  definition: MutualTlsScheme,
): Config.Config<Option.Option<ClientCertificatePaths>> =>
  Config.all({
    ca: certificatePath(definition.caEnv),
    cert: certificatePath(definition.certEnv),
    key: certificatePath(definition.keyEnv),
  }).pipe(
    Config.map(({ ca, cert, key }) =>
      Option.map(Option.all({ cert, key }), (paths) => ({ ca, ...paths })),
    ),
  );

// A satisfied `mutualTLS` scheme is a credential whose value is the certificate path, held
// redacted: never sent, and scrubbed like any other credential if a response echoes it.
const certificateOf = (
  scheme: string,
  definition: MutualTlsScheme,
): Effect.Effect<Option.Option<Credential>, UsageError> =>
  clientCertificatePaths(definition).pipe(
    Effect.map(Option.map((paths) => ({ definition, scheme, value: Redacted.make(paths.cert) }))),
    Effect.mapError(
      () =>
        new UsageError({
          message: `cannot read ${definition.certEnv} or ${definition.keyEnv} for ${scheme}`,
        }),
    ),
  );

const credentialOf = (
  scheme: string,
  definition: SecurityScheme,
  envPrefix: string,
): Effect.Effect<
  Option.Option<Credential>,
  UsageError,
  FileSystem.FileSystem | Stdio.Stdio | StdinClaim
> =>
  Effect.gen(function* readCredential() {
    if (definition.kind === "mutualTLS") {
      return yield* certificateOf(scheme, definition);
    }

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

// A scheme name comes from the generated table, but a terminal must never see a control character.
const unsafeName = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu;

/**
 * The one stderr notice for a chosen deprecated scheme: it names the scheme and never a value.
 */
const noticeDeprecated = (
  credentials: readonly Credential[],
): Effect.Effect<void, never, Stdio.Stdio> =>
  Effect.gen(function* notify() {
    const stdio = yield* Stdio.Stdio;
    for (const { definition, scheme } of credentials) {
      if (definition.deprecated === true) {
        const name = scheme.replaceAll(unsafeName, "");
        yield* Stream.run(
          Stream.make(`Notice: the security scheme ${name} is deprecated\n`),
          stdio.stderr(),
        );
      }
    }
  }).pipe(Effect.ignore);

interface PromptServices {
  readonly path: Path.Path;
  readonly terminal: Terminal.Terminal;
}

// `Terminal` and `Path` are read optionally, so `evaluate` adds no requirement: `Command.run`
// provides both, and without them the prompt is skipped as off a TTY.
const promptServices: Effect.Effect<Option.Option<PromptServices>> = Effect.gen(
  function* promptServicesOf() {
    const { canPrompt } = yield* TerminalCapabilities.TerminalCapabilities;
    const terminal = yield* Effect.serviceOption(Terminal.Terminal);
    const path = yield* Effect.serviceOption(Path.Path);

    return canPrompt && Option.isSome(terminal) && Option.isSome(path)
      ? Option.some({ path: path.value, terminal: terminal.value })
      : Option.none();
  },
);

/**
 * Ask for one scheme's credential with `Prompt.Password`, which masks the input and returns it
 * `Redacted`. An empty answer is no credential; a quit prompt interrupts the run.
 */
const ask = (
  scheme: string,
  { path, terminal }: PromptServices,
): Effect.Effect<Option.Option<Redacted.Redacted>, never, FileSystem.FileSystem> =>
  Prompt.run(
    Prompt.Password({ message: `Credential for ${scheme.replaceAll(unsafeName, "")}` }),
  ).pipe(
    Effect.provideService(Terminal.Terminal, terminal),
    Effect.provideService(Path.Path, path),
    Effect.map(Option.liftPredicate((value) => Redacted.value(value) !== "")),
    Effect.catchTag("QuitError", () => Effect.interrupt),
  );

// The prompt reads stdin, so it takes the one stdin claim; `false` when a `-` consumer holds it.
const claimStdin = (scheme: string): Effect.Effect<boolean, never, StdinClaim> =>
  Effect.flatMap(Effect.service(StdinClaim), (stdin) =>
    stdin.claim(`${schemeSlug(scheme)}-file`),
  ).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

const describeAlternative = (
  envPrefix: string,
  table: SecurityTable,
  alternative: readonly string[],
): string =>
  alternative
    .map((scheme) => {
      const definition = table.schemes[scheme];
      if (definition?.kind === "mutualTLS") {
        return `${scheme} (env ${definition.certEnv} + ${definition.keyEnv})`;
      }

      const env = definition === undefined ? "" : `, env ${envName(envPrefix, scheme, definition)}`;

      return `${scheme} (--${schemeSlug(scheme)}-file${env})`;
    })
    .join(" + ");

/**
 * The alternative the prompt fills: the first, in document order, whose schemes are all defined
 * and whose every `mutualTLS` scheme is configured, because a certificate path is never asked for.
 */
const promptTarget = <R>(
  table: SecurityTable,
  requirement: SecurityRequirement,
  resolve: (scheme: string) => Effect.Effect<Option.Option<Credential>, UsageError, R>,
): Effect.Effect<Option.Option<readonly string[]>, UsageError, R> =>
  Effect.gen(function* findPromptTarget() {
    for (const alternative of requirement) {
      if (alternative.every((scheme) => Object.hasOwn(table.schemes, scheme))) {
        const certificates = alternative.filter(
          (scheme) => table.schemes[scheme]?.kind === "mutualTLS",
        );
        const configured = yield* Effect.all(certificates.map((scheme) => resolve(scheme)));
        if (configured.every(Option.isSome)) {
          return Option.some(alternative);
        }
      }
    }

    return Option.none();
  });

/**
 * Choose the credentials one operation sends (design 6.5 Run-time choice): the first alternative,
 * in document order, that names a scheme and whose every scheme has a configured credential. A `{}`
 * alternative, or no requirement at all, sends no credentials and is used only when no credentialed
 * alternative qualifies. Otherwise `CredentialMissing`. A scheme the table does not define cannot
 * be configured. A chosen deprecated scheme is named once on stderr before the request. Each scheme
 * is resolved once, so stdin is claimed at most once, shared with the body flags through
 * `StdinClaim`.
 *
 * The TTY prompt is the last credential source (design 6.5, D-SEC5: file flag > env > prompt).
 * It is asked only when no alternative qualifies from the file flags and the environment and no
 * `{}` allows anonymous access, so a configured alternative is never preceded by a prompt. It
 * fills the first alternative, in document order, whose schemes are all defined, asking for each
 * scheme with no configured credential. It runs only when stdin and stdout are TTYs
 * (`TerminalCapabilities.canPrompt`, the check `Flag.withFallbackPrompt` makes) and stdin is
 * unclaimed: the prompt reads stdin, so it takes the one stdin claim (design 4.5), and a `-`
 * consumer that holds it skips the prompt. A skipped or unanswered prompt is `CredentialMissing`.
 */
export const evaluate = (
  operation: string,
  requirement: SecurityRequirement,
): Effect.Effect<
  readonly Credential[],
  CredentialMissing | UsageError,
  Schemes | FileSystem.FileSystem | Stdio.Stdio | StdinClaim
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
        yield* noticeDeprecated(credentials);

        return credentials;
      }
    }

    if (requirement.length === 0 || requirement.some((alternative) => alternative.length === 0)) {
      return [];
    }

    const target = Option.getOrUndefined(yield* promptTarget(table, requirement, resolve));
    const services = target === undefined ? Option.none() : yield* promptServices;
    if (target !== undefined && Option.isSome(services)) {
      // Every file flag is read before the first prompt, so a `--<scheme>-file -` keeps stdin.
      const configured: (readonly [string, Option.Option<Credential>])[] = [];
      for (const scheme of target) {
        configured.push([scheme, yield* resolve(scheme)]);
      }

      const credentials: Credential[] = [];
      let claimed = false;
      for (const [scheme, found] of configured) {
        const definition = table.schemes[scheme];
        if (Option.isSome(found)) {
          credentials.push(found.value);
        } else if (definition !== undefined) {
          if (!claimed) {
            claimed = yield* claimStdin(scheme);
          }

          if (!claimed) {
            break;
          }

          const answer = yield* ask(scheme, services.value);
          if (Option.isNone(answer)) {
            break;
          }

          credentials.push({ definition, scheme, value: answer.value });
        }
      }

      if (credentials.length === target.length) {
        yield* noticeDeprecated(credentials);

        return credentials;
      }
    }

    return yield* new CredentialMissing({
      alternatives: requirement.map((alternative) =>
        describeAlternative(envPrefix, table, alternative),
      ),
      operation,
    });
  });

/**
 * `--allow-credentials-for-base-url` lets credentials reach an operator-chosen base URL whose
 * origin is not bound (design 6.5, D-SEC2). It never extends to a server-table base.
 */
export const allowCredentialsForBaseUrl = GlobalFlag.Setting("allow-credentials-for-base-url")({
  flag: Flag.Boolean("allow-credentials-for-base-url").pipe(
    Flag.withDescription("Send credentials to an unbound --base-url or <PREFIX>_BASE_URL origin"),
    Flag.withDefault(false),
  ),
});

/**
 * What the credential gate reads: the bound origin set, the chosen base's origin and provenance,
 * and the flag.
 */
export interface CredentialGate {
  readonly allowUnboundBase: boolean;
  readonly baseOrigin: string;
  readonly boundOrigins: readonly string[];
  readonly provenance: Provenance;
}

const originOf = (raw: string): Option.Option<string> => {
  if (!URL.canParse(raw)) {
    return Option.none();
  }

  const { origin } = new URL(raw);

  return origin === "null" ? Option.none() : Option.some(origin);
};

/**
 * The origins that may carry credentials for one run (design 6.5, D-SEC2): the bound origin set,
 * plus the chosen base's origin only when the operator chose it (`--base-url`,
 * `<PREFIX>_BASE_URL`) and gave `--allow-credentials-for-base-url`. A server-table base adds
 * nothing, and the flag never widens to a redirect target. Entries that do not parse are dropped,
 * so a malformed origin can only withhold a credential.
 */
export const credentialOrigins = (gate: CredentialGate): readonly string[] => {
  const base = gate.provenance === "operator" && gate.allowUnboundBase ? [gate.baseOrigin] : [];

  return [
    ...new Set([...gate.boundOrigins, ...base].flatMap((raw) => Option.toArray(originOf(raw)))),
  ];
};

// Whether a URL's origin is one of `origins`. An unparsable URL or origin is never bound.
const isBound = (url: string, origins: readonly string[]): boolean => {
  const origin = originOf(url);
  const allowed = new Set(origins.flatMap((raw) => Option.toArray(originOf(raw))));

  return Option.isSome(origin) && allowed.has(origin.value);
};

/**
 * The client-certificate request init `bin.ts` builds from `clientCertificatePaths` (Bun's `tls`
 * option). Opaque to the runtime, which only decides which hop carries it.
 */
export type CertificateInit = FetchHttpClient.RequestInit["Service"];

/**
 * The certificate init for this run, or none. `bin.ts` provides it when the package has a
 * `mutualTLS` scheme with its paths configured; otherwise it is none.
 */
export const ClientCertificate = Context.Reference<Option.Option<CertificateInit>>(
  "openapi-cli/runtime/ClientCertificate",
  { defaultValue: Option.none },
);

/**
 * The per-hop certificate decision (design 6.5 Origin binding; MIND): the `ClientCertificate`
 * init only when `url`'s origin is in the operation's bound origin set, none otherwise. It takes
 * the bound origins alone, never `credentialOrigins`, because `--allow-credentials-for-base-url`
 * never extends to the certificate. A request decided none is sent without the certificate, not
 * refused.
 */
export const certificateInitFor = (
  url: string,
  boundOrigins: readonly string[],
): Effect.Effect<Option.Option<CertificateInit>> =>
  Effect.map(Effect.service(ClientCertificate), (init) =>
    isBound(url, boundOrigins) ? init : Option.none(),
  );

/**
 * The certificate clause of the R1 withheld notice (design 6.4; m3.md P19): it names
 * `--allow-credentials-for-base-url` only to say the flag does not extend to the certificate,
 * and never names a path or certificate material.
 */
export const withheldCertificateClause =
  "not presenting the mutualTLS client certificate to an unbound base URL; " +
  "--allow-credentials-for-base-url does not extend to it";

/**
 * The credentials to attach and the origins that may carry them (`credentialOrigins`).
 */
export interface Attachment {
  readonly credentials: readonly Credential[];
  readonly origins: readonly string[];
}

const apiKeyNames = (table: SecurityTable, place: "cookie" | "header" | "query"): Set<string> =>
  new Set(
    Object.values(table.schemes).flatMap((definition) =>
      definition.kind === "apiKey" && definition.in === place ? [definition.name] : [],
    ),
  );

// Every kind but `apiKey` and `mutualTLS` sends `Authorization`.
const hasAuthorizationScheme = (table: SecurityTable): boolean =>
  Object.values(table.schemes).some(
    (definition) => definition.kind !== "apiKey" && definition.kind !== "mutualTLS",
  );

const cookiePairs = (cookie: string): readonly string[] =>
  cookie
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair !== "");

const cookieName = (pair: string): string => pair.split("=", 1)[0] ?? "";

const stripUrlQuery = (url: string, names: ReadonlySet<string>): string => {
  const mark = url.indexOf("?");
  if (mark === -1) {
    return url;
  }

  const hash = url.indexOf("#", mark);
  const end = hash === -1 ? url.length : hash;
  const kept = url
    .slice(mark + 1, end)
    .split("&")
    .filter((pair) => !names.has(new URLSearchParams(pair).keys().next().value ?? ""));

  return `${url.slice(0, mark)}${kept.length === 0 ? "" : `?${kept.join("&")}`}${url.slice(end)}`;
};

/**
 * Remove every managed credential the table can name: `Authorization` when any `http`, `oauth2` or
 * `openIdConnect` scheme is declared, each `apiKey` header, query name and cookie name.
 */
const strip = (
  table: SecurityTable,
  request: HttpClientRequest.HttpClientRequest,
): HttpClientRequest.HttpClientRequest => {
  const queryNames = apiKeyNames(table, "query");
  const cookieNames = apiKeyNames(table, "cookie");
  const headerNames = [
    ...apiKeyNames(table, "header"),
    ...(hasAuthorizationScheme(table) ? ["authorization"] : []),
  ];
  let { headers } = request;
  for (const name of headerNames) {
    headers = Headers.remove(headers, name);
  }

  const cookies = Option.match(Headers.get(headers, "cookie"), {
    onNone: () => headers,
    onSome: (cookie) => {
      const kept = cookiePairs(cookie).filter((pair) => !cookieNames.has(cookieName(pair)));

      return kept.length === 0
        ? Headers.remove(headers, "cookie")
        : Headers.set(headers, "cookie", kept.join("; "));
    },
  });

  return HttpClientRequest.makeWith(
    request.method,
    stripUrlQuery(request.url, queryNames),
    UrlParams.transform(UrlParams.fromInput(request.urlParams), (params) =>
      params.filter(([name]) => !queryNames.has(name)),
    ),
    request.hash,
    cookies,
    request.body,
  );
};

// A header field carries one byte per character, so a code point above U+00FF has no form.
const wideCodePoint = /[\u{100}-\u{10FFFF}]/u;

const unsafeHeaderValue = (value: string): boolean =>
  value.includes("\r") ||
  value.includes("\n") ||
  value.includes("\u0000") ||
  value !== value.trim() ||
  wideCodePoint.test(value);

// An RFC 6265 cookie-name is an RFC 9110 token.
const cookieNameToken = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

const cookieOctets = /^[\u0021\u0023-\u002B\u002D-\u003A\u003C-\u005B\u005D-\u007E]*$/u;

const refuse = (scheme: string, rule: string): Effect.Effect<never, UsageError> =>
  Effect.fail(usage(scheme, `the credential for ${scheme} ${rule}`));

const headerValue = (scheme: string, value: string): Effect.Effect<string, UsageError> =>
  unsafeHeaderValue(value)
    ? refuse(
        scheme,
        "has a CR, LF, NUL, leading or trailing whitespace or a code point above U+00FF",
      )
    : Effect.succeed(value);

const basicParts = (
  scheme: string,
  value: string,
): Effect.Effect<readonly [string, string], UsageError> => {
  const colon = value.indexOf(":");
  if (colon === -1) {
    return refuse(scheme, "must be <user-id>:<password>");
  }

  if (/\p{Cs}/u.test(value)) {
    return refuse(scheme, "has a lone surrogate");
  }

  if (/\p{Cc}/u.test(value)) {
    return refuse(scheme, "has a control character");
  }

  return Effect.succeed([value.slice(0, colon), value.slice(colon + 1)]);
};

const attachOne = (
  request: HttpClientRequest.HttpClientRequest,
  { definition, scheme, value }: Credential,
): Effect.Effect<HttpClientRequest.HttpClientRequest, UsageError> => {
  // The certificate is presented by the request init (`certificateInitFor`), never as a header.
  if (definition.kind === "mutualTLS") {
    return Effect.succeed(request);
  }

  const secret = Redacted.value(value);
  if (definition.kind === "oauth2" || definition.kind === "openIdConnect") {
    return Effect.map(headerValue(scheme, secret), (token) =>
      HttpClientRequest.bearerToken(request, token),
    );
  }

  if (definition.kind === "http") {
    return definition.scheme === "bearer"
      ? Effect.map(headerValue(scheme, secret), (token) =>
          HttpClientRequest.bearerToken(request, token),
        )
      : Effect.map(basicParts(scheme, secret), ([user, password]) =>
          HttpClientRequest.basicAuth(request, user, password),
        );
  }

  if (definition.in === "header") {
    return Effect.map(headerValue(scheme, secret), (text) =>
      HttpClientRequest.setHeader(request, definition.name, text),
    );
  }

  if (definition.in === "query") {
    return Effect.succeed(HttpClientRequest.setUrlParam(request, definition.name, value));
  }

  if (!cookieNameToken.test(definition.name)) {
    return refuse(scheme, "has a cookie name that is not a token");
  }

  if (!cookieOctets.test(secret)) {
    return refuse(scheme, "is not a valid cookie value");
  }

  const existing = Option.getOrElse(Headers.get(request.headers, "cookie"), () => "");
  const pairs = [...cookiePairs(existing), `${definition.name}=${secret}`];

  return Effect.succeed(HttpClientRequest.setHeader(request, "cookie", pairs.join("; ")));
};

/**
 * The one attach transform (design 6.5 Origin binding). It strips every managed credential from
 * the request, then attaches the configured credentials only when the request's origin is in
 * `origins`. The redirect loop runs it on every hop, so no hop inherits a credential. A credential
 * value that cannot be sent safely is a `UsageError` naming the scheme, raised only when it would
 * be attached. A basic credential is `<user-id>:<password>`, split at the first colon.
 */
export const attach =
  (table: SecurityTable, attachment: Attachment) =>
  (
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<HttpClientRequest.HttpClientRequest, UsageError> => {
    const clean = strip(table, request);

    return isBound(clean.url, attachment.origins)
      ? Effect.reduce(attachment.credentials, () => clean, attachOne)
      : Effect.succeed(clean);
  };

/**
 * Extend `Headers.CurrentRedactedNames` with every `apiKey` header name and
 * `UrlParams.CurrentRedactedNames` with every `apiKey` query name, keeping Effect's defaults
 * (design 7.5). A cookie name needs no entry: the whole `Cookie` header is redacted by default.
 */
export const redactedNames = (table: SecurityTable) =>
  Layer.mergeAll(
    Layer.effect(Headers.CurrentRedactedNames)(
      Effect.map(Effect.service(Headers.CurrentRedactedNames), (current) => [
        ...current,
        ...apiKeyNames(table, "header"),
      ]),
    ),
    Layer.effect(UrlParams.CurrentRedactedNames)(
      Effect.map(Effect.service(UrlParams.CurrentRedactedNames), (current) => [
        ...current,
        ...apiKeyNames(table, "query"),
      ]),
    ),
  );

const dottedLoopback = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u;

const mappedLoopback = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/u;

/**
 * The one loopback predicate (design 6.5 Loopback hosts). Its input is a WHATWG `URL.hostname`:
 * lowercase, IPv6 in brackets, IPv4 in dotted form. Loopback is `localhost` or a `.localhost`
 * name (one trailing dot allowed), a dotted IPv4 address in `127.0.0.0/8`, `[::1]`, and an
 * IPv4-mapped address in `127.0.0.0/8`, which `URL` writes in hex (`[::ffff:7f00:1]`).
 */
export const isLoopbackHost = (hostname: string): boolean => {
  const name = hostname.replace(/\.$/u, "");

  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name === "[::1]" ||
    dottedLoopback.test(name) ||
    mappedLoopback.test(name)
  );
};

/**
 * The one stderr line for credentials sent over plaintext `http:` (design 13.1 R3, D-SEC2): when
 * `--allow-credentials-for-base-url` let credentials reach the base URL, and that URL is `http:` on
 * a host `isLoopbackHost` rejects. A loopback host gets none, because its requests go direct and
 * never reach a proxy (design 6.5 Loopback hosts); `https:`, an unparsable URL and a run without
 * the flag get none. The line names the flag and the host, never userinfo or a credential.
 * Printing it once per run is the caller's.
 */
export const plaintextWarning = (baseUrl: string, allowed: boolean): Option.Option<string> => {
  if (!allowed || !URL.canParse(baseUrl)) {
    return Option.none();
  }

  const { host, hostname, protocol } = new URL(baseUrl);

  return protocol === "http:" && !isLoopbackHost(hostname)
    ? Option.some(
        `Warning: --allow-credentials-for-base-url sends credentials to ${host} over plaintext http`,
      )
    : Option.none();
};
