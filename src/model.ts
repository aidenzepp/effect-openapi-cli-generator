export type HttpMethod = "GET" | "PUT" | "POST" | "DELETE" | "OPTIONS" | "HEAD" | "PATCH" | "TRACE";
export type JsonScalar = string | number | boolean | null;
export interface Documentation {
  readonly title?: string;
  readonly description?: string;
  readonly deprecated?: boolean;
  readonly externalDocs?: { readonly url: string; readonly description?: string };
}
export type WireSchema = { readonly docs: Documentation } & (
  | {
      readonly kind: "string" | "boolean" | "integer" | "number" | "null";
      readonly nullable: boolean;
      readonly enum: readonly JsonScalar[] | undefined;
    }
  | { readonly kind: "array"; readonly nullable: boolean; readonly items: WireSchema }
  | {
      readonly kind: "object";
      readonly nullable: boolean;
      readonly properties: readonly {
        readonly name: string;
        readonly required: boolean;
        readonly schema: WireSchema;
      }[];
      readonly additionalProperties: boolean;
    }
);
export interface Parameter {
  readonly wireName: string;
  readonly flagName: string;
  readonly location: "path" | "query";
  readonly required: boolean;
  readonly schema: WireSchema;
  readonly docs: Documentation;
  readonly binding: "flag" | "argument";
}
export interface Operation {
  readonly commandPath: readonly string[];
  readonly operationId: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly parameters: readonly Parameter[];
  readonly docs: Documentation;
  readonly body: { readonly required: boolean; readonly schema: WireSchema } | undefined;
}
export interface ApiModel {
  readonly title: string;
  readonly description: string | undefined;
  readonly operations: readonly Operation[];
}
export interface CommandProjection {
  readonly commandPath: readonly string[];
}

export interface GenerateOptions {
  readonly name?: string;
}
export interface GeneratedFile {
  readonly path: string;
  readonly content: string;
}
export interface GeneratedApplication {
  readonly files: readonly GeneratedFile[];
}
