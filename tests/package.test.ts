import { afterAll, beforeAll, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import generatorPackage from "../package.json" with { type: "json" };

const root = nodePath.resolve(import.meta.dir, "..");

const golden = nodePath.join(root, "tests/fixtures/golden/users-update");

// Consumer and tarball live under the checkout's git-ignored `work/`, never the system temp.
const work = nodePath.join(root, "work");

nodeFs.mkdirSync(work, { recursive: true });

const consumer = nodeFs.mkdtempSync(nodePath.join(work, "package-test-"));

const tarballName = `${generatorPackage.name}-${generatorPackage.version}.tgz`;

const bin = nodePath.join(consumer, "node_modules/.bin", generatorPackage.name);

const installed = nodePath.join(consumer, "node_modules", generatorPackage.name);

interface Ran {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const run = async (command: readonly string[], cwd: string): Promise<Ran> => {
  const child = Bun.spawn([...command], { cwd, stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, stderr, stdout };
};

const succeeds = async (command: readonly string[], cwd: string): Promise<Ran> => {
  const ran = await run(command, cwd);

  expect(ran, command.join(" ")).toMatchObject({ exitCode: 0 });

  return ran;
};

beforeAll(async () => {
  await succeeds(["bun", "run", "build"], root);
  await succeeds(["bun", "pm", "pack", "--destination", consumer], root);
  // The generator's own pinned dependencies are listed beside the tarball so the install resolves
  // from Bun's cache; `--prefer-offline` fetches only package manifests that are not cached.
  nodeFs.writeFileSync(
    nodePath.join(consumer, "package.json"),
    JSON.stringify({
      dependencies: {
        ...generatorPackage.dependencies,
        [generatorPackage.name]: `file:./${tarballName}`,
      },
      private: true,
      type: "module",
    }),
  );
  await succeeds(["bun", "install", "--prefer-offline"], consumer);
}, 120_000);

afterAll(() => {
  nodeFs.rmSync(consumer, { force: true, recursive: true });
});

test("the installed symlinked bin reports its version", async () => {
  expect(nodeFs.lstatSync(bin).isSymbolicLink()).toBe(true);

  const ran = await succeeds([bin, "--version"], consumer);

  expect(ran.stdout).toContain(generatorPackage.version);
});

test("the installed generator validates the golden spec", async () => {
  const ran = await run([bin, "validate", nodePath.join(golden, "openapi.json")], consumer);

  expect(ran).toMatchObject({ exitCode: 0 });
});

test("the installed generator generates the golden package from its own files", async () => {
  const out = nodePath.join(consumer, "generated");
  const ran = await run(
    [
      bin,
      "generate",
      nodePath.join(golden, "openapi.json"),
      "--config",
      nodePath.join(golden, "author-config.json"),
      "--out",
      out,
    ],
    consumer,
  );

  expect(ran).toMatchObject({ exitCode: 0 });
  expect(nodeFs.existsSync(nodePath.join(out, "package.json"))).toBe(true);
});

test("importing the library entry runs nothing", async () => {
  const ran = await run(
    [
      "bun",
      "-e",
      `const entry = await import(${JSON.stringify(generatorPackage.name)}); console.error(typeof entry.generate)`,
    ],
    consumer,
  );

  expect(ran).toEqual({ exitCode: 0, stderr: "function\n", stdout: "" });
});

test("the tarball ships no tests or planning files", () => {
  const entries = nodeFs.readdirSync(installed);

  expect(entries).not.toContain("tests");
  expect(entries).not.toContain(".vivi");
  expect(entries).not.toContain("src");
});
