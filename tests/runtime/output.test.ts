/* oxlint-disable unicorn/no-array-for-each -- Sink.forEach is the Effect sink, not Array#forEach */
import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Runtime,
  Sink,
  Stdio,
  Stream,
} from "effect";
import { CliError } from "effect/cli";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { GlobalFlag } from "effect/cli";
import { systemError } from "effect/PlatformError";
import {
  ApiResponseError,
  CredentialMissing,
  OutputError as OutputErrorClass,
  TransportError,
  UsageError,
} from "../../src/runtime-src/domain/errors.ts";
import * as Auth from "../../src/runtime-src/runtime/auth.ts";
import * as BaseUrl from "../../src/runtime-src/runtime/base-url.ts";
import * as Input from "../../src/runtime-src/runtime/input.ts";
import * as Serialize from "../../src/runtime-src/runtime/serialize.ts";
import { mapClientError } from "../../src/runtime-src/runtime/response.ts";
import type { Credential } from "../../src/runtime-src/runtime/auth.ts";
import {
  ClientPolicy,
  dryRunSetting,
  Force,
  InternalError,
  defaultMaxErrorBytes,
  MaxErrorBytes,
  OutputPath,
  boundedExcerpt,
  finalCatch,
  readExcerpt,
  renderError,
  sanitize,
  send,
  valueFreeFormatter,
  writeBody,
} from "../../src/runtime-src/runtime/output.ts";
import type { OperationMeta, ResponseBody } from "../../src/runtime-src/runtime/output.ts";
import { queryWireForm, runCredentialsLayer, scrub } from "../../src/runtime-src/runtime/redact.ts";

type Env =
  | FileSystem.FileSystem
  | Path.Path
  | Stdio.Stdio
  | GlobalFlag.Setting.Identifier<"force">
  | GlobalFlag.Setting.Identifier<"output">;

const chunkA = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);

const chunkB = new Uint8Array([0xfe, 0x01, 0x80]);

const bytes = new Uint8Array([...chunkA, ...chunkB]);

const brokenPipe = systemError({
  _tag: "Unknown",
  cause: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
  method: "stdout",
  module: "Stdio",
});

const diskFull = systemError({
  _tag: "Unknown",
  cause: Object.assign(new Error("write ENOSPC"), { code: "ENOSPC" }),
  method: "stdout",
  module: "Stdio",
});

interface Settings {
  readonly force?: boolean;
  readonly isTerminal?: boolean;
  readonly output?: string;
  readonly stdout?: Stdio.Stdio["stdout"];
}

/**
 * A two-chunk body that counts how many chunks were pulled.
 */
const countedBody = (
  mediaType: string | undefined,
  onChunk?: (n: number) => Effect.Effect<void, never, Env>,
) => {
  const pulled = { count: 0 };
  const body: ResponseBody<never, Env> = {
    bytes: Stream.fromIterable([chunkA, chunkB]).pipe(
      Stream.tap(() =>
        Effect.suspend(() => {
          pulled.count += 1;

          return onChunk?.(pulled.count) ?? Effect.void;
        }),
      ),
    ),
    mediaType,
  };

  return { body, pulled };
};

const run = <A, E>(settings: Settings, program: Effect.Effect<A, E, Env>) => {
  const captured: Buffer[] = [];
  const layer = Layer.mergeAll(
    BunFileSystem.layer,
    BunPath.layer,
    Stdio.layerTest({
      stdout:
        settings.stdout ??
        (() =>
          Sink.forEach((chunk: string | Uint8Array) =>
            Effect.sync(() => {
              captured.push(Buffer.from(chunk));
            }),
          )),
      stdoutIsTerminal: Effect.succeed(settings.isTerminal ?? false),
    }),
    Layer.succeed(OutputPath, Option.fromNullishOr(settings.output)),
    Layer.succeed(Force, settings.force ?? false),
  );

  return Effect.runPromise(Effect.exit(program).pipe(Effect.provide(layer))).then((exit) => ({
    exit,
    stdout: new Uint8Array(Buffer.concat(captured)),
  }));
};

const inDir = <A>(use: (dir: string, fs: FileSystem.FileSystem, path: Path.Path) => Promise<A>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* step1() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "rt6a-" });

        return yield* Effect.promise(() => use(dir, fs, path));
      }),
    ).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
  );

const failure = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Option.getOrUndefined(Exit.findErrorOption(exit));

const reasonOf = (error: { readonly _tag: string } | undefined) =>
  error instanceof OutputErrorClass ? error.reason : undefined;

