import { Effect } from "effect";
import { resolveName } from "./commands.js";
import { formatApplication } from "./format.js";
import type { ApiModel, GenerateOptions } from "./model.js";
import { parameterComponents, requestBodyComponents } from "./emit-components.js";
import { multipartComponents } from "./emit-multipart-components.js";
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
    const parameters = parameterComponents(model, models.reference);
    const bodies = requestBodyComponents(model, models.reference, models.name);
    const multipart = multipartComponents(model, models.reference);
    const source = commandSource(model, name, models.reference, parameters, bodies, multipart);

    return yield* formatApplication({
      files: [
        { content: source.main, path: "src/main.ts" },
        { content: source.commands, path: "src/commands.ts" },
        ...(source.auth === undefined
          ? []
          : [{ content: source.auth, path: "src/components/security-schemes.ts" }]),
        ...(models.source === undefined
          ? []
          : [{ content: models.source, path: "src/components/schemas.ts" }]),
        ...(parameters.source === undefined
          ? []
          : [{ content: parameters.source, path: "src/components/parameters.ts" }]),
        ...(bodies.source === undefined
          ? []
          : [{ content: bodies.source, path: "src/components/request-bodies.ts" }]),
        ...(multipart.source === undefined
          ? []
          : [{ content: multipart.source, path: "src/components/multipart.ts" }]),
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
