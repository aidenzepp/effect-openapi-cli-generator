import { Array as Arr, Data, Effect, Schema } from "effect";
import type { SchemaIssue } from "effect";
import { DocumentUri, JsonPointer } from "./brands.ts";
import { Diagnostic, sortDiagnostics } from "./diagnostic.ts";
import { formatPointer } from "./pointer.ts";

const binNamePattern = /^[a-z][a-z0-9-]*$/u;

const environmentNamePattern = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

const parameterKeyPattern = /^(?:cookie|header|path|query):.+$/u;

// A body field's RFC 6901 pointer relative to the body root, as its flag carries it (`/meta/name`):
// one or more `/`-led tokens, `~` only as `~0` or `~1`. The whole body (`""`) is not a field.
const fieldPointerPattern = /^(?:\/(?:[^/~]|~[01])*)+$/u;

// A flag name as the kebab fold writes one: dot-separated kebab segments, each led by a letter.
const flagNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$/u;

const rowId = "CFG-1";

// semver 2.0.0 (semver.org), whose grammar is visible ASCII with no whitespace, so the version is
// safe as a header value and an emitted literal.
const semverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u;

// `commands.module` is relative to the package root and stays inside it: `./` then plain segments,
// no `.`, `..` or empty segment, no absolute path, no backslash.
const commandsModule = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.makeFilter((module: string) => {
      const [lead, ...rest] = module.split("/");

      return (
        lead === "." &&
        rest.length > 0 &&
        !module.includes("\\") &&
        rest.every((part) => part !== "" && part !== "." && part !== "..")
      );
    }),
  ),
);

const environmentName = Schema.String.pipe(Schema.check(Schema.isPattern(environmentNamePattern)));

// An integer from `min` to `max` inclusive.
const intBetween = (min: number, max: number) =>
  Schema.Int.pipe(Schema.check(Schema.isBetween({ maximum: max, minimum: min })));

// The runtime settings a generated CLI starts from (planner choice P3): `timeoutSeconds: 0` disables
// the per-attempt timeout. The decoded config keeps only what the author wrote, so it round-trips;
// `runtimeSettings` applies `runtimeDefaults`, the one place the defaults live.
const RuntimeConfig = Schema.Struct({
  idleTimeoutSeconds: Schema.optionalKey(intBetween(1, 86_400)),
  retries: Schema.optionalKey(intBetween(0, 10)),
  timeoutSeconds: Schema.optionalKey(intBetween(0, 3600)),
});

// The Security Scheme Object subset an author may add (D-OQ3 (b)); normalization refuses a type or
// scheme the runtime cannot send exactly as it does a declared one.
const AddedScheme = Schema.Struct({
  deprecated: Schema.optionalKey(Schema.Boolean),
  flows: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  in: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  scheme: Schema.optionalKey(Schema.String),
  type: Schema.String,
});

