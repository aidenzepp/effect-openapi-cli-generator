import { describe, expect, test } from "bun:test";
import { Array as Arr, Effect, Order, Schema } from "effect";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";

// A mutualTLS scheme's certificate environment names (`<PREFIX>_<SCHEME>_CERT`, `_KEY`, `_CA`)
// join the SSC-01 credential collision check: a name another certificate or a token credential
// also takes refuses every operation using the scheme, and a scheme name folding to nothing is
// SSC-01/empty-name (design 4.4). Certificate names have no override key, so a certificate's
// hint names the colliding token's `security["<token>"].env`, or else the operation's skip (R87).

const document = Schema.decodeUnknownSync(DocumentUri)("file:///mtls/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///mtls/author-config.json");

const config: Schema.Json = {
  binName: "mtls",
  envPrefix: "MT",
  package: { name: "mtls-cli", version: "1.0.0" },
  servers: { accepted: ["https://api.example.com"] },
};

const mutualTls: Schema.Json = { type: "mutualTLS" };

const bearer: Schema.Json = { scheme: "bearer", type: "http" };

// A `GET /<operationId>` path item with one security alternative per scheme (none for `[]`).
const pathItem = (
  operationId: string,
  ...schemes: readonly string[]
): readonly [string, Schema.Json] => [
  `/${operationId}`,
  {
    get: {
      operationId,
      responses: { "204": { description: "Done." } },
      security: schemes.map((scheme) => ({ [scheme]: [] })),
    },
  },
];

// One operation per `[operationId, scheme]` entry of `uses`, plus the unsecured `open`.
const spec = (
  securitySchemes: Readonly<Record<string, Schema.Json>>,
  uses: readonly (readonly [string, string])[],
): Schema.Json => ({
  components: { securitySchemes },
  info: { title: "Mtls", version: "1.0.0" },
  openapi: "3.1.1",
  paths: Object.fromEntries([
    ...uses.map(([operationId, scheme]) => pathItem(operationId, scheme)),
    pathItem("open"),
  ]),
});

interface Shown {
  readonly code: string;
  readonly hint: string | undefined;
  readonly pointer: string;
  readonly scope: string;
  readonly severity: string;
}

const planned = (
  securitySchemes: Readonly<Record<string, Schema.Json>>,
  uses: readonly (readonly [string, string])[],
) =>
  Effect.runPromise(
    Effect.gen(function* generate() {
      const author = yield* decodeAuthorConfig(config, { document: configDocument });
      const resolution = yield* resolve({
        document,
        line: "3.1",
        value: spec(securitySchemes, uses),
      });
      const { api } = yield* normalize(resolution, {
        checkFindings: [],
        config: author,
        configDocument,
      });
      const plan = yield* planNames(api, { config: author, configDocument, strict: false });

      return {
        commands: Arr.sort(
          [...plan.root, ...plan.groups.flatMap((group) => group.commands)].map(
            (command) => command.name,
          ),
          Order.String,
        ),
        diagnostics: plan.diagnostics.map(({ code, hint, pointer, scope, severity }): Shown => ({
          code,
          hint,
          pointer,
          scope,
          severity,
        })),
      };
    }),
  );

// The hint for an operation whose colliding certificate names have no override key (R87 B).
const skip = (operation: string): string =>
  `Skip the operation with naming.operations[${JSON.stringify(operation)}].skip.`;

const refusal = (code: string, operation: string, hint?: string) => ({
  code,
  hint,
  pointer: `/paths/~1${operation}/get`,
  scope: "operation",
  severity: "refusal",
});

describe("certificate environment names join the SSC-01 collision check", () => {
  test("two mutualTLS schemes folding to one slug refuse each operation, hinting the skip", async () => {
    const result = await planned({ Client: mutualTls, client: mutualTls }, [
      ["lower", "client"],
      ["upper", "Client"],
    ]);

    expect(result.commands).toEqual(["open"]);
    expect(result.diagnostics).toEqual([
      refusal("SSC-01/credential-collision", "lower", skip("lower")),
      refusal("SSC-01/credential-collision", "upper", skip("upper")),
    ]);
  });

  test("a certificate name equal to a token env name refuses both, hinting the token's env", async () => {
    const result = await planned({ client: mutualTls, "client-cert": bearer }, [
      ["certified", "client"],
      ["tokened", "client-cert"],
    ]);

    expect(result.commands).toEqual(["open"]);
    expect(result.diagnostics).toEqual([
      refusal("SSC-01/credential-collision", "certified", 'security["client-cert"].env'),
      refusal("SSC-01/credential-collision", "tokened", 'security["client-cert"].env'),
    ]);
  });

  test("a mutualTLS scheme with distinct names is kept", async () => {
    const result = await planned({ client: mutualTls, partner: mutualTls }, [
      ["certified", "client"],
      ["partnered", "partner"],
    ]);

    expect(result.commands).toEqual(["certified", "open", "partnered"]);
    expect(result.diagnostics).toEqual([]);
  });

  test("a mutualTLS scheme name folding to nothing is SSC-01/empty-name", async () => {
    const result = await planned({ _: mutualTls }, [["blank", "_"]]);

    expect(result.commands).toEqual(["open"]);
    expect(result.diagnostics).toEqual([refusal("SSC-01/empty-name", "blank")]);
  });
});
