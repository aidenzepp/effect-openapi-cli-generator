/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import {
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Sink,
  Stdio,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import generatorPackage from "../../package.json" with { type: "json" };
import generatorTsconfig from "../../tsconfig.json" with { type: "json" };
import { generate } from "../../src/generate.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";
import * as BaseUrl from "../../src/runtime-src/runtime/base-url.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Output from "../../src/runtime-src/runtime/output.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";

// Each operation's bound origin set comes from its own effective servers (operation, else path
// item, else root). The bound sets below are read from what `generate` emits for this spec, so a
// document-wide set would let a credential follow `a` to the root host or to `b`'s host.

const SECRET = "tok-SRV-SECRET";

const ok = { "200": { description: "ok" } };

const bearer = [{ bearerAuth: [] }];

const spec = {
  components: { securitySchemes: { bearerAuth: { scheme: "bearer", type: "http" } } },
  info: { title: "servers", version: "1" },
  openapi: "3.1.0",
  paths: {
    "/a": {
      get: {
        operationId: "a-get",
        responses: ok,
        security: bearer,
        // The second entry is not accepted: its origin is accepted only at the root.
        servers: [{ url: "https://a.example.com/v1" }, { url: "https://api.example.com/v2" }],
      },
    },
    "/b": {
      get: { operationId: "b-get", responses: ok, security: bearer },
      servers: [{ url: "https://b.example.com" }],
    },
    "/r": { get: { operationId: "r-get", responses: ok, security: bearer } },
  },
  servers: [{ url: "https://api.example.com/v1" }],
};

const config = {
  binName: "x",
  envPrefix: "X",
  package: { name: "x-cli", version: "1.0.0" },
  servers: {
    accepted: ["https://api.example.com/v1", "https://a.example.com/v1", "https://b.example.com"],
  },
};

const decodeUri = Schema.decodeUnknownSync(DocumentUri);

const generator = {
  packageJson: Schema.decodeUnknownSync(Schema.Json)(generatorPackage),
  tsconfig: Schema.decodeUnknownSync(Schema.Json)(generatorTsconfig),
};

// Generates the spec into a scoped temp directory and returns the emitted api modules.
const emitted = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* emit() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "srv-" });
      const specPath = path.join(dir, "openapi.json");
      const configPath = path.join(dir, "author-config.json");
      const out = path.join(dir, "out");
      yield* fs.writeFileString(specPath, JSON.stringify(spec));
      yield* fs.writeFileString(configPath, JSON.stringify(config));
      yield* generate(
        {
          document: decodeUri("file:///servers/openapi.json"),
          generator,
          outDir: out,
          source: { _tag: "File", path: specPath },
          strict: false,
        },
        { document: decodeUri("file:///servers/author-config.json"), path: configPath },
      );

      return {
        root: yield* fs.readFileString(path.join(out, "src/api/root.ts")),
        servers: yield* fs.readFileString(path.join(out, "src/api/servers.ts")),
      };
    }),
  ).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
);

// The `boundOrigins` strings of the exported const `name` in an emitted module.
const boundOf = (module: string, name: string): readonly string[] => {
  const start = module.indexOf(`export const ${name}`);
  const block = module.slice(start, module.indexOf("\n};", start));
  const items = /boundOrigins: \[(?<items>[^\]]*)\]/u.exec(block)?.groups?.items ?? "";

  return [...items.matchAll(/"(?<origin>[^"]*)"/gu)].map((match) => match.groups?.origin ?? "");
};

const rootTable: BaseUrl.ServersTable = {
  boundOrigins: boundOf(emitted.servers, "servers"),
  defaultServer: 0,
  servers: [{ url: "https://api.example.com/v1" }],
};

const security: Auth.SecurityTable = {
  schemes: { bearerAuth: { kind: "http", scheme: "bearer" } },
};

const base: Output.OperationMeta = {
  media: { request: [], responses: { "200": [] } },
  method: "GET",
  pathTemplate: "/r",
  security: [["bearerAuth"]],
};

// An operation's meta with its override table, bound as `generate` emitted its `name` const.
const overriding = (
  pathTemplate: string,
  name: string,
  servers: readonly BaseUrl.ServerEntry[],
): Output.OperationMeta => ({
  ...base,
  pathTemplate,
  servers: { boundOrigins: boundOf(emitted.root, name), defaultServer: 0, servers },
});

const aMeta = overriding("/a", "aGetMeta", [
  { url: "https://a.example.com/v1" },
  { url: "https://api.example.com/v2" },
]);

