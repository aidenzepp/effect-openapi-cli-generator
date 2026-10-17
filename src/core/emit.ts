import { Effect } from "effect";
import { resolveName } from "./commands.js";
import { formatApplication } from "./format.js";
import type { ApiModel, GenerateOptions } from "./model.js";
import { modelSource } from "./emit-models.js";
import { builtinSources } from "./emit-builtins.js";
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
    const models = modelSource(model);
    const source = commandSource(model, name, models.reference, models.source !== undefined);

    return yield* formatApplication({
      files: [
        { content: source.main, path: "src/main.ts" },
        { content: source.commands, path: "src/commands.ts" },
        ...(source.auth === undefined ? [] : [{ content: source.auth, path: "src/auth.ts" }]),
        ...(models.source === undefined ? [] : [{ content: models.source, path: "src/models.ts" }]),
        ...builtinSources(model),
        {
          content: JSON.stringify({
            bin: { [name]: "./dist/main.js" },
            dependencies: {
              "@effect/platform-node": "4.0.3",
              "@effect/platform-node-shared": "4.0.3",
              effect: "4.0.3",
            },
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