describe("stdout sink", () => {
  test("raw bytes reach stdout unchanged", async () => {
    const { body } = countedBody("application/json");
    const result = await run({}, writeBody(body));
    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.stdout).toEqual(bytes);
  });

  test("a text body to a terminal is allowed", async () => {
    const { body } = countedBody("text/plain; charset=utf-8");
    const result = await run({ isTerminal: true }, writeBody(body));
    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.stdout).toEqual(bytes);
  });

  test("--output - sends a binary body to a terminal", async () => {
    const { body } = countedBody("image/png");
    const result = await run({ isTerminal: true, output: "-" }, writeBody(body));
    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(result.stdout).toEqual(bytes);
  });

  test("binary media to a terminal is refused with UsageError and zero body bytes read", async () => {
    const mediaTypes = ["image/png", "application/octet-stream", undefined];
    const outcomes = await Promise.all(
      mediaTypes.map(async (mediaType) => {
        const { body, pulled } = countedBody(mediaType);
        const result = await run({ isTerminal: true }, writeBody(body));

        return { error: failure(result.exit), pulled: pulled.count, written: result.stdout.length };
      }),
    );

    for (const outcome of outcomes) {
      expect(outcome.error).toBeInstanceOf(UsageError);
      expect(outcome.pulled).toBe(0);
      expect(outcome.written).toBe(0);
    }
  });

  test("--force does not let binary media reach a terminal", async () => {
    const { body, pulled } = countedBody("image/png");
    const result = await run({ force: true, isTerminal: true }, writeBody(body));
    expect(failure(result.exit)).toBeInstanceOf(UsageError);
    expect(pulled.count).toBe(0);
  });

  test("EPIPE on stdout stops the stream and succeeds", async () => {
    const { body, pulled } = countedBody("application/json");
    const result = await run(
      { stdout: () => Sink.forEach(() => Effect.fail(brokenPipe)) },
      writeBody(body),
    );
    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(pulled.count).toBeLessThan(2);
  });

  test("another stdout write failure is OutputError write", async () => {
    const { body } = countedBody("application/json");
    const result = await run(
      { stdout: () => Sink.forEach(() => Effect.fail(diskFull)) },
      writeBody(body),
    );
    expect(reasonOf(failure(result.exit))).toBe("write");
  });
});

describe("--output file", () => {
  test("bytes land through a temp sibling renamed into place", async () => {
    await inDir(async (dir, fs, path) => {
      const target = path.join(dir, "out.bin");
      const listings: (readonly string[])[] = [];
      const { body } = countedBody("image/png", (n) =>
        n === 2
          ? fs.readDirectory(dir).pipe(
              Effect.orDie,
              Effect.tap((names) =>
                Effect.sync(() => {
                  listings.push(names);
                }),
              ),
              Effect.asVoid,
            )
          : Effect.void,
      );
      const result = await run({ isTerminal: true, output: target }, writeBody(body));
      expect(Exit.isSuccess(result.exit)).toBe(true);
      expect(result.stdout.length).toBe(0);
      expect(listings).toHaveLength(1);
      expect(listings[0]?.includes("out.bin")).toBe(false);
      expect(listings[0]).toHaveLength(1);
      expect(
        new Uint8Array(
          await Effect.runPromise(fs.readFile(target).pipe(Effect.provide(BunFileSystem.layer))),
        ),
      ).toEqual(bytes);
      expect(
        await Effect.runPromise(fs.readDirectory(dir).pipe(Effect.provide(BunFileSystem.layer))),
      ).toEqual(["out.bin"]);
    });
  });

  test("an existing path is refused without --force, untouched, with no body read and no temp left", async () => {
    await inDir(async (dir, fs, path) => {
      const target = path.join(dir, "out.bin");
      await Effect.runPromise(
        fs.writeFileString(target, "keep").pipe(Effect.provide(BunFileSystem.layer)),
      );
      const { body, pulled } = countedBody("application/json");
      const result = await run({ output: target }, writeBody(body));
      expect(reasonOf(failure(result.exit))).toBe("exists");
      expect(pulled.count).toBe(0);
      expect(
        await Effect.runPromise(
          fs.readFileString(target).pipe(Effect.provide(BunFileSystem.layer)),
        ),
      ).toBe("keep");
      expect(
        await Effect.runPromise(fs.readDirectory(dir).pipe(Effect.provide(BunFileSystem.layer))),
      ).toEqual(["out.bin"]);
    });
  });

  test("--force replaces an existing file", async () => {
    await inDir(async (dir, fs, path) => {
      const target = path.join(dir, "out.bin");
      await Effect.runPromise(
        fs.writeFileString(target, "old").pipe(Effect.provide(BunFileSystem.layer)),
      );
      const { body } = countedBody("application/json");
      const result = await run({ force: true, output: target }, writeBody(body));
      expect(Exit.isSuccess(result.exit)).toBe(true);
      expect(
        new Uint8Array(
          await Effect.runPromise(fs.readFile(target).pipe(Effect.provide(BunFileSystem.layer))),
        ),
      ).toEqual(bytes);
      expect(
        await Effect.runPromise(fs.readDirectory(dir).pipe(Effect.provide(BunFileSystem.layer))),
      ).toEqual(["out.bin"]);
    });
  });

  test("a path created while the body streams is not overwritten without --force", async () => {
    await inDir(async (dir, fs, path) => {
      const target = path.join(dir, "out.bin");
      const { body } = countedBody("application/json", (n) =>
        n === 2 ? fs.writeFileString(target, "racer").pipe(Effect.orDie) : Effect.void,
      );
      const result = await run({ output: target }, writeBody(body));
      expect(reasonOf(failure(result.exit))).toBe("exists");
      expect(
        await Effect.runPromise(
          fs.readFileString(target).pipe(Effect.provide(BunFileSystem.layer)),
        ),
      ).toBe("racer");
      expect(
        await Effect.runPromise(fs.readDirectory(dir).pipe(Effect.provide(BunFileSystem.layer))),
      ).toEqual(["out.bin"]);
    });
  });

  test("a failing body leaves no target and no temp file", async () => {
    await inDir(async (dir, fs, path) => {
      const target = path.join(dir, "out.bin");
      const failing: ResponseBody<"boom"> = {
        bytes: Stream.concat(Stream.make(chunkA), Stream.fail("boom" as const)),
        mediaType: "application/json",
      };
      const result = await run({ output: target }, writeBody(failing));
      expect(failure(result.exit)).toBe("boom");
      expect(
        await Effect.runPromise(fs.readDirectory(dir).pipe(Effect.provide(BunFileSystem.layer))),
      ).toEqual([]);
    });
  });

  test("an unwritable directory is OutputError write", async () => {
    await inDir(async (dir, _fs, path) => {
      const { body } = countedBody("application/json");
      const result = await run({ output: path.join(dir, "missing", "out.bin") }, writeBody(body));
      expect(reasonOf(failure(result.exit))).toBe("write");
    });
  });
});