const bMeta = overriding("/b", "bGetMeta", [{ url: "https://b.example.com" }]);

const rMeta = base;

interface Seen {
  readonly authorization: string | undefined;
  readonly url: string;
}

interface World {
  readonly redirectTo?: string;
  readonly server?: string;
}

const sink = () => Sink.forEach(() => Effect.void);

// Sends `meta` once against a recording client; with `redirectTo`, the first hop answers 302.
const run = async (meta: Output.OperationMeta, world: World = {}) => {
  const seen: Seen[] = [];
  const client = HttpClient.make((sent, url) =>
    Effect.sync(() => {
      seen.push({ authorization: sent.headers.authorization, url: url.href });

      const hop = world.redirectTo !== undefined && seen.length === 1;

      return HttpClientResponse.fromWeb(
        sent,
        new Response(
          null,
          hop ? { headers: { location: world.redirectTo ?? "" }, status: 302 } : { status: 200 },
        ),
      );
    }),
  );
  const environment = Layer.mergeAll(
    BaseUrl.layer(rootTable, "X"),
    Auth.layer(security, "X"),
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ X_BEARER_AUTH: SECRET })),
    FileSystem.layerNoop({}),
    Path.layer,
    Stdio.layerTest({ stderr: sink, stdout: sink, stdoutIsTerminal: Effect.succeed(false) }),
    Input.stdinClaimLayer,
    Output.runCredentialsLayer,
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(Output.ClientPolicy, {
      allowed: new Set(["GET"]),
      binName: "x",
      direct: {},
      version: "1.0.0",
    }),
    Layer.succeed(Output.OutputPath, Option.none()),
    Layer.succeed(Output.Force, false),
    Layer.succeed(Output.MaxErrorBytes, Output.defaultMaxErrorBytes),
    Layer.succeed(BaseUrl.baseUrlSetting, Option.none()),
    Layer.succeed(BaseUrl.serverSetting, Option.fromNullishOr(world.server)),
    Layer.succeed(BaseUrl.serverVariableSetting, []),
    Layer.succeed(Auth.allowCredentialsForBaseUrl, false),
  );
  const request = Serialize.request("GET", {
    headers: [],
    path: Serialize.path(meta.pathTemplate, []),
    query: [],
  });
  const exit = await Effect.runPromise(
    Effect.exit(request.pipe(Effect.flatMap(Output.send(meta)))).pipe(Effect.provide(environment)),
  );

  return { exit, seen };
};

const credential = `Bearer ${SECRET}`;

describe("generated bound sets", () => {
  test("each table binds the origins of its own accepted servers", () => {
    expect(rootTable.boundOrigins).toEqual(["https://api.example.com"]);
    expect(aMeta.servers?.boundOrigins).toEqual(["https://a.example.com"]);
    expect(bMeta.servers?.boundOrigins).toEqual(["https://b.example.com"]);
  });
});

describe("Output.send with an operation's servers", () => {
  test("an operation override sends to its host with the credential", async () => {
    const { seen } = await run(aMeta);

    expect(seen).toEqual([{ authorization: credential, url: "https://a.example.com/v1/a" }]);
  });

  test("a path-item override sends to its host with the credential", async () => {
    const { seen } = await run(bMeta);

    expect(seen).toEqual([{ authorization: credential, url: "https://b.example.com/b" }]);
  });

  test("a redirect from an override to the root host drops the credential", async () => {
    const { seen } = await run(aMeta, { redirectTo: "https://api.example.com/v1/a" });

    expect(seen.map((hop) => hop.url)).toEqual([
      "https://a.example.com/v1/a",
      "https://api.example.com/v1/a",
    ]);
    expect(seen.map((hop) => hop.authorization)).toEqual([credential, undefined]);
  });

  test("a redirect from an override to another operation's host drops the credential", async () => {
    const { seen } = await run(aMeta, { redirectTo: "https://b.example.com/b" });

    expect(seen.map((hop) => hop.authorization)).toEqual([credential, undefined]);
  });

  test("a redirect from the root host to an operation's host drops the credential", async () => {
    const { seen } = await run(rMeta, { redirectTo: "https://a.example.com/v1/a" });

    expect(seen.map((hop) => hop.authorization)).toEqual([credential, undefined]);
  });

  test("--server naming an entry whose origin is accepted only at the root sends no credential", async () => {
    const { exit, seen } = await run(aMeta, { server: "1" });

    expect(Exit.isFailure(exit)).toBe(true);
    expect(seen.filter((hop) => hop.authorization !== undefined)).toEqual([]);
  });
});
