import { describe, expect, test } from "bun:test";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { Array as Arr, Effect, Order, Schema } from "effect";
import { emitCli } from "../../src/emit/cli.ts";
import type { CliEmitOutput } from "../../src/emit/cli.ts";
import { decodeAuthorConfig } from "../../src/model/author-config.ts";
import { DocumentUri } from "../../src/model/brands.ts";
import { planNames } from "../../src/names/index.ts";
import { normalize } from "../../src/normalize/index.ts";
import { resolve } from "../../src/resolve/index.ts";

const fixture = nodePath.resolve(import.meta.dir, "../fixtures/golden/users-update");

const JsonRecord = Schema.Record(Schema.String, Schema.Json);

const decodeRecord = Schema.decodeUnknownSync(JsonRecord);

const read = (relative: string) =>
  decodeRecord(JSON.parse(nodeFs.readFileSync(nodePath.join(fixture, relative), "utf-8")));

const spec = read("openapi.json");

const configJson = read("author-config.json");

const document = Schema.decodeUnknownSync(DocumentUri)("file:///golden/openapi.json");

const configDocument = Schema.decodeUnknownSync(DocumentUri)("file:///golden/author-config.json");

const emit = (value: Schema.Json) =>
  Effect.runPromise(
    Effect.gen(function* generate() {
      const config = yield* decodeAuthorConfig(configJson, { document: configDocument });
      const resolution = yield* resolve({ document, line: "3.1", value });
      const { api } = yield* normalize(resolution, { checkFindings: [], config, configDocument });
      const plan = yield* planNames(api, { config, configDocument, strict: false });

      return yield* emitCli({ api, config, plan, validationEdits: [] });
    }),
  );

const contentOf = (output: CliEmitOutput, path: string) =>
  output.files.find((file) => file.path === path)?.content ?? "";

// The root's settings in registration order: the Milestone 2 eight, then the Milestone 3 eight in
// the order the slice list fixes (m3-wi1a), then each scheme's file setting.
const registered = [
  "BaseUrl.baseUrlSetting",
  "BaseUrl.serverSetting",
  "BaseUrl.serverVariableSetting",
  "Auth.allowCredentialsForBaseUrl",
  "Output.OutputPath",
  "Output.Force",
  "Output.MaxErrorBytes",
  "Describe.describeFlag",
  "Client.timeoutSetting",
  "Client.retriesSetting",
  "Client.retryUnsafeSetting",
  "Client.verboseSetting",
  "Output.Raw",
  "Output.MaxRecordBytes",
  "Output.errorFormatSetting",
  "Output.dryRunSetting",
  'Auth.credentialFileSetting("bearerAuth")',
];

const recordRun = 'Command.provideEffectDiscard(Output.recordRun("EXAMPLE"))';

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe("m3-wi1a: the Milestone 3 global settings and the run record", () => {
  test("cli/root.ts registers the Milestone 3 settings after the existing ones, in order", async () => {
    const root = contentOf(await emit(spec), "src/cli/root.ts");
    expect(root).toContain('import * as Client from "../runtime/client.ts";');

    const flags = root.slice(root.indexOf("Command.withGlobalFlags(["));
    const positions = registered.map((setting) => flags.indexOf(setting));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect(positions).toEqual(Arr.sort(positions, Order.Number));
    for (const setting of registered) {
      expect(occurrences(root, setting)).toBe(1);
    }
  });

  test("each group command records the run before its handler", async () => {
    const users = contentOf(await emit(spec), "src/cli/users.ts");
    // Two commands, `update` and `setAvatar`; the `group` header runs no handler and records none.
    const commands = users.split(/^export const (?!group )\w+ = Command\.make\(/mu).slice(1);
    expect(commands).toHaveLength(2);
    expect(occurrences(users, recordRun)).toBe(2);
    expect(users).toContain(
      'export const group = Command.make("users").pipe(Command.withSubcommands([update, setAvatar]));',
    );
    // The record step is each command's first pipe step, ahead of every annotation.
    for (const command of commands) {
      const steps = command.slice(command.indexOf("\n).pipe(\n"));
      expect(steps.indexOf(recordRun)).toBeGreaterThan(0);
      expect(steps.indexOf(recordRun)).toBeLessThan(steps.indexOf("Command.annotate("));
    }
  });

  test("an untagged root command records the run too", async () => {
    const root = contentOf(
      await emit({
        ...spec,
        paths: {
          ...decodeRecord(spec.paths),
          "/health": {
            get: { operationId: "health", responses: { "200": { description: "ok" } } },
          },
        },
      }),
      "src/cli/root.ts",
    );
    expect(root).toContain('export const health = Command.make("health", {}, () =>');
    expect(occurrences(root, recordRun)).toBe(1);
  });
});
