# OpenAPI JSON to Effect CLI: first implementation

## Purpose and agreed direction

Build a package that generates inspectable, standalone TypeScript CLI applications from OpenAPI JSON. Generated applications use Effect's CLI library for commands, flags, help, parsing, and validation, and Effect services for HTTP, files, errors, and runtime execution. They must not require this generator package at runtime.

OpenAPI JSON is the primary input. A future Effect HttpApi adapter will export an owned API to OpenAPI and call the same generator. It will not introduce a second generation pipeline.

The user approved starting with an end-to-end slice: read a document, generate Effect CLI source, build it, and verify the generated command sends the correct request. This spec makes the proposed conventions and supported subset explicit for review.

## Architecture

```mermaid
flowchart LR
  JSON[OpenAPI JSON] --> Parse[Decode and validate supported input]
  Parse --> Model[Normalized operations and wire schemas]
  Model --> Emit[Emit Effect CLI TypeScript]
  Emit --> Package[Standalone application source and package metadata]
  HttpApi[Future owned Effect HttpApi] -->|Export OpenAPI| Parse
```

Use one package and a small source directory. Separate input decoding, operation normalization, and source emission where their responsibilities differ; do not create workspace packages or speculative infrastructure.

Provide a library generation entry point returning generated files through an Effect with typed errors. A thin generator CLI reads a local JSON file and writes those files to an explicitly selected output directory. Keep filesystem access outside normalization and emission. Refuse to overwrite an existing output target.

Generated output includes TypeScript source, package metadata, and a TypeScript configuration with explicit build and run scripts. Target the installed Effect 4 APIs, including `effect/cli`, and the Node platform runtime. Keep this repository private; publication is outside this stage.

## Supported input

- OpenAPI 3.0.x and 3.1.x JSON documents, interpreted according to their version.
- Explicit `operationId` on every operation. Derive a flat command name by splitting camel case, converting underscores to hyphens, and lowercasing. Reject missing identifiers, names that cannot form safe CLI tokens, and collisions.
- Local JSON Pointer references to reusable parameters, request bodies, and schemas. Decode pointer escaping correctly. Reject unresolved, external, and recursive references in this slice.
- Primitive string, boolean, integer, and number path and query parameters. Support string enums and required/optional query parameters. Path parameters must be required and match the path template.
- Path `simple` serialization and query `form` serialization for those primitives, using specification defaults when omitted. Reject other serialization styles, arrays or objects in parameters, and unsupported parameter locations.
- JSON request bodies with schemas composed of primitives, objects, arrays, required fields, enums, and explicit additional-property behavior. Support nullable values according to the OpenAPI version. Preserve schema restrictions only when they can be represented faithfully; reject unsupported schema keywords that affect validation rather than drop them.
- Optional and required request bodies. Select `application/json` explicitly; reject unsupported request media types.

Validate the entire input before emitting files. Unrecognized descriptive metadata may be ignored; request-affecting features may not be ignored. Reject unsupported security requirements, callbacks, and links in this slice. Response schemas are not converted into typed clients in this stage; responses are handled as wire data.

Errors identify the input location, unsupported feature or invalid value, and the supported alternative where one exists. No operation is silently skipped.

## Generated CLI behavior

- Use `Command.make` and subcommands from Effect CLI. Generate each operation as an explicit command definition and handler rather than interpret the whole OpenAPI document at startup.
- Use native typed flags for each supported path and query parameter. Expose parameters as named flags, normalize flag spelling independently of wire names, and reject collisions with other parameters or reserved flags.
- Derive help from operation summaries/descriptions and parameter descriptions. Let Effect CLI provide usage, help, parsing errors, and command dispatch.
- Keep the OpenAPI HTTP method and original path separate from the command name. A command named `get-report` may issue POST if that is the defined method.
- Require an explicit shared `--base-url` HTTP(S) URL. Do not guess a server from the OpenAPI document. Preserve a supplied base path when appending operation paths and serialize path/query values with correct encoding.
- For JSON bodies, expose mutually exclusive `--body` and `--body-file`. Read files through Effect FileSystem, parse JSON, and validate using generated Effect schemas before issuing HTTP. Require one input for a required body; omit the body entirely when an optional body is absent.
- Preserve wire property names and values. Validation must not strip unknown fields, coerce values, apply defaults, or otherwise transform the request silently.
- Use Effect HttpClient and HTTP body APIs, providing the appropriate client and platform layers at the entry point. Do not invent a CLI parser or use ad hoc fetch and filesystem wrappers.
- Print the response body to stdout without interpreting it through a generated response schema. Report transport errors and non-success HTTP statuses as typed failures with useful status/body information and a nonzero exit. Handle empty response bodies successfully. Use stderr for diagnostics.
- Let the Effect runtime handle interruption and resource cleanup.

"Optimal Effect CLI code" means idiomatic use of the library's existing capabilities, readable direct definitions, faithful requests, and minimal generated runtime machinery. It does not mean choosing shorter output at the expense of correctness.

## Verification and acceptance

1. Unit tests exercise naming/collisions, reference resolution, version-sensitive schema interpretation, unsupported-feature diagnostics, and serialization.
2. Generation is deterministic for identical input and options. Treat API strings as data when emitting source; test quotes, newlines, and source-like strings.
3. Build a generated application in a temporary directory against its declared dependencies, then execute its built entry point. This proves current generated output is usable independently of the generator.
4. A local test server checks the actual method, encoded path, query, content type, and JSON body, including an operation whose name suggests a different verb.
5. Integration checks cover help, missing required flags, omitted optional query/body values, mutually exclusive body inputs, malformed JSON, schema-invalid bodies, empty successful responses, HTTP failures, and interruption.
6. Package build checks verify its library exports and executable entry point. Include source and tests in TypeScript checking; run `bun run check` and relevant targeted checks.
7. Update README with the implemented subset and actual usage. Commit completed implementation locally and report the hash and checks.

## Deferred scope

HttpApi shorthand, overlays, authentication configuration, remote specification fetching, YAML, external references, recursive schemas, complex parameter serialization, multipart/file uploads, response client generation, npm publication, and deployment are deferred. No example application, benchmark suite, or infrastructure is added.

## Delivery boundary

Review this spec before the implementation plan. The plan will establish the exact public function signatures, command invocation, supported schema-keyword matrix, generated file names, and targeted test commands without expanding the above scope.
