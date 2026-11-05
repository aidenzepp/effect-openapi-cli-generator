import { Array as Arr, Data, Effect, Schema } from "effect";
import type { SchemaIssue } from "effect";
import { DocumentUri, JsonPointer } from "./brands.ts";
import { Diagnostic, sortDiagnostics } from "./diagnostic.ts";

const binNamePattern = /^[a-z][a-z0-9-]*$/u;

const environmentNamePattern = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

const parameterKeyPattern = /^(?:cookie|header|path|query):.+$/u;

const rowId = "CFG-1";

// semver 2.0.0 (semver.org), whose grammar is visible ASCII with no whitespace, so the version is
// safe as a header value and an emitted literal.
const semverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u;

const environmentName = Schema.String.pipe(Schema.check(Schema.isPattern(environmentNamePattern)));

const nonNegative = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

const ParameterOverride = Schema.Struct({ flag: Schema.optionalKey(Schema.NonEmptyString) });

const OperationOverride = Schema.Struct({
  command: Schema.optionalKey(Schema.NonEmptyString),
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
      module: Schema.NonEmptyString,
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
  package: Schema.Struct({
    name: Schema.NonEmptyString,
    version: Schema.String.pipe(Schema.check(Schema.isPattern(semverPattern))),
  }),
  retrievalUri: Schema.optionalKey(DocumentUri),
  runtime: Schema.optionalKey(
    Schema.Struct({
      idleTimeoutSeconds: Schema.optionalKey(nonNegative),
      retries: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
      timeoutSeconds: Schema.optionalKey(nonNegative),
    }),
  ),
  security: Schema.optionalKey(
    Schema.Record(Schema.NonEmptyString, Schema.Struct({ env: environmentName })),
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
  | "invalid-version"
  | "invalid-value"
  | "missing-bin-name"
  | "missing-key"
  | "unknown-key"
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

const escapeToken = (token: string): string => token.replaceAll("~", "~0").replaceAll("/", "~1");

const pointerOf = (path: readonly string[]): string =>
  path.map((t) => `/${escapeToken(t)}`).join("");

const isVersion = (path: readonly string[]): boolean =>
  path.length === 2 && path[0] === "package" && path[1] === "version";

const isBinName = (path: readonly string[]): boolean => path.length === 1 && path[0] === "binName";

// Keys the design names but this release does not consume; they are refused, not ignored.
const isUnsupportedKey = (path: readonly string[]): boolean =>
  path.length === 1 && path[0] === "assertPatterns";

const ruleOf = ({ kind, path }: Finding): Rule => {
  if (kind === "unknown") {
    return isUnsupportedKey(path) ? "unsupported-key" : "unknown-key";
  }

  if (isBinName(path)) {
    return kind === "missing" ? "missing-bin-name" : "invalid-bin-name";
  }

  if (isVersion(path) && kind === "invalid") {
    return "invalid-version";
  }

  return kind === "missing" ? "missing-key" : "invalid-value";
};

const messages: Readonly<Record<Rule, string>> = {
  "invalid-bin-name": "binName must match ^[a-z][a-z0-9-]*$.",
  "invalid-value": "An author config value is not valid.",
  "invalid-version": "package.version must be a semver 2.0.0 version such as 1.2.3.",
  "missing-bin-name": "The author config has no binName.",
  "missing-key": "A required author config key is missing.",
  "unknown-key": "The author config has a key this generator does not define.",
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
    pointer: pointerOf(finding.path),
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
