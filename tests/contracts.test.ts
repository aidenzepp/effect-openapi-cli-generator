import { expect, test } from "bun:test";
import { Effect } from "effect";

import { GenerationError } from "../src/core/errors.js";

test.each(["invalid_input", "unsupported", "invalid_options", "format"] as const)(
  "preserves %s diagnostics through the Effect failure channel",
  async (code) => {
    const diagnostic = {
      code,
      hint: "Use an explicit supported type",
      location: "/paths/~1reports/post/requestBody",
      message: "The request schema is not supported",
    };
    const error = new GenerationError(diagnostic);
    const failure = await Effect.runPromise(Effect.flip(Effect.fail(error)));

    expect(failure._tag).toBe("GenerationError");
    expect(failure.code).toBe(diagnostic.code);
    expect(failure.location).toBe(diagnostic.location);
    expect(failure.message).toBe(diagnostic.message);
    expect(failure.hint).toBe(diagnostic.hint);
  },
);

test("retains an empty hint when no alternative exists", () => {
  const error = new GenerationError({
    code: "invalid_input",
    hint: "",
    location: "",
    message: "Expected an OpenAPI object",
  });

  expect(error.location).toBe("");
  expect(error.hint).toBe("");
});

test.each([undefined, () => 1])(
  "public generator rejects non-JSON input %# through its typed failure channel",
  async (input) => {
    const { generate } = await import("../src/index.js");
    const error = await Effect.runPromise(Effect.flip(generate(input)));
    expect(error._tag).toBe("GenerationError");
    expect(error.code).toBe("invalid_input");
    expect(error.location).toBe("");
  },
);