const canary = "CANARY-SECRET-123";

const bearer: Credential = {
  definition: { kind: "http", scheme: "bearer" },
  scheme: "bearer",
  value: Redacted.make(canary),
};

const utf8 = new TextEncoder();

const utf8Length = (text: string): number => utf8.encode(text).length;

const chunked = (text: string, size: number): Stream.Stream<Uint8Array> => {
  const all = utf8.encode(text);
  const chunks: Uint8Array[] = [];

  for (let at = 0; at < all.length; at += size) {
    chunks.push(all.subarray(at, at + size));
  }

  return Stream.fromIterable(chunks);
};

const excerptOf = (text: string, max: number, chunkSize = 1000) =>
  Effect.runPromise(
    readExcerpt(chunked(text, chunkSize), [bearer]).pipe(
      Effect.provide(Layer.succeed(MaxErrorBytes, max)),
    ),
  );

const responseError = (fields: Partial<ConstructorParameters<typeof ApiResponseError>[0]> = {}) =>
  new ApiResponseError({
    bodyExcerpt: "",
    matched: "404",
    operation: "users.get",
    status: 404,
    ...fields,
  });

const runCatch = <A, E>(program: Effect.Effect<A, E, Stdio.Stdio>, credentials = [bearer]) => {
  const stderr: Buffer[] = [];
  const layer = Stdio.layerTest({
    stderr: () =>
      Sink.forEach((chunk: string | Uint8Array) =>
        Effect.sync(() => {
          stderr.push(Buffer.from(chunk));
        }),
      ),
  });

  return Effect.runPromise(
    Effect.exit(finalCatch(credentials)(program)).pipe(
      Effect.provide(Layer.merge(layer, runCredentialsLayer)),
    ),
  ).then((exit) => ({ exit, stderr: Buffer.concat(stderr).toString("utf-8") }));
};

describe("readExcerpt bounds", () => {
  test("the default is 4 KiB, even when one chunk crosses the limit", async () => {
    const text = await excerptOf("a".repeat(10_000), defaultMaxErrorBytes, 10_000);

    expect(text.length).toBe(4096);
  });

  test("--max-error-bytes sets the bound and 0 reads nothing", async () => {
    const bounded = await excerptOf("a".repeat(10_000), 100, 300);

    expect(bounded.length).toBe(100);
    expect(await excerptOf("a".repeat(10_000), 0)).toBe("");
  });

  test("the 64 KiB ceiling holds", async () => {
    const text = await excerptOf("a".repeat(100_000), 65_536, 7000);

    expect(text.length).toBe(65_536);
  });

  test("the bound counts bytes, never splitting a character", async () => {
    const text = await excerptOf("é".repeat(5000), 101, 7);

    expect(utf8Length(text)).toBeLessThanOrEqual(101);
    expect(text).toBe("é".repeat(50));
  });

  test("a short body is returned whole", async () => {
    expect(await excerptOf("not found", defaultMaxErrorBytes)).toBe("not found");
  });
});

