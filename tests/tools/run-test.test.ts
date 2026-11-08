import { describe, expect, test } from "bun:test";

const runTest = new URL("../../tools/run-test.sh", import.meta.url).pathname;

describe("tools/run-test.sh", () => {
  test("fails naming a listed test file that does not exist, before running anything", () => {
    const result = Bun.spawnSync([
      runTest,
      "tests/does-not-exist.test.ts",
      "tests/tools/run-test.test.ts",
    ]);
    const stderr = result.stderr.toString();

    expect(result.exitCode).not.toBe(0);
    expect(stderr).toContain("tests/does-not-exist.test.ts");
    expect(result.stdout.toString()).not.toContain("Ran ");
  });
});
