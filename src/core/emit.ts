import { Effect } from "effect";
import { resolveName } from "./commands.js";
import { formatApplication } from "./format.js";
import type { ApiModel, GenerateOptions } from "./model.js";
import { runtimeSource } from "./runtime-source.generated.js";
import { commandSource } from "./emit-command.js";

/**
 * Assembles a standalone package without filesystem or network services.
 *
 * @param model The validated operations and original wire contracts.
 * @param options Optional executable naming override.
 * @returns Deterministic formatted files, or a typed generation failure.
 */
export const emit = (model: ApiModel, options?: GenerateOptions) =>
  Effect.gen(function* assembleApplication() {
    const name = yield* resolveName(model.title, options);
    const source = commandSource(model, name);

    return yield* formatApplication({
      files: [
        { content: source, path: "src/main.ts" },
        { content: runtimeSource, path: "src/runtime.ts" },
        {
          content: JSON.stringify({
            bin: { [name]: "./dist/main.js" },
            dependencies: { "@effect/platform-node": "4.0.3", effect: "4.0.3" },
            devDependencies: { "@types/node": "26.6.4", typescript: "7.0.2" },
            name,
            private: true,
            scripts: { build: "tsc -p tsconfig.json", start: "node dist/main.js" },
            type: "module",
            version: "0.0.0",
          }),
          path: "package.json",
        },
        {
          content: JSON.stringify({
            compilerOptions: {
              declaration: false,
              module: "NodeNext",
              moduleResolution: "NodeNext",
              outDir: "dist",
              rootDir: "src",
              strict: true,
              target: "ES2022",
              types: ["node"],
            },
            include: ["src/**/*.ts"],
          }),
          path: "tsconfig.json",
        },
        { content: "node_modules/\ndist/\n", path: ".gitignore" },
      ],
    });
  });
