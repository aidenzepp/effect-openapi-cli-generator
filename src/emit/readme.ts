import { Array as Arr, Order } from "effect";
import type { AuthorConfig } from "../model/author-config.ts";
import type { Diagnostic } from "../model/diagnostic.ts";
import type { Api } from "../model/entities.ts";
import type { NamePlan } from "../names/index.ts";
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

const credentials = (plan: NamePlan): string => {
  if (plan.credentials.length === 0) {
    return "## Credentials\n\nThe API declares no credentials this CLI reads.";
  }

  const lines = plan.credentials.map(
    (credential) => `- \`${credential.env}\` or \`--${credential.flag} <path|->\``,
  );

  return [
    "## Credentials",
    "Each credential is read from its environment variable, or from a file named by its flag (`-` reads stdin).",
    lines.join("\n"),
  ].join("\n\n");
};

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
 * escape and the reserved CLI names (design 4.4), the credential environment variables and file
 * flags from the name plan, the exit codes (design 4.6), a refusal summary of every stage's
 * refusals, and the webhooks, listed as informational. The bin name and credential names are ASCII
 * by their grammars; every spec string is an escaped literal in a `text` fence.
 */
export const emitReadme = (input: ReadmeInput): EmittedFile => {
  const bin = input.config.binName;
  const intro = `\`${bin}\` is a command-line client generated from an OpenAPI description. Its \`api/\` modules are request builders, not an Effect \`HttpApi\` definition.`;
  const sections = [
    `# ${bin}`,
    intro,
    usage(bin),
    credentials(input.plan),
    exits(),
    refusals(input),
    webhooks(input.api),
  ].filter((part) => part !== undefined);

  return { content: `${sections.join("\n\n")}\n`, path: "README.md" };
};
