import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const invoke = async (args: string[]) => {
  const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await child.exited,
    out: await new Response(child.stdout).text(),
    err: await new Response(child.stderr).text(),
  };
};
test("native help and required flags", async () => {
  expect((await invoke(["--help"])).code).toBe(0);
  expect((await invoke(["--input", "missing"])).code).not.toBe(0);
});
test("malformed input yields one useful diagnostic and no output", async () => {
  const root = await mkdtemp(join(tmpdir(), "generator-"));
  try {
    for (const input of ["{", "{}"]) {
      await writeFile(join(root, "input.json"), input);
      const result = await invoke([
        "--input",
        join(root, "input.json"),
        "--output",
        join(root, "out"),
      ]);
      expect(result.code).not.toBe(0);
      expect(result.err.trim().split("\n")).toHaveLength(1);
      expect(await lstat(join(root, "out")).catch(() => undefined)).toBeUndefined();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("optional name defaults from title", async () => {
  const root = await mkdtemp(join(tmpdir(), "generator-"));
  try {
    await writeFile(
      join(root, "input.json"),
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Tiny API", version: "1" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              "x-fern-sdk-group-name": "pets",
              "x-fern-sdk-method-name": "list",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      }),
    );
    const result = await invoke([
      "--input",
      join(root, "input.json"),
      "--output",
      join(root, "out"),
    ]);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(join(root, "out/package.json"), "utf8")).name).toBe(
      "tiny-api",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
