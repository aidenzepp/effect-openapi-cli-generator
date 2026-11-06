/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import { Effect, Layer, Redacted, Sink, Stdio } from "effect";
import { ApiResponseError } from "../../src/runtime-src/domain/errors.ts";
import type { Credential } from "../../src/runtime-src/runtime/auth.ts";
import { finalCatch, runCredentialsLayer } from "../../src/runtime-src/runtime/output.ts";

const bearer: Credential = {
  definition: { kind: "http", scheme: "bearer" },
  scheme: "bearer",
  value: Redacted.make("test-secret-value"),
};

const fail = (fields: Partial<ConstructorParameters<typeof ApiResponseError>[0]> = {}) =>
  new ApiResponseError({
    bodyExcerpt: "",
    matched: "404",
    operation: "users.get",
    status: 404,
    ...fields,
  });

/**
 * Runs the error through the real final-catch path and returns what reached stderr.
 */
const stderrOf = async (error: ApiResponseError): Promise<string> => {
  const chunks: Buffer[] = [];
  const layer = Stdio.layerTest({
    stderr: () =>
      Sink.forEach((chunk: string | Uint8Array) =>
        Effect.sync(() => {
          chunks.push(Buffer.from(chunk));
        }),
      ),
  });

  await Effect.runPromise(
    Effect.exit(finalCatch([bearer])(Effect.fail(error))).pipe(
      Effect.provide(Layer.merge(layer, runCredentialsLayer)),
    ),
  );

  return Buffer.concat(chunks).toString("utf-8");
};

const statusLine = "Error: users.get returned 404 (matched 404)";

describe("text error output prints the Request ID line (design 7.4)", () => {
  test("the line sits between the Error line and the body excerpt", async () => {
    const text = await stderrOf(fail({ bodyExcerpt: "no such user", requestId: "req_123" }));

    expect(text.trimEnd().split("\n")).toEqual([statusLine, "Request ID: req_123", "no such user"]);
  });

  test("without a request id the output equals the M1 bytes", async () => {
    const text = await stderrOf(fail({ bodyExcerpt: "no such user" }));

    expect(text).not.toContain("Request ID");
    expect(text.trimEnd().split("\n")).toEqual([statusLine, "no such user"]);
  });

  test("an empty excerpt (--max-error-bytes 0) keeps the Request ID line", async () => {
    const text = await stderrOf(fail({ bodyExcerpt: "", requestId: "req_123" }));

    expect(text.trimEnd().split("\n")).toEqual([statusLine, "Request ID: req_123"]);
  });
});