describe("credential scrubbing", () => {
  test("a canary echoed in the body is absent and marked", async () => {
    const body = JSON.stringify({ echo: { authorization: `Bearer ${canary}` } });
    const text = await excerptOf(body, defaultMaxErrorBytes, 5);

    expect(text).not.toContain(canary);
    expect(text).toContain("<redacted:bearer>");
  });

  test("a canary straddling the truncation point leaves no prefix", async () => {
    const text = await excerptOf(`0123456789${canary}-tail`, 20, 4);

    expect(text).not.toContain("CANA");
    expect(utf8Length(text)).toBeLessThanOrEqual(20);
  });

  test("the longest credential is scrubbed first", () => {
    const longer: Credential = { ...bearer, scheme: "long", value: Redacted.make(`${canary}-X`) };

    expect(scrub(`${canary}-X`, [bearer, longer])).toBe("<redacted:long>");
  });

  test("an empty credential value is ignored", () => {
    const empty: Credential = { ...bearer, value: Redacted.make("") };

    expect(scrub("text", [empty])).toBe("text");
  });

  test("the bound applies after scrubbing, which can lengthen text (audit F6)", () => {
    const short: Credential = { ...bearer, scheme: "bearer", value: Redacted.make("x") };
    const text = boundedExcerpt("x".repeat(70_000), 65_536, [short]);

    expect(utf8Length(text)).toBeLessThanOrEqual(65_536);
    expect(() => {
      responseError({ bodyExcerpt: text });
    }).not.toThrow();
  });
});

const longSecret = "SECRETTOKEN-abcdefghijklmnopqrstuvwxyz01";

const longBearer: Credential = { ...bearer, value: Redacted.make(longSecret) };

const basic: Credential = {
  definition: { kind: "http", scheme: "basic" },
  scheme: "basicAuth",
  value: Redacted.make("alice:pass/word+=CANARY"),
};

const queryKey: Credential = {
  definition: { in: "query", kind: "apiKey", name: "api_key" },
  scheme: "apiKey",
  value: Redacted.make("key/with+plus=CANARY&"),
};

const excerptWith = (text: string, max: number, credentials: readonly Credential[]) =>
  Effect.runPromise(
    readExcerpt(chunked(text, 7), credentials).pipe(
      Effect.provide(Layer.succeed(MaxErrorBytes, max)),
    ),
  );

/**
 * The longest non-empty prefix of `secret` that `text` ends with, or "" when there is none.
 */
const trailingPrefix = (text: string, secret: string): string => {
  for (let size = secret.length; size > 0; size -= 1) {
    if (text.endsWith(secret.slice(0, size))) {
      return secret.slice(0, size);
    }
  }

  return "";
};

// The Authorization header exactly as HttpClientRequest.basicAuth sends it.
const basicHeader = (): string => {
  const sent = HttpClientRequest.basicAuth(
    HttpClientRequest.get("https://api.example.com"),
    "alice",
    "pass/word+=CANARY",
  );

  return sent.headers.authorization ?? "";
};

// The query string exactly as the client writes an apiKey query credential.
const queryWire = (): string => `api_key=${queryWireForm("key/with+plus=CANARY&")}`;

// Audit M F1 probe values with each form a server may echo: raw, URLSearchParams, and the bytes
// the request target carries.
const queryProbes = [
  { raw: "k e y", searchParams: "k+e+y", wire: "k%20e%20y" },
  { raw: "a!b/c", searchParams: "a%21b%2Fc", wire: "a!b%2Fc" },
  { raw: "a~b c", searchParams: "a%7Eb+c", wire: "a~b%20c" },
  { raw: "x'y z", searchParams: "x%27y+z", wire: "x%27y%20z" },
] as const;

describe("credential scrubbing at the read budget (audit F1)", () => {
  test("a credential longer than its placeholder cut by the read budget leaves no prefix", async () => {
    const body = `${longSecret}${"x".repeat(61)}${longSecret}tail`;
    const text = await excerptWith(body, 100, [longBearer]);

    expect(text).toContain("<redacted:bearer>");
    expect(text).not.toContain("SECRETTOKEN");
    expect(trailingPrefix(text, longSecret)).toBe("");
    expect(utf8Length(text)).toBeLessThanOrEqual(100);
  });

  test("a basic token cut by the read budget leaves no prefix of it", async () => {
    const token = basicHeader().slice("Basic ".length);
    const body = `Basic ${token} ${"y".repeat(40)} Basic ${token}`;
    const text = await excerptWith(body, 60, [basic]);

    expect(text).not.toContain(token.slice(0, 4));
    expect(trailingPrefix(text, token)).toBe("");
  });
});

