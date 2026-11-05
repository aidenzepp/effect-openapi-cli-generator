import { Context, Effect, FileSystem, Layer, Option, Ref, Stdio, Stream } from "effect";
import { Flag } from "effect/cli";
import { HttpBody } from "effect/http";
import { UsageError } from "../domain/errors.ts";
import { FileBody } from "./file-body.ts";

/**
 * Ceiling for a body read from `--body-file`, a file or stdin, in bytes. A runtime choice: design
 * I5 says only "bounded". It matches the 64 MiB the generator proposes for a specification (§3).
 */
export const maxBodyBytes = 67_108_864;

const bodyFileName = "body-file";

const encoder = new TextEncoder();

/**
 * Whole request body as text; field flags override it.
 */
export const bodyFlag = Flag.String("body").pipe(
  Flag.optional,
  Flag.withDescription("Whole request body; field flags override it"),
);

/**
 * Whole request body from a file, or from stdin when the value is `-`. `Flag.String` keeps `-`
 * literal, so no path fix-up is needed here.
 */
export const bodyFileFlag = Flag.String(bodyFileName).pipe(
  Flag.withMetavar("path|-"),
  Flag.optional,
  Flag.withDescription("Whole request body from a file or stdin"),
);

/**
 * The invocation's single stdin claim (design 4.5, C1). `claim` succeeds once per layer and then
 * refuses every later claimant with a `UsageError` that names flags only.
 */
export class StdinClaim extends Context.Service<
  StdinClaim,
  { readonly claim: (flag: string) => Effect.Effect<void, UsageError> }
>()("runtime/StdinClaim") {}

/**
 * A fresh claim for one invocation. The root `services` layer provides it once.
 */
export const stdinClaimLayer: Layer.Layer<StdinClaim> = Layer.effect(
  StdinClaim,
  Effect.gen(function* build() {
    const holder = yield* Ref.make(Option.none<string>());

    return {
      claim: (flag) =>
        Ref.modify(holder, (held) =>
          Option.isSome(held) ? [held, held] : [Option.none<string>(), Option.some(flag)],
        ).pipe(
          Effect.flatMap((first) =>
            Option.isSome(first)
              ? Effect.fail(
                  new UsageError({
                    flag,
                    message: `--${flag}: standard input is already read by --${first.value}`,
                  }),
                )
              : Effect.void,
          ),
        ),
    };
  }),
);

const usage = (flag: string, cause: string): UsageError =>
  new UsageError({ flag, message: `--${flag}: ${cause}` });

const cannotRead = (): UsageError => usage(bodyFileName, "cannot read the file or stdin");

const overLimit = (): UsageError => usage(bodyFileName, `the body is over ${maxBodyBytes} bytes`);

class OverLimit {
  readonly _tag = "OverLimit";
}

class ReadFailed {
  readonly _tag = "ReadFailed";
}

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  let size = 0;
  for (const chunk of chunks) {
    size += chunk.length;
  }

  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }

  return joined;
};

const bounded = (
  source: Stream.Stream<Uint8Array, unknown>,
): Stream.Stream<Uint8Array, OverLimit | ReadFailed> =>
  source.pipe(
    Stream.mapError((): OverLimit | ReadFailed => new ReadFailed()),
    Stream.limitBytes(maxBodyBytes, (): Stream.Stream<Uint8Array, OverLimit | ReadFailed> =>
      Stream.fail(new OverLimit()),
    ),
  );

/**
 * Reads `--body-file` into memory, bounded: a file by path, or stdin for `-` (which takes the one
 * stdin claim). Failures name the flag, never the path or the file-system cause (design 4.6).
 */
export const readBodyFile = (
  path: string,
): Effect.Effect<Uint8Array, UsageError, FileSystem.FileSystem | Stdio.Stdio | StdinClaim> =>
  Effect.gen(function* read() {
    const source =
      path === "-"
        ? yield* Effect.service(StdinClaim).pipe(
            Effect.flatMap((claim) => claim.claim(bodyFileName)),
            Effect.flatMap(() => Effect.service(Stdio.Stdio)),
            Effect.map((stdio) => stdio.stdin),
          )
        : yield* Effect.service(FileSystem.FileSystem).pipe(
            Effect.map((fs) => fs.stream(path, { bytesToRead: maxBodyBytes + 1 })),
          );

    return yield* bounded(source).pipe(
      Stream.runCollect,
      Effect.map(concat),
      Effect.mapError((cause) => (cause instanceof OverLimit ? overLimit() : cannotRead())),
    );
  });

const openFile = (path: string): Effect.Effect<HttpBody.HttpBody, UsageError, FileBody> =>
  Effect.service(FileBody).pipe(
    Effect.flatMap((fileBody) => fileBody.open(path)),
    Effect.mapError(cannotRead),
    Effect.filterOrFail(
      (body) => !(body._tag === "Stream" && (body.contentLength ?? 0) > maxBodyBytes),
      overLimit,
    ),
  );

const openStdin = (): Effect.Effect<HttpBody.HttpBody, UsageError, Stdio.Stdio | StdinClaim> =>
  Effect.service(StdinClaim).pipe(
    Effect.flatMap((claim) => claim.claim(bodyFileName)),
    Effect.flatMap(() => Effect.service(Stdio.Stdio)),
    Effect.map((stdio) => HttpBody.stream(bounded(stdio.stdin))),
  );

/**
 * A binary request body from `--body-file` only: a file through `FileBody`, or stdin as a chunked
 * stream. `--body` is refused, and so is `--body` together with `--body-file`. With neither flag a
 * required body is `{}` and an optional one is empty.
 */
export const binaryBody = (options: {
  readonly body: Option.Option<string>;
  readonly bodyFile: Option.Option<string>;
  readonly required: boolean;
}): Effect.Effect<HttpBody.HttpBody, UsageError, FileBody | Stdio.Stdio | StdinClaim> => {
  if (Option.isSome(options.body)) {
    return Effect.fail(
      usage(
        "body",
        Option.isSome(options.bodyFile)
          ? `cannot be used with --${bodyFileName}`
          : `this request body is binary; use --${bodyFileName}`,
      ),
    );
  }

  if (Option.isNone(options.bodyFile)) {
    return Effect.succeed(
      options.required ? HttpBody.uint8Array(encoder.encode("{}")) : HttpBody.empty,
    );
  }

  return options.bodyFile.value === "-" ? openStdin() : openFile(options.bodyFile.value);
};
