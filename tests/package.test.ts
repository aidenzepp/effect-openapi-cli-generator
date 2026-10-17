import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let consumerDirectory = "";

afterAll(async () => {
  if (consumerDirectory !== "") {
    await rm(consumerDirectory, { force: true, recursive: true });
  }
});

test("local tarball exposes typed library and executable with its formatter dependency", async () => {
  const root = process.cwd();
  const temporary = await mkdtemp(path.join(tmpdir(), "effect-cli-package-"));
  consumerDirectory = temporary;
  const run = async (command: string[], cwd = temporary, restricted = false) => {
    const child = Bun.spawn(command, {
      cwd,
      env: restricted ? { ...process.env, PATH: temporary } : process.env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr, stdout }, command.join(" ")).toMatchObject({ code: 0 });

    return stdout;
  };
  await run(["npm", "pack", "--pack-destination", temporary], root);
  const files = await readdir(temporary);
  const tarball = files.find((file) => file.endsWith(".tgz"));
  if (tarball === undefined) {
    throw new Error("npm pack produced no tarball");
  }

  await writeFile(
    path.join(temporary, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await run(["bun", "add", path.join(temporary, tarball)]);
  await run(["bun", "add", "--dev", "typescript@7.0.2", "@types/node@26.6.4"]);
  const packageRoot = path.join(temporary, "node_modules/effect-openapi-cli-generator");
  const manifest = await readFile(path.join(packageRoot, "package.json"), "utf-8");
  expect(manifest).toContain('"oxfmt": "0.70.0"');
  expect(await readFile(path.join(packageRoot, "dist/index.d.ts"), "utf-8")).toContain("generate");
  expect(await readFile(path.join(packageRoot, "dist/cli.js"), "utf-8")).toStartWith(
    "#!/usr/bin/env node",
  );

  const entries = await readdir(packageRoot);
  expect(entries).not.toContain("tests");
  expect(entries).not.toContain(".vivi");
  await writeFile(
    path.join(temporary, "consumer.mjs"),
    `import { generate } from "effect-openapi-cli-generator";
import { Effect } from "effect";
const output = await Effect.runPromise(generate({openapi:"3.1.0",info:{title:"Packed API",version:"bad"},paths:{"/items":{get:{operationId:"items-get","x-fern-sdk-group-name":"items",responses:{"200":{description:"OK"}}}}}}));
if(!output.files.some(file => file.path === "src/commands.ts")) throw new Error("missing generated modules");
`,
  );
  const node = Bun.which("node");
  if (node === null) {
    throw new Error("Node is required for the packaged consumer check.");
  }

  await run([node, "consumer.mjs"], temporary, true);
  await writeFile(
    path.join(temporary, "input.json"),
    JSON.stringify({
      info: { title: "Packed API", version: "1" },
      openapi: "3.1.0",
      paths: {
        "/items": {
          get: {
            operationId: "items-list",
            responses: { "200": { description: "OK" } },
            "x-fern-sdk-group-name": "items",
          },
        },
      },
    }),
  );
  await run(
    [
      node,
      path.join(packageRoot, "dist/cli.js"),
      "--input",
      path.join(temporary, "input.json"),
      "--output",
      path.join(temporary, "generated"),
    ],
    temporary,
    true,
  );
  expect(await readFile(path.join(temporary, "generated/src/commands.ts"), "utf-8")).toContain(
    "HttpClientRequest.get",
  );
  expect(entries).not.toContain("src");
  await writeFile(
    path.join(temporary, "consumer.ts"),
    'import { generate } from "effect-openapi-cli-generator";\nimport { Effect } from "effect";\nconst operation = generate({});\nexport const result = Effect.runPromise(operation);\n',
  );
  await run([
    "bunx",
    "tsc",
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--module",
    "NodeNext",
    "--target",
    "ES2022",
    "consumer.ts",
  ]);
  expect(
    await run([path.join(temporary, "node_modules/.bin/effect-openapi-cli-generator"), "--help"]),
  ).toContain("--input");
  await rm(temporary, { force: true, recursive: true });
}, 120_000);