describe("every wire form of a credential is scrubbed (audit F2)", () => {
  test("the I4 Authorization echo of a basic credential is scrubbed in excerpt and render", async () => {
    const echo = basicHeader();
    const token = echo.slice("Basic ".length);
    const text = await excerptWith(echo, defaultMaxErrorBytes, [basic]);
    const rendered = renderError(responseError({ bodyExcerpt: echo, status: 401 }), [basic]);

    for (const output of [text, rendered]) {
      expect(output).not.toContain(token);
      expect(output).not.toContain("CANARY");
      expect(output).toContain("<redacted:basicAuth>");
    }
  });

  test("the password of a basic credential alone is scrubbed", () => {
    expect(scrub("password was pass/word+=CANARY", [basic])).toBe(
      "password was <redacted:basicAuth>",
    );
  });

  test("a percent-encoded query key echoed in a URL is scrubbed", async () => {
    const url = `https://api.example.com/users?${queryWire()}`;
    const text = await excerptWith(`redirected to ${url}`, defaultMaxErrorBytes, [queryKey]);
    const rendered = renderError(new TransportError({ reason: "connect", url }), [queryKey]);

    expect(queryWire()).toContain("%2F");
    for (const output of [text, rendered]) {
      expect(output).not.toContain("CANARY");
      expect(output).toContain("<redacted:apiKey>");
    }
  });
});

describe("every echoed form of a query credential is scrubbed (audit M F1)", () => {
  for (const probe of queryProbes) {
    const credential: Credential = { ...queryKey, value: Redacted.make(probe.raw) };

    for (const form of ["raw", "searchParams", "wire"] as const) {
      test(`${JSON.stringify(probe.raw)} echoed as its ${form} form in an excerpt and request id`, async () => {
        const echo = `api_key=${probe[form]}`;
        const text = await excerptWith(`echo ${echo} end`, defaultMaxErrorBytes, [credential]);
        const rendered = renderError(
          responseError({ bodyExcerpt: `echo ${echo} end`, requestId: `id-${probe[form]}` }),
          [credential],
        );

        expect(text).toBe("echo api_key=<redacted:apiKey> end");
        expect(rendered).toContain("Request ID: id-<redacted:apiKey>");
        expect(rendered).not.toContain(probe[form]);
      });
    }
  }
});

describe("overlapping credential forms are scrubbed as one run (recheck N1)", () => {
  test("a short form overlapping the start of a longer credential leaves neither in clear", () => {
    const token = "SECRETTOKEN-abcdefghijklmnopqrstuvwxyz01";
    const longToken: Credential = { ...bearer, value: Redacted.make(token) };
    const shortPassword: Credential = { ...basic, value: Redacted.make("alice:word2SECRET") };
    const text = scrub(`echo word2${token} end`, [longToken, shortPassword]);

    expect(text).toBe("echo <redacted:basicAuth> end");
    expect(text).not.toContain("word2");
    expect(text).not.toContain("TOKEN");
  });

  test("forms that only touch are replaced once", () => {
    expect(scrub(`[${canary}${canary}]`, [bearer])).toBe("[<redacted:bearer>]");
  });
});

describe("sanitize", () => {
  test("keeps LF and TAB; removes C0, DEL, C1, bidi, format and line separators", () => {
    const dirty = "a\u0000b\u001Bc\u007Fd\u0085e\u202Ef\u200Bg\u2028h\u2029i\n\tj";

    expect(sanitize(dirty)).toBe("abcdefghi\n\tj");
  });

  test("removes lone surrogates and keeps paired ones", () => {
    expect(sanitize("a\uD800b\u{1F600}")).toBe("ab\u{1F600}");
  });
});

describe("renderError", () => {
  test("an ApiResponseError shows its line, request id and scrubbed excerpt", () => {
    const text = renderError(
      responseError({ bodyExcerpt: `echo ${canary}\u001B[31m`, requestId: "req-1" }),
      [bearer],
    );

    expect(text).toContain("users.get");
    expect(text).toContain("404");
    expect(text).toContain("Request ID: req-1");
    expect(text).toContain("<redacted:bearer>");
    expect(text).not.toContain(canary);
    expect(text).not.toContain("\u001B");
  });

  test("an empty excerpt prints no body section", () => {
    expect(renderError(responseError(), [bearer]).trimEnd().split("\n")).toHaveLength(1);
  });

  test("a credential in a request id or transport URL is scrubbed", () => {
    const api = renderError(responseError({ requestId: `id-${canary}` }), [bearer]);
    const transport = renderError(
      new TransportError({ reason: "connect", url: `https://h/?k=${canary}` }),
      [bearer],
    );

    expect(api).not.toContain(canary);
    expect(transport).not.toContain(canary);
  });

  test("an oversized excerpt is bounded at the ceiling after scrubbing", () => {
    const short: Credential = { ...bearer, value: Redacted.make("x") };
    const text = renderError(responseError({ bodyExcerpt: "x".repeat(65_536) }), [short]);

    expect(utf8Length(text)).toBeLessThan(65_536 + 512);
    expect(text).not.toContain("xxxx");
  });
});

