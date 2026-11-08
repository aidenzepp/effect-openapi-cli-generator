import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { AuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";
import type { Json } from "../../src/model/pointer.ts";
import type { Line } from "../../src/validate/index.ts";

// SSC-10: an `oauth2` scheme's 3.2 `oauth2MetadataUrl` is recorded, sanitized, for help only; it
// is never fetched, and other lines record nothing.

const entry = Schema.decodeUnknownSync(DocumentUri)("file:///spec/openapi.json");

const configUri = Schema.decodeUnknownSync(DocumentUri)("file:///spec/author.json");

const config = Schema.decodeUnknownSync(AuthorConfig)({
  binName: "acme",
  package: { name: "acme-cli", version: "1.0.0" },
});

const openapi: Record<Line, string> = { "3.0": "3.0.3", "3.1": "3.1.1", "3.2": "3.2.0" };

const metadata = "https://auth.example/.well-known/oauth-authorization-server";

const oauth = (url: string): Json => ({
  flows: { clientCredentials: { scopes: {}, tokenUrl: "https://auth.example/token" } },
  oauth2MetadataUrl: url,
  type: "oauth2",
});

const kindOf = (line: Line, url: string) => {
  const { api } = Effect.runSync(
    resolve({
      document: entry,
      line,
      value: {
        components: { securitySchemes: { oauth: oauth(url) } },
        info: { title: "t", version: "1" },
        openapi: openapi[line],
        paths: {},
      },
    }).pipe(
      Effect.flatMap((resolution) =>
        normalize(resolution, { checkFindings: [], config, configDocument: configUri }),
      ),
    ),
  );

  return api.securitySchemes.find((scheme) => scheme.name === "oauth")?.kind;
};

const metadataOf = (line: Line, url: string): string | undefined => {
  const kind = kindOf(line, url);

  return kind?.type === "oauth2Token" ? kind.oauth2MetadataUrl : undefined;
};

describe("oauth2MetadataUrl (SSC-10)", () => {
  test("on 3.2 the oauth2 scheme records the metadata URL", () => {
    expect(kindOf("3.2", metadata)?.type).toBe("oauth2Token");
    expect(metadataOf("3.2", metadata)).toBe(metadata);
  });

  test("on 3.2 the recorded URL is sanitized", () => {
    expect(metadataOf("3.2", `https://auth.example/‮meta\u0000`)).toBe("https://auth.example/meta");
  });

  for (const line of ["3.0", "3.1"] as const) {
    test(`on ${line} nothing is recorded`, () => {
      expect(kindOf(line, metadata)?.type).toBe("oauth2Token");
      expect(metadataOf(line, metadata)).toBeUndefined();
    });
  }
});
