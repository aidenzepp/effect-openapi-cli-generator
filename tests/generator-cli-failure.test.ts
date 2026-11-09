import { describe, expect, test } from "bun:test";
import { PrinterError } from "../src/emit/printer.ts";
import { Effect, Result, Schema } from "effect";
import { RunLockHeld } from "../src/write/lock.ts";
import { WriteRefused } from "../src/write/index.ts";
import { failureLine } from "../src/main.ts";

describe("failureLine", () => {
  test("a tagged failure names its reason and its JSON-quoted subject", () => {
    expect(failureLine(new PrinterError({ reason: "duplicate-key", subject: "name" }))).toBe(
      'error: generation failed (PrinterError) reason duplicate-key subject "name"',
    );
  });

  test("a subject with a newline and a lone surrogate stays one escaped line", () => {
    const line = failureLine(new PrinterError({ reason: "duplicate-key", subject: "a\nb\uD800" }));

    expect(line.includes("\n")).toBe(false);
    expect(line.includes("\uD800")).toBe(false);
    expect(
      line.startsWith("error: generation failed (PrinterError) reason duplicate-key subject "),
    ).toBe(true);
  });

  test("an error with neither field prints the M1 line", () => {
    const failed = Effect.runSync(Effect.result(Schema.decodeUnknownEffect(Schema.String)(1)));

    expect(Result.isFailure(failed) ? failureLine(failed.failure) : undefined).toBe(
      "error: generation failed (SchemaError)",
    );
  });

  test("a held run lock prints the lock line", () => {
    expect(failureLine(new RunLockHeld({ lockPath: "x" }))).toBe(
      "error: another run holds the output directory's lock",
    );
  });

  test("a refused write prints its reason", () => {
    expect(failureLine(new WriteRefused({ reason: "io", subject: "out" }))).toBe(
      "error: the output was not written (io)",
    );
  });
});
