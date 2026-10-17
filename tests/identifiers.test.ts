import { expect, test } from "bun:test";
import { identifierAllocator } from "../src/core/identifiers.js";

test("source identifiers retain acronyms, separators, numeric prefixes and collision order", () => {
  const allocate = identifierAllocator();
  expect(allocate("HTTPResponse", "Command")).toBe("hTTPResponseCommand");
  expect(allocate("HTTP response", "Command", true)).toBe("HTTPResponseCommand");
  expect(allocate("HTTP-response", "Command", true)).toBe("HTTPResponseCommand2");
  expect(allocate("123 get_URL", "Command")).toBe("api123GetURLCommand");
  expect(allocate("___")).toBe("api");
  expect(allocate("")).toBe("api2");
  expect(allocate("Schema", "", true)).toBe("Schema2");
});
