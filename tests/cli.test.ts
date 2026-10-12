import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, lstat, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

test("Node symlink entry runs help and generation while imports stay inert", async () => {
  const root = await mkdtemp(join(tmpdir(), "generator-bin-"));
  try {
    const build = await Bun.build({
      entrypoints: ["src/cli.ts"],
      outdir: root,
      naming: "cli.mjs",
      target: "node",
      packages: "external",
    });
    expect(build.success).toBe(true);
    await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
    const entry = join(root, "generator");
    await symlink(join(root, "cli.mjs"), entry);
    const runNode = async (args: string[]) => {
      const child = Bun.spawn(["node", ...args], { stdout: "pipe", stderr: "pipe" });
      return {
        code: await child.exited,
        out: await new Response(child.stdout).text(),
        err: await new Response(child.stderr).text(),
      };
    };
    const help = await runNode([entry, "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("--input");
    const input = join(root, "input.json");
    await writeFile(
      input,
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Symlink API", version: "1" },
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
    const generated = await runNode([entry, "--input", input, "--output", join(root, "out")]);
    expect(generated.err).toBe("");
    expect(generated.code).toBe(0);
    expect(JSON.parse(await readFile(join(root, "out/package.json"), "utf8")).name).toBe(
      "symlink-api",
    );
    const imported = await runNode([
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(join(root, "cli.mjs")).href)}); console.log("imported");`,
    ]);
    expect(imported.code).toBe(0);
    expect(imported.err).toBe("");
    expect(imported.out).toBe("imported\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
