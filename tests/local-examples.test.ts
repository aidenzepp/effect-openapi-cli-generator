import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { Array, Effect, Order, Schema } from "effect";
import { generate } from "../src/index.js";

test.each(["demo", "integration"])(
  "%s example matches current generator output and builds",
  async (example) => {
    const root = `examples/${example}`;
    const input = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(
      await readFile(`${root}/openapi.json`, "utf-8"),
    );
    const application = await Effect.runPromise(generate(input));
    expect(await Effect.runPromise(generate(input))).toEqual(application);
    await Promise.all(
      application.files.map(async (file) => {
        expect(await readFile(`${root}/cli/${file.path}`, "utf-8"), file.path).toBe(file.content);
      }),
    );
    const entries = await readdir(`${root}/cli/src`, { recursive: true });
    expect(
      Array.sort(
        entries.filter((entry) => entry.endsWith(".ts")),
        Order.String,
      ),
    ).toEqual(
      Array.sort(
        application.files
          .filter((file) => file.path.startsWith("src/"))
          .map((file) => file.path.slice(4)),
        Order.String,
      ),
    );

    const build = Bun.spawnSync(["bun", "run", "build"], { cwd: `${root}/cli` });
    expect({ code: build.exitCode, error: build.stderr.toString() }).toMatchObject({ code: 0 });

    const help = Bun.spawnSync(["node", `${root}/cli/dist/main.js`, "--help"]);
    expect({ code: help.exitCode, error: help.stderr.toString() }).toMatchObject({ code: 0 });
    expect(help.stdout.toString()).toContain("--help");
  },
);
