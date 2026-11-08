import { Array as Arr, Order, Schema } from "effect";
import { DocumentUri, JsonPointer } from "./brands.ts";

const codePattern = /^(?<row>[A-Z][A-Z0-9]*-[0-9]+)\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

const rowPattern = /^[A-Z][A-Z0-9]*-[0-9]+$/u;

const Code = Schema.String.pipe(Schema.check(Schema.isPattern(codePattern)));

const Row = Schema.String.pipe(Schema.check(Schema.isPattern(rowPattern)));

const Position = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)));

const rowOfCode = (code: string): string | undefined => codePattern.exec(code)?.groups?.row;

/**
 * The use site or target of a diagnostic: a document and an RFC 6901 pointer.
 */
export const Site = Schema.Struct({
  document: DocumentUri,
  pointer: JsonPointer,
});

/**
 * The operation a diagnostic concerns.
 */
export const DiagnosticOperation = Schema.Struct({
  method: Schema.String,
  operationId: Schema.optionalKey(Schema.String),
  path: Schema.String,
});

/**
 * One refusal or notice, shared by the report, the verdict file and `--describe` (design 8.1).
 */
export class Diagnostic extends Schema.Class<Diagnostic>("Diagnostic")(
  Schema.Struct({
    code: Code,
    column: Schema.optionalKey(Position),
    document: DocumentUri,
    element: Schema.String,
    hint: Schema.optionalKey(Schema.String),
    line: Schema.optionalKey(Position),
    message: Schema.String,
    openapi: Schema.String,
    operation: Schema.optionalKey(DiagnosticOperation),
    pointer: JsonPointer,
    related: Schema.optionalKey(Schema.Array(Site)),
    row: Row,
    // `field` (design 8.5): one property of a request body alternative that stays generated.
    scope: Schema.Literals(["document", "operation", "element", "field"]),
    severity: Schema.Literals(["refusal", "notice"]),
    specSection: DocumentUri,
    wire: Schema.optionalKey(Schema.String),
  }).check(
    Schema.makeFilter(
      (fields) => rowOfCode(fields.code) === fields.row || "code must start with its row id",
    ),
  ),
) {}

const isIndex = (token: string): boolean => /^(?:0|[1-9][0-9]*)$/u.test(token);

const tokenOrder = Order.make<string>((left, right) =>
  isIndex(left) && isIndex(right)
    ? Order.Number(Number(left), Number(right))
    : Order.String(left, right),
);

/**
 * Diagnostic pointer order (design 3.7): JSON Pointers compare token by token, array indices
 * numerically and every other token as a string.
 */
export const pointerOrder: Order.Order<string> = Order.mapInput(
  Order.Array(tokenOrder),
  (pointer: string): readonly string[] => pointer.split("/").slice(1),
);

/**
 * Orders diagnostics by document index in `documents`, then pointer, then code (design 3.7).
 * Pointers compare token by token, array indices numerically. A document outside `documents` sorts
 * last.
 */
export const sortDiagnostics = (
  documents: readonly string[],
  diagnostics: readonly Diagnostic[],
): readonly Diagnostic[] => {
  const documentIndex = (diagnostic: Diagnostic): number => {
    const index = documents.indexOf(diagnostic.document);

    return index === -1 ? documents.length : index;
  };

  const order = Order.combineAll([
    Order.mapInput(Order.Number, documentIndex),
    Order.mapInput(pointerOrder, (diagnostic: Diagnostic) => diagnostic.pointer),
    Order.mapInput(Order.String, (diagnostic: Diagnostic) => diagnostic.code),
  ]);

  return Arr.sort(diagnostics, order);
};
