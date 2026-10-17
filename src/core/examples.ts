import { Array as EffectArray, Effect, Order, Result, Schema } from "effect";
import type { Operation, Parameter, SourceExample, WireSchema } from "./model.js";
import { resolveReference } from "./references.js";
import { exampleSchema } from "./example-schema.js";

/**
 * Resolve optional local examples without fetching external values or failing API generation.
 */
const namedExample = (
  document: Schema.Json,
  input: Schema.Json,
  active: ReadonlySet<string> = new Set(),
): Effect.Effect<SourceExample | null> =>
  Effect.gen(function* resolveExample() {
    if (!Schema.is(Schema.JsonObject)(input)) {
      return null;
    }

    if (Schema.is(Schema.String)(input.$ref)) {
      const result = yield* Effect.result(
        resolveReference(document, input.$ref, "/examples", active),
      );
      if (Result.isFailure(result)) {
        return null;
      }

      const example = yield* namedExample(
        document,
        result.success.value,
        result.success.activeRefs,
      );
      if (
        example !== null &&
        Schema.is(Schema.JsonObject)(document) &&
        Schema.is(Schema.String)(document.openapi) &&
        document.openapi.startsWith("3.1.") &&
        Schema.is(Schema.String)(input.description)
      ) {
        return { ...example, description: input.description };
      }

      return example;
    }

    if (input.value === undefined || Object.hasOwn(input, "externalValue")) {
      return null;
    }

    const example = { value: input.value };

    return Schema.is(Schema.String)(input.description)
      ? { ...example, description: input.description }
      : example;
  });

/**
 * Explicit examples retain falsy JSON values and deterministic named-example order.
 */
export const sourceExamples = (
  document: Schema.Json,
  source: Schema.JsonObject,
): Effect.Effect<readonly SourceExample[]> =>
  Effect.gen(function* readExamples() {
    const examples: SourceExample[] =
      source.example === undefined ? [] : [{ value: source.example }];
    if (Schema.is(Schema.JsonObject)(source.examples)) {
      for (const key of EffectArray.sort(Object.keys(source.examples), Order.String)) {
        const value = source.examples[key];
        if (value === undefined) {
          continue;
        }

        const example = yield* namedExample(document, value);
        if (example !== null) {
          examples.push(example);
        }
      }
    }

    return examples;
  });

/**
 * Validate whole candidates with native checks; no coercion, defaults or source evaluation.
 */
const candidates = (
  schema: WireSchema,
  explicit: readonly SourceExample[] = [],
): readonly SourceExample[] => {
  const validator = exampleSchema(schema);
  const valid = (example: SourceExample) =>
    Result.isSuccess(
      Schema.decodeUnknownResult(validator)(example.value, { onExcessProperty: "error" }),
    );
  for (const group of [explicit, schema.docs.examples ?? []]) {
    const accepted = group.filter(valid).slice(0, 3);
    if (accepted.length > 0) {
      return accepted;
    }
  }
  if (schema.kind !== "object") {
    return [];
  }

  const fields: [string, Schema.Json][] = [];
  for (const property of schema.properties) {
    const [example] = candidates(property.schema);
    if (example === undefined) {
      if (property.required) {
        return [];
      }
    } else {
      fields.push([property.name, example.value]);
    }
  }
  if (fields.length === 0) {
    return [];
  }

  const example = { value: Object.fromEntries(fields) };

  return valid(example) ? [example] : [];
};

/**
 * POSIX shell single quotes keep source values literal, including command substitutions.
 */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const parameterExample = (parameter: Parameter): SourceExample | undefined =>
  candidates(parameter.schema, parameter.examples).find(({ value }) => {
    if (Schema.is(Schema.String)(value) && /[\0\r\n]/u.test(value)) {
      return false;
    }

    if (parameter.location === "path" && (value === "." || value === "..")) {
      return false;
    }

    if (Array.isArray(value)) {
      return (
        value.length > 0 &&
        (parameter.explode === true || value.every((item) => !String(item).includes(",")))
      );
    }

    return true;
  });

/**
 * Select bounded, complete command examples; transport secrets stay explicit shell inputs.
 */
export const commandExamples = (
  operation: Operation,
  executable: string,
): readonly { readonly command: string; readonly description?: string }[] => {
  if (operation.body?.multipart) {
    return [];
  }

  const parts = [
    executable,
    ...operation.commandPath,
    `--base-url="\${API_BASE_URL:?Set API_BASE_URL}"`,
  ];
  if (operation.security !== undefined) {
    const { flagName, kind } = operation.security;
    if (kind === "basic") {
      parts.push(
        `--${flagName}-username="\${API_USERNAME:?Set API_USERNAME}"`,
        `--${flagName}-password="\${API_PASSWORD:?Set API_PASSWORD}"`,
      );
    } else {
      const variable = kind === "bearer" ? "API_TOKEN" : "API_KEY";
      parts.push(`--${flagName}="\${${variable}:?Set ${variable}}"`);
    }
  }

  let hasExample = false;
  let parameterDescription: string | undefined;
  for (const parameter of operation.parameters) {
    const example = parameterExample(parameter);
    if (example === undefined) {
      if (parameter.required) {
        return [];
      }

      continue;
    }

    hasExample = true;
    parameterDescription ??= example.description;
    const value = Schema.is(Schema.String)(example.value)
      ? example.value
      : JSON.stringify(example.value);
    parts.push(`--${parameter.flagName}=${shellQuote(value)}`);
  }
  if (operation.body !== undefined) {
    const bodies = candidates(operation.body.schema, operation.body.examples);
    if (bodies.length > 0) {
      return bodies.map((body) => {
        const example = {
          command: [...parts, `--body=${shellQuote(JSON.stringify(body.value))}`].join(" "),
        };

        const description = body.description ?? parameterDescription;

        return description === undefined ? example : { ...example, description };
      });
    }

    if (operation.body.required) {
      return [];
    }
  }

  const example = { command: parts.join(" ") };
  if (!hasExample) {
    return [];
  }

  return [
    parameterDescription === undefined
      ? example
      : { ...example, description: parameterDescription },
  ];
};
