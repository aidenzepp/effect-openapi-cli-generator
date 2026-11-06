import { BunFileSystem } from "@effect/platform-bun";
import { afterEach, describe, expect, test } from "bun:test";
import { ByteSize, Effect, FileSystem, Schema } from "effect";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  defaultLimits,
  readFileBounded,
  readMemberBounded,
  refuse,
} from "../../src/load/budget.ts";
import type { VerifyOpened } from "../../src/load/budget.ts";
import { DocumentUri } from "../../src/model/brands.ts";

const scratch = path.join(import.meta.dir, "..", "..", "work");

const made: string[] = [];

const directory = () => {
  mkdirSync(scratch, { recursive: true });

  const base = realpathSync(mkdtempSync(path.join(scratch, "budget-")));

  made.push(base);

  return base;
};

afterEach(() => {
  for (const base of made.splice(0)) {
    rmSync(base, { force: true, recursive: true });
  }
});

const document = Schema.decodeUnknownSync(DocumentUri)("https://example.com/doc.json");

const read = (
  file: string,
  verify: VerifyOpened = () => Effect.void,
  maxBytes = defaultLimits.maxBytes,
) =>
  readMemberBounded(file, { ...defaultLimits, maxBytes }, document, verify).pipe(
    Effect.provide(BunFileSystem.layer),
  );

const refusal = (effect: ReturnType<typeof read>) => Effect.runPromise(Effect.flip(effect));

describe("readMemberBounded", () => {
  test("reads a regular file's bytes from the handle it checked", async () => {
    const file = path.join(directory(), "a.json");
    let seen: FileSystem.File.Info | undefined;

    writeFileSync(file, '{"a":1}');

    const bytes = await Effect.runPromise(
      read(file, (opened) =>
        Effect.sync(() => {
          seen = opened;
        }),
      ),
    );

    expect(new TextDecoder().decode(bytes)).toBe('{"a":1}');
    expect(seen?.type).toBe("File");
    expect(seen === undefined ? undefined : ByteSize.toBigInt(seen.size)).toBe(7n);
  });

  test("a symlink at the final component is refused unread", async () => {
    const base = directory();
    const target = path.join(base, "target.json");
    const link = path.join(base, "link.json");

    writeFileSync(target, "{}");
    symlinkSync(target, link);

    const error = await refusal(read(link));

    expect(error.diagnostic.code).toBe("DOC-14/unreadable");
    expect(error.diagnostic.scope).toBe("document");
  });

  test("a directory is refused unread", async () => {
    const error = await refusal(read(directory()));

    expect(error.diagnostic.code).toBe("DOC-14/unreadable");
  });

  test("the open handle's size is checked against maxBytes before reading", async () => {
    const file = path.join(directory(), "big.json");
    let verified = false;

    writeFileSync(file, "{}".padEnd(64, " "));

    const error = await refusal(
      read(
        file,
        () =>
          Effect.sync(() => {
            verified = true;
          }),
        32,
      ),
    );

    expect(error.diagnostic.code).toBe("DOC-14/too-large");
    expect(verified).toBe(false);
  });

  test("a verify refusal leaves the file unread", async () => {
    const file = path.join(directory(), "a.json");

    writeFileSync(file, "{}");

    const error = await refusal(read(file, () => refuse(document, "DOC-14/unreadable")));

    expect(error.diagnostic.code).toBe("DOC-14/unreadable");
  });
});

const readOperator = (file: string, hook?: (path: string) => void) =>
  Effect.gen(function* withHook() {
    const fs = yield* FileSystem.FileSystem;
    const hooked: FileSystem.FileSystem = {
      ...fs,
      open: (opened, options) =>
        Effect.suspend(() => {
          hook?.(opened);

          return fs.open(opened, options);
        }),
    };

    return yield* readFileBounded(file, defaultLimits, document).pipe(
      Effect.provideService(FileSystem.FileSystem, hooked),
    );
  }).pipe(Effect.provide(BunFileSystem.layer));

describe("readFileBounded: an operator's path", () => {
  test("a symlinked path loads the file it names", async () => {
    const base = directory();
    const target = path.join(base, "target.json");
    const link = path.join(base, "link.json");

    writeFileSync(target, '{"a":1}');
    symlinkSync(target, link);

    const bytes = await Effect.runPromise(readOperator(link));

    expect(new TextDecoder().decode(bytes)).toBe('{"a":1}');
  });

  test("a file swapped in between the pre-open stat and the open is refused by dev/ino", async () => {
    const base = directory();
    const target = path.join(base, "target.json");
    const other = path.join(base, "other.json");
    const link = path.join(base, "link.json");
    let opened: string | undefined;

    writeFileSync(target, '{"a":1}');
    writeFileSync(other, '{"b":2}');
    symlinkSync(target, link);

    const error = await Effect.runPromise(
      Effect.flip(
        readOperator(link, (file) => {
          opened = file;
          renameSync(other, target);
        }),
      ),
    );

    expect(opened).toBe(target);
    expect(error.diagnostic.code).toBe("DOC-14/unreadable");
  });
});