describe("valueFreeFormatter", () => {
  const invalid = new CliError.InvalidValue({
    expected: `Expected a port, got "${canary}"`,
    kind: "flag",
    option: "port",
    value: canary,
  });

  test("an InvalidValue names the option and never the value or expectation", () => {
    for (const text of [
      valueFreeFormatter.formatError(invalid),
      valueFreeFormatter.formatErrors([invalid]),
      valueFreeFormatter.formatCliError(invalid),
    ]) {
      expect(text).toContain("port");
      expect(text).not.toContain(canary);
      expect(text).not.toContain("Expected");
    }
  });

  test("an argument names its position label, not its value", () => {
    const argument = new CliError.InvalidValue({
      expected: "integer",
      kind: "argument",
      option: "count",
      value: canary,
    });

    expect(valueFreeFormatter.formatErrors([argument])).toContain("count");
    expect(valueFreeFormatter.formatErrors([argument])).not.toContain(canary);
  });
});

describe("finalCatch", () => {
  test("success passes through untouched", async () => {
    const { exit, stderr } = await runCatch(Effect.succeed(7));

    expect(Exit.isSuccess(exit) && exit.value).toBe(7);
    expect(stderr).toBe("");
  });

  test("an unknown defect prints one scrubbed line and exits 70", async () => {
    const { exit, stderr } = await runCatch(Effect.die(new Error(`boom ${canary}\nsecond`)));
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

    expect(error).toBeInstanceOf(InternalError);
    expect(Runtime.getErrorExitCode(error)).toBe(70);
    expect(Runtime.getErrorReported(error)).toBe(false);
    expect(stderr).toContain("internal error, please report");
    expect(stderr).toContain("<redacted:bearer>");
    expect(stderr).not.toContain(canary);
    expect(stderr.trimEnd().split("\n")).toHaveLength(2);
  });

  test("a non-transport HttpClientError reason prints one internal-error line and exits 70", async () => {
    const encode = new HttpClientError.HttpClientError({
      reason: new HttpClientError.EncodeError({
        request: HttpClientRequest.get("https://api.example.test/pets"),
      }),
    });
    const { exit, stderr } = await runCatch(
      Effect.fail(encode).pipe(Effect.catchTag("HttpClientError", mapClientError)),
    );
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

    expect(Runtime.getErrorExitCode(error)).toBe(70);
    expect(stderr).toBe(
      "Error: Encode error (GET https://api.example.test/pets)\ninternal error, please report\n",
    );
  });

  test("an unrecognized typed failure also exits 70", async () => {
    const { exit } = await runCatch(Effect.fail("plain string"));

    expect(Exit.isFailure(exit) && Runtime.getErrorExitCode(Cause.squash(exit.cause))).toBe(70);
  });

  test("a known error is rendered once and keeps its tag and exit code", async () => {
    const original = responseError({ bodyExcerpt: `echo ${canary}`, matched: "401", status: 401 });
    const { exit, stderr } = await runCatch(Effect.fail(original));
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

    expect(error).toBe(original);
    expect(Runtime.getErrorExitCode(error)).toBe(3);
    expect(Runtime.getErrorReported(error)).toBe(false);
    expect(stderr).not.toContain(canary);
    expect(stderr).toContain("<redacted:bearer>");
    expect(stderr.match(/users\.get/gu)).toHaveLength(1);
  });

  test("each known class keeps its exit code", async () => {
    const known = [
      [new UsageError({ message: "bad" }), 2],
      [new CredentialMissing({ alternatives: ["a"], operation: "op" }), 3],
      [new TransportError({ reason: "dns", url: "https://h" }), 4],
      [new OutputErrorClass({ path: "p", reason: "write" }), 5],
    ] as const;

    const codes = await Promise.all(
      known.map(async ([error]) => {
        const { exit } = await runCatch(Effect.fail(error));

        return Exit.isFailure(exit) ? Runtime.getErrorExitCode(Cause.squash(exit.cause)) : 0;
      }),
    );

    expect(codes).toEqual(known.map(([, code]) => code));
  });

  test("help with no parse errors passes through unprinted", async () => {
    const help = new CliError.ShowHelp({ commandPath: [], errors: [] });
    const { exit, stderr } = await runCatch(Effect.fail(help));

    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(help);
    expect(stderr).toBe("");
  });

  test("a parse error is rendered once, value-free, and keeps exit 1 (audit F5)", async () => {
    const invalid = new CliError.InvalidValue({
      expected: `Expected a port, got "${canary}"`,
      kind: "flag",
      option: "port",
      value: canary,
    });
    const help = new CliError.ShowHelp({ commandPath: ["cli"], errors: [invalid] });
    const { exit, stderr } = await runCatch(Effect.fail(help));
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

    expect(error).toBe(help);
    expect(Runtime.getErrorExitCode(error)).toBe(1);
    expect(Runtime.getErrorReported(error)).toBe(false);
    expect(stderr.match(/--port/gu)).toHaveLength(1);
    expect(stderr).not.toContain(canary);
    expect(stderr).not.toContain("Expected");
  });

  test("a CliError outside help is rendered once through the value-free formatter", async () => {
    const invalid = new CliError.InvalidValue({
      expected: canary,
      kind: "argument",
      option: "count",
      value: canary,
    });
    const { exit, stderr } = await runCatch(Effect.fail(invalid));

    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(invalid);
    expect(Runtime.getErrorReported(invalid)).toBe(false);
    expect(stderr.match(/<count>/gu)).toHaveLength(1);
    expect(stderr).not.toContain(canary);
  });

  test("an interrupt passes through unprinted", async () => {
    const { exit, stderr } = await runCatch(Effect.interrupt);

    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(stderr).toBe("");
  });
});

