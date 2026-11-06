import { Effect, Schema } from "effect";
import type { FileSystem } from "effect";
import { pathToFileURL } from "node:url";
import { DocumentUri } from "../model/brands.ts";
import { Diagnostic } from "../model/diagnostic.ts";
import { LoadRefusal } from "./budget.ts";
import { loadFile } from "./index.ts";
import type { Loaded } from "./index.ts";

type Document = typeof DocumentUri.Type;

/**
 * One `--document <uri>=<path>` pair: the retrieval URI the operator gives and the file that holds
 * the document.
 */
export interface DocumentPair {
  readonly path: string;
  readonly uri: string;
}

export interface SetMember extends Loaded {
  readonly path: string;
}

/**
 * The documents `$ref` may resolve over, keyed by retrieval URI (design 3.3).
 */
export interface DocumentSet {
  readonly documents: ReadonlyMap<Document, SetMember>;
}

/**
 * Most documents one set holds (design 3.3 budgets).
 */
export const maxDocuments = 32;

const messages = {
  "REF-16/document-limit": "The document set holds more documents than the limit allows.",
  "REF-16/duplicate-uri": "Two documents in the set share a retrieval URI.",
  "REF-16/relative-uri": "A document's retrieval URI is not an absolute URI.",
} as const;

const decodeUri = Schema.decodeUnknownOption(DocumentUri);

/**
 * Splits `<uri>=<path>` at the first `=`. A value with no `=` yields a pair with an empty path,
 * which the loader then refuses as unreadable.
 */
export const parseDocumentPair = (value: string): DocumentPair => {
  const split = value.indexOf("=");

  return split === -1
    ? { path: "", uri: value }
    : { path: value.slice(split + 1), uri: value.slice(0, split) };
};

const refuse = (code: keyof typeof messages, pair: DocumentPair) =>
  Schema.decodeUnknownEffect(Diagnostic)({
    code,
    document: decodeUri(pair.uri)._tag === "Some" ? pair.uri : pathToFileURL(pair.path).href,
    element: "document",
    hint: pair.path,
    message: messages[code],
    openapi: "unknown",
    pointer: "",
    row: "REF-16",
    scope: "document",
    severity: "refusal",
    specSection: "https://spec.openapis.org/oas/v3.2.1.html#establishing-the-base-uri",
  }).pipe(
    Effect.orDie,
    Effect.flatMap((diagnostic) => Effect.fail(new LoadRefusal({ diagnostic }))),
  );

const withPath = (refusal: LoadRefusal, path: string): LoadRefusal => {
  const diagnostic = Schema.decodeUnknownSync(Diagnostic)({
    ...Schema.encodeSync(Diagnostic)(refusal.diagnostic),
    hint: path,
  });

  return new LoadRefusal(
    refusal.offset === undefined ? { diagnostic } : { diagnostic, offset: refusal.offset },
  );
};

const loadPair = (
  documents: ReadonlyMap<Document, SetMember>,
  pair: DocumentPair,
): Effect.Effect<readonly [Document, SetMember], LoadRefusal, FileSystem.FileSystem> => {
  const uri = decodeUri(pair.uri);

  if (uri._tag === "None") {
    return refuse("REF-16/relative-uri", pair);
  }

  if (documents.has(uri.value)) {
    return refuse("REF-16/duplicate-uri", pair);
  }

  return loadFile(pair.path, { document: uri.value }).pipe(
    Effect.map((loaded): readonly [Document, SetMember] => [
      uri.value,
      { ...loaded, path: pair.path },
    ]),
    Effect.mapError((refusal) => withPath(refusal, pair.path)),
  );
};

/**
 * Loads every pair through the bounded loader, in order, into a set keyed by retrieval URI. The
 * first refusal ends the load; every refusal is a document-scope diagnostic whose `hint` is the
 * offending pair's path, never the file's content.
 */
export const makeDocumentSet = (
  pairs: readonly DocumentPair[],
): Effect.Effect<DocumentSet, LoadRefusal, FileSystem.FileSystem> =>
  Effect.gen(function* load() {
    const overflow = pairs[maxDocuments];

    if (overflow !== undefined) {
      return yield* refuse("REF-16/document-limit", overflow);
    }

    const documents = new Map<Document, SetMember>();

    for (const pair of pairs) {
      const [uri, member] = yield* loadPair(documents, pair);

      documents.set(uri, member);
    }

    return { documents };
  });
