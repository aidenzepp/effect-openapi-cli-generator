import { Array, Order } from "effect";
import type { ApiModel, GeneratedFile } from "./model.js";
import { runtimeSources } from "./runtime-source.generated.js";

/**
 * Select checked template units by the transitive runtime capabilities actually used.
 */
export const builtinSources = (model: ApiModel): readonly GeneratedFile[] => {
  const basic = model.operations.some((operation) => operation.security?.kind === "basic");
  const apiKey = model.operations.some((operation) => operation.security?.kind === "apiKey");
  const locations = new Set(
    model.operations.flatMap((operation) =>
      operation.security?.kind === "apiKey" ? [operation.security.location] : [],
    ),
  );
  const cookie = locations.has("cookie");
  const body = model.operations.some(
    (operation) => operation.body !== undefined && !operation.body.multipart,
  );
  const imports =
    '/* oxlint-disable unicorn/throw-new-error -- Schema.TaggedError is a schema class factory. */\nimport { Match, Schema } from "effect";\nimport { CliError } from "effect/cli";\nimport type { HttpClientError } from "effect/http";\n';
  let errors = `${imports}\n/** The transport failure subset active in this CLI. */\ntype TransportFailure = ${basic || apiKey ? "AuthenticationError | " : ""}PathError | HttpClientError.HttpClientError | CliError.UserError;\n\n${runtimeSources.errors}`;
  const files: GeneratedFile[] = [];
  if (basic || apiKey) {
    const reasons = [
      "CredentialUnavailable",
      ...(basic ? ["InvalidBasicCredential", "BasicEncodingError"] : []),
      ...(cookie ? ["CookieConfigurationError", "CookieEncodingError"] : []),
      ...(locations.has("header") || locations.has("query") ? ["ApiKeyPreparationError"] : []),
    ];
    const units: Readonly<Record<string, string>> = runtimeSources;
    const declarations = reasons
      .map(
        (name) =>
          units[
            `error-${name.replaceAll(/(?<lower>[a-z])(?<upper>[A-Z])/gu, "$<lower>-$<upper>").toLowerCase()}`
          ],
      )
      .join("\n");
    const wrapper = `/** Supported local authentication failures with owned safe messages. */
const AuthenticationErrorReason = Schema.Union([${reasons.join(", ")}]);

/** Authentication preparation failed without retaining credentials or raw causes. */
export class AuthenticationError extends Schema.TaggedError<AuthenticationError>()("AuthenticationError", { reason: AuthenticationErrorReason }) {
  /** Preserve the reason's safe message at the command boundary. */
  override get message(): string { return this.reason.message; }
}
`;
    errors = errors
      .replace("/* template:authentication-declarations */", `${declarations}\n${wrapper}`)
      .replace(
        "/* template:authentication-case */",
        "AuthenticationError: (error) => new CliError.UserError({ cause: error, userMessage: error.message }),",
      );
    const effectNames = [
      "Effect",

      "Redacted",
      ...(cookie ? ["Result"] : []),
      ...(basic ? ["Schema"] : []),
    ];
    const auth = `import { ${effectNames.join(", ")} } from "effect";\nimport { ${cookie ? "Cookies, " : ""}HttpClientRequest } from "effect/http";\nimport * as Errors from "./errors.js";\n\n${basic ? runtimeSources.basic : ""}\n${Array.sort(
      [...locations],
      Order.String,
    )
      .map((location) => runtimeSources[`api-key-${location}`])
      .join("\n")}`;
    files.push({ content: auth, path: "src/builtins/auth.ts" });
  }

  errors = errors.replaceAll(/\/\* template:authentication-(?:declarations|types|case) \*\//gu, "");
  files.push(
    { content: errors, path: "src/builtins/errors.ts" },
    { content: runtimeSources.http, path: "src/builtins/http.ts" },
    { content: runtimeSources.url, path: "src/builtins/url.ts" },
  );
  if (body) {
    files.push({ content: runtimeSources.body, path: "src/builtins/body.ts" });
  }

  if (
    model.operations.some((operation) =>
      operation.parameters.some((parameter) => parameter.schema.kind === "array"),
    )
  ) {
    files.push({ content: runtimeSources.query, path: "src/builtins/query.ts" });
  }

  if (model.operations.some((operation) => operation.body?.multipart)) {
    const fields = model.operations.flatMap((operation) => operation.body?.multipart?.fields ?? []);
    const single = fields.some((field) => field.kind === "file" || field.kind === "files");
    const repeated = fields.some((field) => field.kind === "files");
    const content = `import { Effect, Option${single ? ", FileSystem, Path" : ""} } from "effect";
import { CliError } from "effect/cli";
import { HttpClientRequest } from "effect/http";
import type { HttpBody } from "effect/http";

${single ? runtimeSources["multipart-file"] : ""}
${repeated ? runtimeSources["multipart-files"] : ""}
${runtimeSources.multipart}`;
    files.push({ content, path: "src/builtins/multipart.ts" });
  }

  return files;
};
