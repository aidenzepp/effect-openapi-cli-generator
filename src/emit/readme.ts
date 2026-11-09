import { Array as Arr, Order } from "effect";
import { AuthorConfig, runtimeSettings } from "../model/author-config.ts";
import type { Diagnostic } from "../model/diagnostic.ts";
import type { Api } from "../model/entities.ts";
import type { NamePlan } from "../names/index.ts";
import { envPrefixOf } from "../names/plan.ts";
import type { PlannedCredential } from "../names/plan.ts";
import { reservedCliNames } from "../names/reserved.ts";
import { stringLiteral } from "./escape.ts";
import type { EmittedFile } from "./package.ts";

/**
 * What the README is written from: the model (webhooks), the author config (bin name), the name
 * plan (credential names), and the diagnostics of every stage (check, normalize, names and emit),
 * which the caller collects. The refusal summary counts the refusals among them.
 */
export interface ReadmeInput {
  readonly api: Api;
  readonly config: AuthorConfig;
  readonly plan: NamePlan;
  readonly diagnostics: readonly Diagnostic[];
}

interface OperationKey {
  readonly method: string;
  readonly path: string;
}

const webhookPrefix = "/webhooks/";

const byKey = Order.combine(
  Order.mapInput(Order.String, (key: OperationKey) => key.path),
  Order.mapInput(Order.String, (key: OperationKey) => key.method),
);

const unescapeToken = (token: string): string => token.replaceAll("~1", "/").replaceAll("~0", "~");

