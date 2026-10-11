import { defineConfig } from "vite-plus";
import core from "ultracite/oxlint/core";
import antiSlop from "ultracite/oxlint/anti-slop";

export default defineConfig({
  fmt: {
    ignorePatterns: [".vivi/**", "bun.lock"],
    jsdoc: { commentLineStrategy: "multiline", lineWrappingStyle: "balance" },
  },
  lint: {
    extends: [core, antiSlop],
    ignorePatterns: ["dist/**", ".vivi/**"],
    jsPlugins: ["./lint-plugin.mjs"],
    rules: {
      // Effect schemas and typed errors may share a module.
      "max-classes-per-file": "off",
      "project/no-built-in-try-catch": "error",
      "typescript/promise-function-async": "off",
    },
  },
});