describe("a credential split by invisible characters is scrubbed (security review)", () => {
  test.each(["\u202E", "\u200B", "\u0001"])(
    "renderError and the excerpt redact a credential split by %#",
    async (split) => {
      const echo = `x CANARY-SECRET${split}-123 y`;
      const rendered = renderError(
        responseError({ bodyExcerpt: echo, requestId: echo, status: 401 }),
        [bearer],
      );
      const excerpt = await excerptWith(echo, defaultMaxErrorBytes, [bearer]);

      for (const output of [rendered, excerpt]) {
        expect(output).not.toContain("CANARY");
        expect(output).toContain("<redacted:bearer>");
      }
    },
  );
});

// Audit S2: a credential holding characters `sanitize` removes (U+00AD, the C1 NEL and the C0 SOH),
// which `auth.ts` accepts. The echo carries it as sent, then split by a bidi control.
const strippable = "CANARY\u00AD\u0085\u0001SECRET";

const strippableBearer: Credential = { ...bearer, value: Redacted.make(strippable) };

const strippableEcho = `x ${strippable} y CANARY\u202E\u00AD\u0085\u0001SECRET z`;

describe("credentials are scrubbed before the text is sanitized (audit S2, design 7.4)", () => {
  test("the body excerpt", async () => {
    const excerpt = await excerptWith(strippableEcho, defaultMaxErrorBytes, [strippableBearer]);

    expect(excerpt).toBe("x <redacted:bearer> y <redacted:bearer> z");
  });

  test("the request id line and the excerpt of a rendered error", () => {
    const rendered = renderError(
      responseError({ bodyExcerpt: strippableEcho, requestId: strippableEcho }),
      [strippableBearer],
    );

    expect(rendered.split("\n").slice(1)).toEqual([
      "Request ID: x <redacted:bearer> y <redacted:bearer> z",
      "x <redacted:bearer> y <redacted:bearer> z",
    ]);
  });

  test("a single line: the defect report", async () => {
    const { stderr } = await runCatch(Effect.die(strippableEcho), [strippableBearer]);

    expect(stderr).toContain("Error: x <redacted:bearer> y <redacted:bearer> z\n");
    expect(stderr).not.toMatch(/CANARY|SECRET/u);
  });

  test("the final report of a parse error", async () => {
    const unknown = new CliError.UnrecognizedOption({
      option: `--${strippableEcho}`,
      suggestions: [],
    });
    const { stderr } = await runCatch(Effect.fail(unknown), [strippableBearer]);

    expect(stderr).toContain("--x <redacted:bearer> y <redacted:bearer> z");
    expect(stderr).not.toMatch(/CANARY|SECRET/u);
  });
});

// Audit S2 residual: an earlier echo of the credential turns into a shorter placeholder and pulls
// the read's last bytes into the visible window; those bytes hold the credential, split by a
// stripped character and cut at the read budget.
describe("a credential split by a stripped character and cut at the budget (audit S2)", () => {
  for (const split of ["\u00AD", "\u0085", "\u0001"]) {
    test(`split by ${JSON.stringify(split)}`, async () => {
      const cut = `${longSecret.slice(0, 6)}${split}${longSecret.slice(6)}`;
      const excerpt = await excerptWith(`${longSecret}${cut}-tail`, longSecret.length, [
        longBearer,
      ]);

      expect(excerpt).toBe("<redacted:bearer>");
    });
  }
});

const created: OperationMeta = {
  media: { request: [], responses: { "201": ["application/json"] } },
  method: "POST",
  operationId: "widgets-create",
  pathTemplate: "/widgets",
  security: [],
};

