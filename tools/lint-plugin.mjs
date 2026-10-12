import noBuiltInTryCatch from "./no-built-in-try-catch.mjs";

/**
 * Enforces explicit Effect error boundaries.
 */
export default {
  meta: { name: "workspace" },
  rules: {
    "no-built-in-try-catch": noBuiltInTryCatch,
  },
};
