import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { VerdictCoverage } from "../../src/model/verdict.ts";

const site = { document: "file:///spec.json", pointer: "/paths/~1x/get" };

const claim = { path: ["users", "list"] };

// Each value spreads its site or claim last, so the encoded text shows the schema's key order.
const elements = [
  { kind: "operation", ...site },
  { in: "query", kind: "parameter", name: "id", ...site },
  { kind: "refusedField", mediaType: "application/json", name: "tag", ...site },
  { kind: "requestMedia", mediaType: "application/json", ...site },
  { key: "200", kind: "response", ...site },
  { kind: "securityAlternative", schemes: ["apiKey"], ...site },
  { kind: "server", url: "https://api.example.com", ...site },
];

const invented = [
  { kind: "command", ...claim },
  { kind: "refusedField", mediaType: "application/json", name: "tag", ...claim },
  { kind: "requestMedia", mediaType: "application/json", ...claim },
  { key: "200", kind: "response", ...claim },
  { kind: "securityAlternative", schemes: ["apiKey"], ...claim },
  { kind: "server", url: "https://api.example.com", ...claim },
];

const siteText = '"document":"file:///spec.json","pointer":"/paths/~1x/get"';

const claimText = '"path":["users","list"]';

const expected = [
  '{"byNotice":[',
  `{${siteText},"kind":"operation"},`,
  `{${siteText},"in":"query","kind":"parameter","name":"id"},`,
  `{${siteText},"kind":"refusedField","mediaType":"application/json","name":"tag"},`,
  `{${siteText},"kind":"requestMedia","mediaType":"application/json"},`,
  `{${siteText},"key":"200","kind":"response"},`,
  `{${siteText},"kind":"securityAlternative","schemes":["apiKey"]},`,
  `{${siteText},"kind":"server","url":"https://api.example.com"}`,
  '],"checked":true,"invented":[',
  `{${claimText},"kind":"command"},`,
  `{${claimText},"kind":"refusedField","mediaType":"application/json","name":"tag"},`,
  `{${claimText},"kind":"requestMedia","mediaType":"application/json"},`,
  `{${claimText},"key":"200","kind":"response"},`,
  `{${claimText},"kind":"securityAlternative","schemes":["apiKey"]},`,
  `{${claimText},"kind":"server","url":"https://api.example.com"}`,
  '],"missing":[]}',
].join("");

describe("VerdictCoverage", () => {
  test("verdict variants encode in key order", () => {
    const coverage = Schema.decodeUnknownSync(VerdictCoverage)({
      byNotice: elements,
      checked: true,
      invented,
      missing: [],
    });

    expect(JSON.stringify(Schema.encodeSync(VerdictCoverage)(coverage))).toBe(expected);
  });
});