const createRequest = Serialize.request("POST", {
  headers: [],
  path: Serialize.path("/widgets", []),
  query: [],
});

/**
 * Run `send` once with `--output <target>` against a scripted client that counts the requests it
 * receives; `onRequest` runs inside the client before it answers 201 with `{"id":"w1"}`.
 */
const sendTo = async (
  target: string,
  settings: { readonly dryRun?: boolean; readonly force?: boolean } = {},
  onRequest: Effect.Effect<void> = Effect.void,
) => {
  const requests = { count: 0 };
  const client = HttpClient.make((sent) =>
    Effect.gen(function* answer() {
      requests.count += 1;
      yield* onRequest;

      return HttpClientResponse.fromWeb(
        sent,
        new Response('{"id":"w1"}', {
          headers: { "content-type": "application/json" },
          status: 201,
        }),
      );
    }),
  );
  const environment = Layer.mergeAll(
    BaseUrl.layer(
      {
        boundOrigins: ["https://api.example.com"],
        defaultServer: 0,
        servers: [{ url: "https://api.example.com", variables: {} }],
      },
      "EXAMPLE",
    ),
    Auth.layer({ schemes: {} }, "EXAMPLE"),
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({})),
    BunFileSystem.layer,
    BunPath.layer,
    Stdio.layerTest({}),
    Input.stdinClaimLayer,
    runCredentialsLayer,
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(ClientPolicy, {
      allowed: new Set(["POST"]),
      binName: "example",
      direct: {},
      version: "1.2.3",
    }),
    Layer.succeed(OutputPath, Option.some(target)),
    Layer.succeed(Force, settings.force ?? false),
    Layer.succeed(dryRunSetting, settings.dryRun ?? false),
    Layer.succeed(MaxErrorBytes, defaultMaxErrorBytes),
    Layer.succeed(BaseUrl.baseUrlSetting, Option.none()),
    Layer.succeed(BaseUrl.serverSetting, Option.none()),
    Layer.succeed(BaseUrl.serverVariableSetting, []),
    Layer.succeed(Auth.allowCredentialsForBaseUrl, false),
  );
  const exit = await Effect.runPromise(
    Effect.exit(createRequest.pipe(Effect.flatMap(send(created)))).pipe(
      Effect.provide(environment),
    ),
  );

  return { exit, requests: requests.count };
};

const readText = (fs: FileSystem.FileSystem, target: string) =>
  Effect.runPromise(fs.readFileString(target).pipe(Effect.provide(BunFileSystem.layer)));

const writeText = (fs: FileSystem.FileSystem, target: string, text: string) =>
  Effect.runPromise(fs.writeFileString(target, text).pipe(Effect.provide(BunFileSystem.layer)));

// HB4: the target is checked before the request is sent, so a refused --output never discards
// the answer of a request that took effect.
describe("--output through send", () => {
  test("an existing target without --force is refused before any request is sent", async () => {
    await inDir(async (dir, fs, path) => {
      const target = path.join(dir, "out.json");
      await writeText(fs, target, "keep");
      const result = await sendTo(target);
      expect(reasonOf(failure(result.exit))).toBe("exists");
      expect(result.requests).toBe(0);
      expect(await readText(fs, target)).toBe("keep");
    });
  });

  test("--force sends one request and replaces the existing target", async () => {
    await inDir(async (dir, fs, path) => {
      const target = path.join(dir, "out.json");
      await writeText(fs, target, "old");
      const result = await sendTo(target, { force: true });
      expect(Exit.isSuccess(result.exit)).toBe(true);
      expect(result.requests).toBe(1);
      expect(await readText(fs, target)).toBe('{"id":"w1"}');
    });
  });

  test("a target created after the check, while the request runs, is still refused by link", async () => {
    await inDir(async (dir, fs, path) => {
      const target = path.join(dir, "out.json");
      const racer = fs.writeFileString(target, "racer").pipe(Effect.orDie);
      const result = await sendTo(target, {}, racer.pipe(Effect.provide(BunFileSystem.layer)));
      expect(reasonOf(failure(result.exit))).toBe("exists");
      expect(result.requests).toBe(1);
      expect(await readText(fs, target)).toBe("racer");
      expect(
        await Effect.runPromise(fs.readDirectory(dir).pipe(Effect.provide(BunFileSystem.layer))),
      ).toEqual(["out.json"]);
    });
  });

  test("--dry-run with an existing target sends nothing and is not refused", async () => {
    await inDir(async (dir, fs, path) => {
      const target = path.join(dir, "out.json");
      await writeText(fs, target, "keep");
      const result = await sendTo(target, { dryRun: true });
      expect(Exit.isSuccess(result.exit)).toBe(true);
      expect(result.requests).toBe(0);
      expect(await readText(fs, target)).toBe("keep");
    });
  });
});
