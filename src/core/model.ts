/**
 * The original supported HTTP verbs; command spelling never changes this value.
 */
export type HttpMethod = "GET" | "PUT" | "POST" | "DELETE" | "OPTIONS" | "HEAD" | "PATCH" | "TRACE";

/**
 * An uncoerced JSON primitive accepted by scalar enum constraints.
 */
export type JsonScalar = string | number | boolean | null;

/**
 * Source annotations retained for generated help, JSDoc, and deprecation metadata.
 */
export interface Documentation {
  readonly title?: string;
  readonly description?: string;
  readonly deprecated?: boolean;
  readonly externalDocs?: { readonly url: string; readonly description?: string };
}

/**
 * The supported validation contract, retaining original property names and JSON domains.
 */
export type WireSchema = {
  readonly docs: Documentation;
  readonly reference?: { readonly pointer: string; readonly schema: WireSchema };
  readonly checks?: readonly { readonly name: string; readonly value: number | string }[];
} & (
  | {
      readonly kind: "oneOf" | "union";
      readonly nullable: false;
      readonly members: readonly WireSchema[];
    }
  | {
      readonly kind: "string" | "boolean" | "integer" | "number" | "null";
      readonly nullable: boolean;
      readonly enum: readonly JsonScalar[] | undefined;
    }
  | { readonly kind: "json"; readonly nullable: true }
  | { readonly kind: "array"; readonly nullable: boolean; readonly items: WireSchema }
  | {
      readonly kind: "object";
      readonly nullable: boolean;
      readonly properties: readonly {
        readonly name: string;
        readonly required: boolean;
        readonly schema: WireSchema;
      }[];
      readonly additionalProperties: boolean | WireSchema;
    }
);

/**
 * A scalar request parameter whose wire identity remains separate from its CLI binding.
 */
export interface Parameter {
  readonly wireName: string;
  readonly flagName: string;
  readonly location: "path" | "query" | "header";
  readonly required: boolean;
  readonly schema: WireSchema;
  readonly docs: Documentation;
  readonly binding: "flag" | "argument";
  readonly explode?: boolean;
}

/**
 * A multipart property and its explicit command-line transport representation.
 */
export interface MultipartField {
  readonly name: string;
  readonly flagName: string;
  readonly required: boolean;
  readonly schema: WireSchema;
  readonly kind: "file" | "files" | "text";
}

/**
 * A selected command projection with the original HTTP method, path, and request schema.
 */
export interface Operation {
  readonly commandPath: readonly string[];
  readonly operationId: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly parameters: readonly Parameter[];
  readonly docs: Documentation;
  readonly security: SecurityRequirement | undefined;
  readonly body:
    | {
        readonly required: boolean;
        readonly schema: WireSchema;
        readonly multipart?: {
          readonly fields: readonly MultipartField[];
          readonly additionalFields: boolean;
        };
      }
    | undefined;
}

/**
 * The normalized API and deterministically ordered operations consumed by source emission.
 */
export interface ApiModel {
  readonly title: string;
  readonly description: string | undefined;
  readonly operations: readonly Operation[];
}

/**
 * A metadata-derived command address independent of HTTP request semantics.
 */
export interface CommandProjection {
  readonly commandPath: readonly string[];
}

/**
 * Optional naming choices for the standalone generated executable.
 */
export interface GenerateOptions {
  readonly name?: string;
}

/**
 * A relative output path and its complete formatted file content.
 */
export interface GeneratedFile {
  readonly path: string;
  readonly content: string;
}

/**
 * The standalone package files returned without performing filesystem operations.
 */
export interface GeneratedApplication {
  readonly files: readonly GeneratedFile[];
}

/**
 * An effective, supported security requirement; values remain runtime credentials.
 */
export type SecurityRequirement = {
  readonly key: string;
  readonly flagName: string;
  readonly docs: Documentation;
} & (
  | { readonly kind: "bearer" | "basic" }
  | {
      readonly kind: "apiKey";
      readonly location: "header" | "query" | "cookie";
      readonly name: string;
    }
);
