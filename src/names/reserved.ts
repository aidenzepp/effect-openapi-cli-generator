const builtInNames: readonly string[] = ["completions", "h", "help", "log-level", "v", "version"];

const runtimeFlags: readonly string[] = [
  "accept",
  "allow-credentials-for-base-url",
  "base-url",
  "body",
  "body-file",
  "content-type",
  "describe",
  "dry-run",
  "error-format",
  "force",
  "max-error-bytes",
  "max-record-bytes",
  "output",
  "raw",
  "retries",
  "retry-unsafe",
  "server",
  "server-variable",
  "timeout",
  "verbose",
];

// Effect negates every boolean flag as `no-<name>` and throws on a duplicate, so each
// boolean's negation is reserved with it. Built-ins negate on their long names only.
const booleanNames: readonly string[] = [
  "allow-credentials-for-base-url",
  "describe",
  "dry-run",
  "force",
  "help",
  "raw",
  "retry-unsafe",
  "verbose",
  "version",
];

/**
 * Flag and command names a specification may not claim (design 4.4): Effect built-ins, the
 * runtime's flags (including those not yet emitted, so later milestones rename nothing) and
 * every `no-<boolean>` negation. `<scheme>-file` flags depend on the specification and are not
 * listed here.
 */
export const reservedCliNames: ReadonlySet<string> = new Set([
  ...builtInNames,
  ...runtimeFlags,
  ...booleanNames.map((name) => `no-${name}`),
]);

/**
 * The reserved environment names after `<PREFIX>_` (design 4.4). The per-scheme mutual TLS
 * names `<PREFIX>_<SCHEME>_CERT|KEY|CA` depend on the specification and are not listed here.
 */
export const reservedEnvSuffixes: readonly string[] = [
  "BASE_URL",
  "ERROR_FORMAT",
  "IDLE_TIMEOUT",
  "RETRIES",
  "TIMEOUT",
];

/**
 * Words that cannot be declarations: ECMAScript reserved and strict-mode reserved words, the
 * literals, and the names strict code may not bind.
 */
export const reservedIdentifiers: ReadonlySet<string> = new Set([
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "Infinity",
  "instanceof",
  "interface",
  "let",
  "NaN",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/**
 * Windows device names, upper case; a file segment is compared case-insensitively.
 */
export const windowsDeviceNames: ReadonlySet<string> = new Set([
  "AUX",
  "CON",
  "NUL",
  "PRN",
  ...Array.from({ length: 10 }, (_, digit) => `COM${digit}`),
  ...Array.from({ length: 10 }, (_, digit) => `LPT${digit}`),
]);