const AddedSecurity = Schema.Struct({
  requirement: Schema.Array(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  schemes: Schema.Record(Schema.NonEmptyString, AddedScheme),
});

const ParameterOverride = Schema.Struct({ flag: Schema.optionalKey(Schema.NonEmptyString) });

const FieldOverride = Schema.Struct({
  flag: Schema.String.pipe(Schema.check(Schema.isPattern(flagNamePattern))),
});

// An alias group, like the naming extensions' group keys (design 4.4): a dotted string split at
// `.`, or an array whose elements are kept whole; no segment is empty.
const aliasGroup = Schema.Union([
  Schema.NonEmptyString.pipe(
    Schema.check(
      Schema.makeFilter((group: string) => group.split(".").every((segment) => segment !== "")),
    ),
  ),
  Schema.NonEmptyArray(Schema.NonEmptyString),
]);

// One alias command for an operation, named by a group and/or a method like the extension keys.
const ConfigAlias = Schema.Struct({
  group: Schema.optionalKey(aliasGroup),
  method: Schema.optionalKey(Schema.NonEmptyString),
}).check(
  Schema.makeFilter(
    (alias) =>
      alias.group !== undefined || alias.method !== undefined || "an alias names something",
  ),
);

// `aliases` replaces the operation's `x-forge-aliases`; an empty list drops them.
const OperationOverride = Schema.Struct({
  aliases: Schema.optionalKey(Schema.Array(ConfigAlias)),
  command: Schema.optionalKey(Schema.NonEmptyString),
  // Renames a body field's flag, keyed by the field's pointer relative to the body root.
  fields: Schema.optionalKey(
    Schema.Record(
      Schema.String.pipe(Schema.check(Schema.isPattern(fieldPointerPattern))),
      FieldOverride,
    ),
  ),
  group: Schema.optionalKey(Schema.NonEmptyString),
  parameters: Schema.optionalKey(
    Schema.Record(
      Schema.String.pipe(Schema.check(Schema.isPattern(parameterKeyPattern))),
      ParameterOverride,
    ),
  ),
  skip: Schema.optionalKey(Schema.Boolean),
});

/**
 * The author config (design 4.8, D-AD11); decoding is the only constructor. Overrides are keyed by
 * `operationId`, or by JSON Pointer for operations that have none.
 */
export class AuthorConfig extends Schema.Class<AuthorConfig>("AuthorConfig")({
  acceptedOrigins: Schema.optionalKey(Schema.Array(DocumentUri)),
  allowInsecure: Schema.optionalKey(Schema.Boolean),
  binName: Schema.String.pipe(Schema.check(Schema.isPattern(binNamePattern))),
  commands: Schema.optionalKey(
    Schema.Struct({
      module: commandsModule,
      names: Schema.Array(Schema.NonEmptyString),
    }),
  ),
  envPrefix: Schema.optionalKey(environmentName),
  naming: Schema.optionalKey(
    Schema.Struct({
      byPointer: Schema.optionalKey(Schema.Record(JsonPointer, OperationOverride)),
      operations: Schema.optionalKey(Schema.Record(Schema.NonEmptyString, OperationOverride)),
    }),
  ),
  // Opt-in switches for behavior outside the OpenAPI specification (D-AD11, D-OQ1); absent and
  // `false` both mean strict.
  nonStandard: Schema.optionalKey(
    Schema.Struct({ deepObjectBrackets: Schema.optionalKey(Schema.Boolean) }),
  ),
  package: Schema.Struct({
    name: Schema.NonEmptyString,
    version: Schema.String.pipe(Schema.check(Schema.isPattern(semverPattern))),
  }),
  retrievalUri: Schema.optionalKey(DocumentUri),
  runtime: Schema.optionalKey(RuntimeConfig),
  // `security.add` adds a scheme and requirement (D-OQ3 (b)); every other key is a scheme name with
  // its credential environment variable (D-AD11), so a scheme cannot be named `add`.
  security: Schema.optionalKey(
    Schema.StructWithRest(Schema.Struct({ add: Schema.optionalKey(AddedSecurity) }), [
      Schema.Record(
        Schema.NonEmptyString.pipe(
          Schema.check(Schema.makeFilter((name: string) => name !== "add")),
        ),
        Schema.Struct({ env: environmentName }),
      ),
    ]),
  ),
  servers: Schema.optionalKey(Schema.Struct({ accepted: Schema.Array(Schema.NonEmptyString) })),
}) {}

/**
 * The author config was refused; every diagnostic is a `document`-scope refusal, sorted by pointer.
 */
export class AuthorConfigRefused extends Data.TaggedError("AuthorConfigRefused")<{
  readonly diagnostics: readonly Diagnostic[];
}> {}

/**
 * Where the config was read from and, when known, the folded `info.title` that a missing `binName`
 * hint suggests.
 */
export interface AuthorConfigContext {
  readonly document: Schema.Schema.Type<typeof DocumentUri>;
  readonly foldedTitle?: string;
}

type Kind = "invalid" | "missing" | "unknown";

type Rule =
  | "invalid-bin-name"
  | "invalid-field-flag"
  | "invalid-field-pointer"
  | "invalid-version"
  | "invalid-value"
  | "missing-bin-name"
  | "missing-key"
  | "unknown-key"
  | "unsafe-commands-module"
  | "unsupported-key";

interface Finding {
  readonly kind: Kind;
  readonly path: readonly string[];
}

const findings = (issue: SchemaIssue.Issue, path: readonly string[]): readonly Finding[] => {
  if (issue._tag === "Pointer") {
    return findings(issue.issue, [...path, ...issue.path.map(String)]);
  }

  if (issue._tag === "Composite" || issue._tag === "AnyOf") {
    return issue.issues.length === 0
      ? [{ kind: "invalid", path }]
      : issue.issues.flatMap((inner) => findings(inner, path));
  }

  if (issue._tag === "Filter" || issue._tag === "Encoding") {
    return findings(issue.issue, path);
  }

  if (issue._tag === "MissingKey") {
    return [{ kind: "missing", path }];
  }

  return [{ kind: issue._tag === "UnexpectedKey" ? "unknown" : "invalid", path }];
};

const isVersion = (path: readonly string[]): boolean =>
  path.length === 2 && path[0] === "package" && path[1] === "version";

const isBinName = (path: readonly string[]): boolean => path.length === 1 && path[0] === "binName";

// Keys the design names but this release does not consume; they are refused, not ignored.
const isUnsupportedKey = (path: readonly string[]): boolean =>
  path.length === 1 && path[0] === "assertPatterns";

const isCommandsModule = (path: readonly string[]): boolean =>
  path.length === 2 && path[0] === "commands" && path[1] === "module";

// `naming.<operations|byPointer>.<key>.fields.<pointer>`, then `.flag` for the value.
const isField = (path: readonly string[], depth: number): boolean =>
  path.length === depth && path[0] === "naming" && path[3] === "fields";

const ruleOf = ({ kind, path }: Finding): Rule => {
  // A record key that fails its pattern is an excess key to the decoder.
  if (isField(path, 5) && kind === "unknown") {
    return "invalid-field-pointer";
  }

  if (kind === "unknown") {
    return isUnsupportedKey(path) ? "unsupported-key" : "unknown-key";
  }

  if (isBinName(path)) {
    return kind === "missing" ? "missing-bin-name" : "invalid-bin-name";
  }

  if (isCommandsModule(path) && kind === "invalid") {
    return "unsafe-commands-module";
  }

  if (isField(path, 6) && path[5] === "flag" && kind === "invalid") {
    return "invalid-field-flag";
  }

  if (isVersion(path) && kind === "invalid") {
    return "invalid-version";
  }

  return kind === "missing" ? "missing-key" : "invalid-value";
};

const messages: Readonly<Record<Rule, string>> = {
  "invalid-bin-name": "binName must match ^[a-z][a-z0-9-]*$.",
  "invalid-field-flag":
    "A body field flag must be a kebab name such as foo-bar, with dots between nested segments.",
  "invalid-field-pointer":
    "A fields key must be the body field's RFC 6901 pointer from the body root, such as /meta/name.",
  "invalid-value": "An author config value is not valid.",
  "invalid-version": "package.version must be a semver 2.0.0 version such as 1.2.3.",
  "missing-bin-name": "The author config has no binName.",
  "missing-key": "A required author config key is missing.",
  "unknown-key": "The author config has a key this generator does not define.",
  "unsafe-commands-module":
    "commands.module must be ./ followed by plain path segments inside the package.",
  "unsupported-key": "The author config key assertPatterns is not supported in this release.",
};

const hintOf = (rule: Rule, context: AuthorConfigContext): string | undefined =>
  rule === "missing-bin-name" && context.foldedTitle !== undefined
    ? `The folded info.title is "${context.foldedTitle}"; add "binName": "${context.foldedTitle}" if that is the name you want.`
    : undefined;

const diagnose = (finding: Finding, context: AuthorConfigContext): Diagnostic => {
  const rule = ruleOf(finding);
  const hint = hintOf(rule, context);

  const fields = {
    code: `${rowId}/${rule}`,
    document: context.document,
    element: "Author config",
    message: messages[rule],
    openapi: "",
    pointer: formatPointer(finding.path),
    row: rowId,
    scope: "document",
    severity: "refusal",
    specSection: context.document,
  };

  return Schema.decodeUnknownSync(Diagnostic)(hint === undefined ? fields : { ...fields, hint });
};

const refuse = (issue: SchemaIssue.Issue, context: AuthorConfigContext): AuthorConfigRefused => {
  const unique = Arr.dedupeWith(
    findings(issue, []).map((finding) => diagnose(finding, context)),
    (left, right) => left.pointer === right.pointer && left.code === right.code,
  );

  return new AuthorConfigRefused({
    diagnostics: sortDiagnostics([context.document], unique),
  });
};

/**
 * Decodes untrusted author config JSON into an `AuthorConfig` or the refusals that explain why not.
 * Every problem is reported at once; unknown keys are refused.
 */
export const decodeAuthorConfig = (
  input: Schema.Json,
  context: AuthorConfigContext,
): Effect.Effect<AuthorConfig, AuthorConfigRefused> =>
  Schema.decodeUnknownEffect(AuthorConfig)(input, {
    errors: "all",
    onExcessProperty: "error",
  }).pipe(Effect.mapError((failure) => refuse(failure.issue, context)));

/**
 * The runtime settings a generated CLI starts from, every field resolved.
 */
export interface RuntimeSettings {
  readonly idleTimeoutSeconds: number;
  readonly retries: number;
  readonly timeoutSeconds: number;
}

const runtimeDefaults: RuntimeSettings = {
  idleTimeoutSeconds: 300,
  retries: 2,
  timeoutSeconds: 30,
};

/**
 * The author's runtime settings with the defaults applied to every absent field (design D-AD7);
 * the defaults live only here.
 */
export const runtimeSettings = (config: AuthorConfig): RuntimeSettings => ({
  ...runtimeDefaults,
  ...config.runtime,
});
