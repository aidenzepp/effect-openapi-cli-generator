/**
 * Keeps recoverable failures at explicit Effect boundaries.
 */
export default {
  meta: { name: "project" },
  rules: {
    "no-built-in-try-catch": {
      /**
       * @param {{ report: (diagnostic: { node: object; messageId: string }) => void }} context Lint
       *   context.
       * @returns {{ TryStatement: (node: { handler?: object | null }) => void }} AST visitors.
       */
      create(context) {
        return {
          TryStatement(node) {
            if (node.handler === undefined || node.handler === null) {
              return;
            }

            context.report({ messageId: "effectBoundary", node });
          },
        };
      },
      meta: {
        messages: {
          effectBoundary:
            "Use Effect.try or Effect.tryPromise at the failing operation and handle its typed error.",
        },
        schema: [],
        type: "problem",
      },
    },
  },
};
