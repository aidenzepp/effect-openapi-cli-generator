import { defineConfig } from "vite-plus";
import core from "ultracite/oxlint/core";
import antiSlop from "ultracite/oxlint/anti-slop";

/**
 * Matches module declarations and calls without spacing local call groups.
 */
const topLevelUnit = {
  selector:
    'Program > :matches(ExportNamedDeclaration, ExportDefaultDeclaration, FunctionDeclaration, ClassDeclaration, TSTypeAliasDeclaration, TSInterfaceDeclaration, TSEnumDeclaration, TSModuleDeclaration, VariableDeclaration, ExpressionStatement[expression.type="CallExpression"])',
};

/**
 * Matches direct and yielded Effect logs, including piped log annotations.
 */
const effectLogStatement = {
  selector:
    'ExpressionStatement:matches([expression.type="CallExpression"], [expression.type="YieldExpression"]):has(CallExpression[callee.type="MemberExpression"][callee.object.name="Effect"][callee.property.name=/^log(Trace|Debug|Info|Warning|Error|Fatal)?$/])',
};

export default defineConfig({
  fmt: {
    ignorePatterns: ["bun.lock"],
    jsdoc: { commentLineStrategy: "multiline", lineWrappingStyle: "balance" },
  },
  lint: {
    extends: [core, antiSlop],
    ignorePatterns: ["dist/**"],
    jsPlugins: ["./tools/lint-plugin.mjs", "@stylistic/eslint-plugin"],
    rules: {
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", next: topLevelUnit, prev: "*" },
        { blankLine: "always", next: "*", prev: topLevelUnit },
        {
          blankLine: "always",
          next: "const",
          // Effect generator calls are wrapped in yield expressions.
          prev: {
            selector:
              'ExpressionStatement:matches([expression.type="CallExpression"], [expression.type="YieldExpression"][expression.argument.type="CallExpression"])',
          },
        },
        { blankLine: "always", next: "return", prev: "*" },
        { blankLine: "always", next: "*", prev: "if" },
        { blankLine: "always", next: "*", prev: effectLogStatement },
      ],
      // Effect schemas and typed errors may share a module.
      "max-classes-per-file": "off",
      "typescript/promise-function-async": "off",
      "workspace/no-built-in-try-catch": "error",
    },
  },
});
