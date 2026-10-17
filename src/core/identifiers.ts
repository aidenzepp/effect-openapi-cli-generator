/**
 * Allocate stable source names independently from command spelling and wire names.
 */
export const identifierAllocator = () => {
  const used = new Set([
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "let",
    "new",
    "null",
    "return",
    "static",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
    "implements",
    "interface",
    "package",
    "private",
    "protected",
    "public",
    "Auth",
    "BuiltinAuth",
    "Body",
    "Commands",
    "Errors",
    "Http",
    "Url",
    "Models",
    "Schema",
    "Effect",
    "Option",
    "Command",
    "Flag",
    "CliError",
    "HttpClientRequest",
    "NodeHttpClient",
    "NodeRuntime",
    "NodeServices",
    "rootCommand",
  ]);

  return (source: string, suffix = "", pascal = false): string => {
    const words = source.match(/[a-zA-Z0-9]+/gu) ?? ["api"];
    let name = words
      .map((word, index) =>
        index === 0 && !pascal
          ? `${word[0]?.toLowerCase()}${word.slice(1)}`
          : `${word[0]?.toUpperCase()}${word.slice(1)}`,
      )
      .join("");
    if (/^[0-9]/u.test(name)) {
      name = `api${name}`;
    }

    name += suffix;
    let candidate = name;
    let index = 2;
    while (used.has(candidate)) {
      candidate = `${name}${index}`;
      index += 1;
    }
    used.add(candidate);

    return candidate;
  };
};
