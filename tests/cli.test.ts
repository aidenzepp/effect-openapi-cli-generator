import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, lstat, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Schema } from "effect";
import { pathToFileURL } from "node:url";

const runNode = async (args: string[]) => {
  const child = Bun.spawn(["node", ...args], { stderr: "pipe", stdout: "pipe" });
  return {
    code: await child.exited,
    err: await new Response(child.stderr).text(),
    out: await new Response(child.stdout).text(),
  };
};

const invoke = async (args: string[]) => {
  const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    code: await child.exited,
    err: await new Response(child.stderr).text(),
    out: await new Response(child.stdout).text(),
  };
};
test("native help and required flags", async () => {
  const help = await invoke(["--help"]);
  const missing = await invoke(["--input", "missing"]);
  expect(help.code).toBe(0);
  expect(missing.code).not.toBe(0);
});
test("malformed input yields one useful diagnostic and no output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "generator-"));
  try {
    await Effect.runPromise(
      Effect.forEach(
        ["{", "{}"],
        (input) =>
          Effect.promise(async () => {
            await writeFile(path.join(root, "input.json"), input);
            const result = await invoke([
              "--input",
              path.join(root, "input.json"),
              "--output",
              path.join(root, "out"),
            ]);
            expect(result.code).not.toBe(0);
            expect(result.err.trim().split("\n")).toHaveLength(1);
            expect(await lstat(path.join(root, "out")).catch(() => {})).toBeUndefined();
          }),
        { concurrency: 1, discard: true },
      ),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
test("optional name defaults from title", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "generator-"));
  try {
    await writeFile(
      path.join(root, "input.json"),
      JSON.stringify({
        info: { title: "Tiny API", version: "1" },
        openapi: "3.1.0",
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              responses: { "200": { description: "OK" } },
              "x-fern-sdk-group-name": "pets",
              "x-fern-sdk-method-name": "list",
            },
          },
        },
      }),
    );
    const result = await invoke([
      "--input",
      path.join(root, "input.json"),
      "--output",
      path.join(root, "out"),
    ]);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ name: Schema.String })))(
        await readFile(path.join(root, "out/package.json"), "utf-8"),
      ).name,
    ).toBe("tiny-api");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Node symlink entry runs help and generation while imports stay inert", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "generator-bin-"));
  try {
    const build = await Bun.build({
      entrypoints: ["src/cli.ts"],
      naming: "cli.mjs",
      outdir: root,
      packages: "external",
      target: "node",
    });
    expect(build.success).toBe(true);
    await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    const entry = path.join(root, "generator");
    await symlink(path.join(root, "cli.mjs"), entry);
    const help = await runNode([entry, "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("--input");
    const input = path.join(root, "input.json");
    await writeFile(
      input,
      JSON.stringify({
        info: { title: "Symlink API", version: "1" },
        openapi: "3.1.0",
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              responses: { "200": { description: "OK" } },
              "x-fern-sdk-group-name": "pets",
              "x-fern-sdk-method-name": "list",
            },
          },
        },
      }),
    );
    const generated = await runNode([entry, "--input", input, "--output", path.join(root, "out")]);
    expect(generated.err).toBe("");
    expect(generated.code).toBe(0);
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ name: Schema.String })))(
        await readFile(path.join(root, "out/package.json"), "utf-8"),
      ).name,
    ).toBe("symlink-api");
    const imported = await runNode([
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(path.join(root, "cli.mjs")).href)}); console.log("imported");`,
    ]);
    expect(imported.code).toBe(0);
    expect(imported.err).toBe("");
    expect(imported.out).toBe("imported\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