const longestRun = (text: string): number =>
  Math.max(0, ...Array.from(text.matchAll(/`+/gu), (match) => match[0].length));

// Spec text reaches the README only as escaped string literals inside a `text` fence: no line
// starts with a backtick, so no line closes the fence, and no control or format character is raw.
// The fence is one backtick longer than the longest run inside, as the formatter prints it.
const fence = (lines: readonly string[]): string => {
  const body = lines.join("\n");
  const marks = "`".repeat(Math.max(3, longestRun(body) + 1));

  return `${marks}text\n${body}\n${marks}`;
};

const exitCodes: readonly (readonly [number, string])[] = [
  [0, "success, including `--help`, `--version`, `--describe` and `--dry-run`"],
  [1, "the API answered with an error status"],
  [2, "usage: an unknown command or flag, or a value the command refuses"],
  [3, "authentication: no configured credential fits, or the server answered 401 or 403"],
  [4, "transport: DNS, connect, TLS, timeout, or a refused redirect"],
  [5, "response or output handling failed"],
  [70, "internal defect"],
  [130, "interrupted"],
];

const reserved = Arr.sort([...reservedCliNames], Order.String)
  .map((name) => `\`${name}\``)
  .join(", ");

const usage = (bin: string): string =>
  [
    "## Usage",
    `\`\`\`sh\n${bin} --help\n${bin} <command> --help\n\`\`\``,
    "Every command's `--help` shows its flags, request body fields, credentials and responses.",
    "Write a flag value that starts with `-` as `--flag=-value`: `--flag -value` is a usage error (exit 2), and help and version have no `-h` or `-v` short form.",
    `These names belong to the CLI, so no command or flag of the description may claim them: ${reserved}. Each credential's \`<scheme>-file\` flag is reserved as well.`,
  ].join("\n\n");

const credentialLine = (credential: PlannedCredential): string =>
  `- \`${credential.env}\` or \`--${credential.flag} <path|->\``;

// The `oauth2` and `openIdConnect` schemes: the operator supplies the token (design 6.5, D-SEC1).
const passThrough = (input: ReadmeInput): string | undefined => {
  const tokenSchemes = new Set(
    input.api.securitySchemes
      .filter((scheme) => scheme.kind.type === "oauth2Token" || scheme.kind.type === "oidcToken")
      .map((scheme) => scheme.name),
  );
  const lines = input.plan.credentials
    .filter((credential) => tokenSchemes.has(credential.scheme))
    .map(credentialLine);

  return lines.length === 0
    ? undefined
    : [
        "### OAuth2 and OpenID Connect",
        "This CLI does not obtain tokens: it runs no OAuth2 flow and no OpenID Connect discovery. Obtain an access token elsewhere and supply it through the scheme's credential source; it is sent as `Authorization: Bearer <token>`. Each command's `--help` shows the flows, URLs and scopes.",
        lines.join("\n"),
      ].join("\n\n");
};

// The `mutualTLS` schemes' certificate, key and CA paths: environment only, no file flag (6.5).
const certificates = (plan: NamePlan): string | undefined =>
  plan.certificates.length === 0
    ? undefined
    : [
        "### Client certificates",
        "Each `mutualTLS` scheme reads the paths of its client certificate, its private key and an optional CA bundle from these environment variables. No flag sets them.",
        plan.certificates
          .map(
            (certificate) =>
              `- \`${certificate.certEnv}\`, \`${certificate.keyEnv}\` and \`${certificate.caEnv}\``,
          )
          .join("\n"),
        "The certificate is presented only to the origins this package accepts. It is never presented on a cross-origin redirect, or to an origin `--base-url` or its environment variable names outside them, even with `--allow-credentials-for-base-url`: such a request is sent without it, and stderr says so.",
      ].join("\n\n");

const credentials = (input: ReadmeInput): string => {
  const { plan } = input;
  if (plan.credentials.length === 0 && plan.certificates.length === 0) {
    return "## Credentials\n\nThe API declares no credentials this CLI reads.";
  }

  const parts = ["## Credentials"];
  if (plan.credentials.length > 0) {
    parts.push(
      "Each credential is read from the first source that has it: the file its flag names (`-` reads stdin), then its environment variable, then, only when stdin and stdout are both terminals, a prompt that does not echo. No flag takes a credential value on the command line.",
      plan.credentials.map(credentialLine).join("\n"),
      "A credential is sent only to the origins this package accepts. An origin `--base-url` or its environment variable names outside them gets no credential unless `--allow-credentials-for-base-url` is given.",
    );
  }

  return [...parts, passThrough(input), certificates(plan)]
    .filter((part) => part !== undefined)
    .join("\n\n");
};

// The `format: password` body fields, read from a file or stdin (design 13.1 R4).
const secretFields = (plan: NamePlan): string | undefined => {
  const names = Arr.sort(
    Arr.dedupe(
      [...plan.root, ...plan.groups.flatMap((group) => group.commands)].flatMap((command) =>
        command.flags.flatMap((flag) =>
          flag.source._tag === "Body" && flag.source.kind === "secret-file" ? [flag.name] : [],
        ),
      ),
    ),
    Order.String,
  );

  return names.length === 0
    ? undefined
    : [
        "## Secret fields",
        "A body field the description marks `format: password` has no flag that takes its value. Its `--<field>-file` flag reads the value from a file, or from stdin with `-`, and the value is never echoed.",
        names.map((name) => `- \`--${name} <path|->\``).join("\n"),
      ].join("\n\n");
};

// Ruling X7 (a): the request path through the generated modules (design 4.1).
const howACommandRuns = (): string =>
  [
    "## How a command runs",
    "A command's flags are parsed by its module in `cli/<group>.ts`, which hands the input to the request builder in `api/<group>.ts`. The built request goes to `runtime/output.ts`, whose `Output.send` sends it through the client policy of `runtime/client.ts` (credentials, redirects, retries and timeouts) to the HTTP client `bin.ts` provides, then writes the response.",
  ].join("\n\n");

const seconds = (value: number): string => `${value} s`;

// Ruling X7 (b): one row per runtime setting, precedence flag > env > author default > built-in.
const settings = (config: AuthorConfig): string => {
  const prefix = envPrefixOf(config);
  // A config without `runtime` resolves to the built-in defaults, which live in `runtimeSettings`.
  const builtIn = runtimeSettings(
    new AuthorConfig({ binName: config.binName, package: config.package }),
  );
  const authored = (key: "idleTimeoutSeconds" | "retries" | "timeoutSeconds"): string => {
    const value = config.runtime?.[key];

    return value === undefined
      ? `\`runtime.${key}\`, not set`
      : `\`runtime.${key}\`: ${key === "retries" ? value : seconds(value)}`;
  };
  const rows = [
    ["`--base-url`", `\`${prefix}_BASE_URL\``, "`servers.accepted`", "none"],
    [
      "`--timeout`",
      `\`${prefix}_TIMEOUT\``,
      authored("timeoutSeconds"),
      `${builtIn.timeoutSeconds}`,
    ],
    ["`--retries`", `\`${prefix}_RETRIES\``, authored("retries"), `${builtIn.retries}`],
    [
      "none",
      `\`${prefix}_IDLE_TIMEOUT\``,
      authored("idleTimeoutSeconds"),
      `${builtIn.idleTimeoutSeconds}`,
    ],
    ["`--error-format`", `\`${prefix}_ERROR_FORMAT\``, "none", "`text`"],
  ];
  const header = ["Flag", "Environment", "Author default (config key)", "Built-in default"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  // Padded as `vp fmt` prints a table; every cell is ASCII, so length is display width.
  const table = [
    line(header),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map(line),
  ].join("\n");

  return [
    "## Settings",
    "Precedence: flag > environment variable > author default > built-in default. A setting takes the first value found in that order; the author default is the one this package was generated with. Timeouts are in seconds.",
    table,
    `Between \`${prefix}_BASE_URL\` and the accepted server, \`--server <name|index>\` chooses one of the description's servers. With no base URL from any of them, a command fails with exit code 2 and names \`--base-url\`.`,
    `An error raised while the command line is parsed comes before any flag is read, so only \`${prefix}_ERROR_FORMAT\` sets its format. Every later error follows \`--error-format\`, then \`${prefix}_ERROR_FORMAT\`.`,
  ].join("\n\n");
};

// Design D-AD7 and 7.4: the retry policy and the `Retry-After` cap.
const retries = (): string =>
  [
    "## Retries",
    "A request is retried when the connection, the DNS lookup or the wait for headers fails, or when the server answers 408, 429, 500, 502, 503 or 504. A TLS failure is not retried. Without `--retry-unsafe`, only `GET`, `HEAD`, `OPTIONS`, `TRACE`, `PUT`, `DELETE` and `QUERY` are retried, and other methods only when the request carries an `Idempotency-Key` header. A body read from stdin is never retried, because it cannot be sent twice.",
    "`--retries <n>` sets how many times a request is retried, and `--retries 0` turns retrying off. Waits grow exponentially with jitter, and each retry writes a note to stderr.",
    "A `Retry-After` header is honored up to the effective `--timeout`. When the server asks for a longer wait, the CLI does not wait: it stops retrying, and the error reports the server's value. `--timeout 0` removes this cap along with the timeout.",
  ].join("\n\n");

const timeouts = (config: AuthorConfig): string => {
  const prefix = envPrefixOf(config);

  return [
    "## Timeouts",
    `\`--timeout <seconds>\` (\`${prefix}_TIMEOUT\`) bounds each attempt's wait for the response headers; \`0\` waits forever. A timeout exits with code 4.`,
    `\`${prefix}_IDLE_TIMEOUT\` bounds the wait for each next chunk of a response body, streamed or not. A body that stalls longer exits with code 5. It has no flag.`,
    `\`${prefix}_RETRIES\` sets the retry count as \`--retries\` does. Settings lists the defaults, including those this package was generated with.`,
  ].join("\n\n");
};

// Design 4.6 output modes and 7.4 `--error-format json`.
const output = (): string =>
  [
    "## Output",
    "stdout carries only the response body, the request `--dry-run` prints, or the `--describe` JSON. Errors, notices, retry notes and `--verbose` lines go to stderr.",
    "A response body is written to stdout as it arrives, or to a file with `--output <path>`, which `--force` lets replace an existing file. A binary body is not written to a terminal unless `--output -` asks for it.",
    "A sequential response (Server-Sent Events, NDJSON, JSON Lines or JSON text sequences) is written one JSON value per line, each line as soon as its item arrives. Numbers keep their digits. `--raw` writes the bytes as received instead. `--max-record-bytes <n>` bounds one item; a larger item, or a stream that ends inside an item, exits with code 5.",
    "`--dry-run` prints the request to stdout with every credential replaced and sends nothing. `--verbose` prints each attempt's and each redirect hop's request and response lines and headers to stderr, redacted and without bodies.",
    '`--error-format json` writes each error to stderr as one JSON object, `{"error":{...}}`. The inner object always has `kind` and `message`, and has `operation`, `status`, `matched`, `body`, `retryAfter` and `requestId` only when they have a value. `retryAfter` is the server\'s `Retry-After` in seconds when retrying stopped at the `--timeout` cap.',
  ].join("\n\n");

const exits = (): string =>
  [
    "## Exit codes",
    exitCodes.map(([code, meaning]) => `- \`${code}\`: ${meaning}.`).join("\n"),
  ].join("\n\n");

const refusals = (input: ReadmeInput): string => {
  const refusedDiagnostics = input.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "refusal",
  );
  const refusedOperations = refusedDiagnostics.flatMap((diagnostic) =>
    diagnostic.scope === "operation" && diagnostic.operation !== undefined
      ? [{ method: diagnostic.operation.method, path: diagnostic.operation.path }]
      : [],
  );
  const operations = Arr.sort(
    Arr.dedupeWith(
      refusedOperations,
      (left, right) => left.method === right.method && left.path === right.path,
    ),
    byKey,
  );
  const isRefused = (method: string, path: string): boolean =>
    operations.some((key) => key.method === method && key.path === path);
  // The refusals at one scope that belong to no refused operation: a generated command's.
  const countOf = (scope: "element" | "field"): number =>
    refusedDiagnostics.filter(
      (diagnostic) =>
        diagnostic.scope === scope &&
        (diagnostic.operation === undefined ||
          !isRefused(diagnostic.operation.method, diagnostic.operation.path)),
    ).length;
  const elements = countOf("element");
  const fields = countOf("field");

  if (operations.length === 0 && elements === 0 && fields === 0) {
    return "## Refusals\n\nNothing in the description was refused.";
  }

  const parts = ["## Refusals"];
  if (operations.length > 0) {
    parts.push(
      `Generation refused ${operations.length} operation${operations.length === 1 ? "" : "s"}, which have no command:`,
      fence(operations.map((key) => `${key.method} ${stringLiteral(key.path)}`)),
    );
  }

  if (elements > 0) {
    parts.push(
      `Generation refused ${elements} element${elements === 1 ? "" : "s"} of generated commands; each command's \`--help\` names them.`,
    );
  }

  if (fields > 0) {
    parts.push(
      `Generation refused ${fields} body field${fields === 1 ? "" : "s"} of generated commands; each command's \`--help\` names them.`,
    );
  }

  return parts.join("\n\n");
};

const webhooks = (api: Api): string | undefined => {
  const names = api.informational.flatMap((element) => {
    const rest = element.origin.pointer.slice(webhookPrefix.length);

    return element.row === "DOC-08" &&
      element.origin.pointer.startsWith(webhookPrefix) &&
      !rest.includes("/")
      ? [unescapeToken(rest)]
      : [];
  });

  return names.length === 0
    ? undefined
    : [
        "## Webhooks",
        "The description lists these webhooks. They are informational: a webhook is a request the provider sends, so this CLI has no command for it.",
        fence(names.map((name) => stringLiteral(name))),
      ].join("\n\n");
};

/**
 * Emits the generated package's `README.md` (design 4.1, 4.2): usage with the `--flag=-value`
 * escape and the reserved CLI names (design 4.4), how a command runs and the runtime settings
 * table (ruling X7), the credential sources, environment variables and file flags from the name
 * plan with the `oauth2`/`openIdConnect` pass-through and the `mutualTLS` certificate names when
 * planned, the secret-file fields when any, the retry policy, timeouts and output modes (design
 * D-AD7, 4.6, 7.4), the exit codes (design 4.6), a refusal summary of every stage's refusals, and
 * the webhooks, listed as informational. The prefix comes from the config, defaults from
 * `runtimeSettings`. The bin, environment, flag and config names are ASCII by their grammars;
 * every spec string is an escaped literal in a `text` fence.
 */
export const emitReadme = (input: ReadmeInput): EmittedFile => {
  const bin = input.config.binName;
  const intro = `\`${bin}\` is a command-line client generated from an OpenAPI description. Its \`api/\` modules are request builders, not an Effect \`HttpApi\` definition.`;
  const sections = [
    `# ${bin}`,
    intro,
    usage(bin),
    howACommandRuns(),
    settings(input.config),
    credentials(input),
    secretFields(input.plan),
    retries(),
    timeouts(input.config),
    output(),
    exits(),
    refusals(input),
    webhooks(input.api),
  ].filter((part) => part !== undefined);

  return { content: `${sections.join("\n\n")}\n`, path: "README.md" };
};
