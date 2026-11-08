# Project direction

`effect-openapi-cli-generator` reads an OpenAPI 3.0, 3.1 or 3.2 document and writes the source of a standalone command-line application built on Effect and Bun. Each API operation becomes a command. A later input adapter will read Effect `HttpApi` definitions into the same pipeline.

This file is the committed direction: what the generator does, how it is built, and what a generated CLI guarantees. The full design, with the alternatives, reasons and sources behind each item, is kept outside the repository. If code and this file disagree, correct one of them in the same change.

## Status labels

Each section carries one or more labels:

- **decided**: chosen by the design and accepted.
- **measured**: decided by a measurement against the pinned toolchain or a real API specification.
- **provisional**: waits on a named measurement and changes only when that measurement reports.
- **operator default**: applies until the project owner decides otherwise.

## Terms

- **Model**: the normalized description of an API that sits between input adapters and the emitter.
- **Trust boundary**: the line the model draws. A value taken from the input specification enters the model only after a `Schema` codec has decoded it into a branded value or a `Schema.Class` entity. Naming, emission and writing read the model only, never the source document, so a reviewer can check by import graph that no emitter reads untrusted input.
- **Document set**: the files the operator names for one generation run. `$ref` resolution reaches only these files.
- **Author config**: a JSON file the API author passes to the generator. It holds overrides, accepted servers and origins, defaults, extra security schemes and custom commands.
- **Refusal**: a diagnostic for input the generator will not implement. Its scope says what is omitted: `document` (nothing is generated), `operation` (that operation is omitted) or `element` (that element, such as one parameter or one security scheme, is omitted and the rest is generated). A **notice** records a choice or a loss that does not omit anything.
- **Corpus**: the pinned public API specifications the project generates against on every change.

## Pipeline

Labels: decided; the JSON and YAML parsers are measured.

The OpenAPI adapter runs one stage per directory under `src/`:

1. **load**: JSON through `JSON.parse` plus a scanner that rejects duplicate keys, or strict YAML 1.2 through `yaml` plus a check after parsing. Both run under size, depth and node budgets.
2. **validate**: against the OpenAPI Initiative's official JSON Schema for the document's line (3.0, 3.1 or 3.2). Where that schema and the specification text disagree, the text wins. Each such disagreement is listed, with its reason, in a table the validator owns.
3. **resolve**: `$ref` resolution over the document set, without network access.
4. **check**: the rules in the specification text that no JSON Schema expresses.
5. **normalize**: builds the model.
6. **names**: plans command, flag and identifier names.
7. **emit**: prints the generated source from the model.
8. **write**: writes the generated package.
9. **report**: prints diagnostics and writes the generation report and the corpus verdict.

The later `HttpApi` adapter reads a definition with `HttpApi.reflect` and lowers its schemas with `Schema.toJsonSchemaDocument` into the same JSON Schema 2020-12 slot the OpenAPI adapter fills.

## Ownership

Label: decided.

Effect owns commands and flags (`effect/cli`), validation and typed errors (`Schema`), files and standard streams (`FileSystem`, `Stdio`), streams (`Stream`, `Sse.makeParser`), retries (`Schedule` and `HttpClient.transform`), timeouts, configuration and credentials (`Config`, `Redacted`), wiring (`Layer`) and the HTTP client (`effect/http` over `@effect/platform-bun`).

The generated `runtime/` modules add only what Effect lacks, each with a written reason: OpenAPI parameter serialization, a streamed multipart writer, NDJSON line and JSON-seq record framing that never re-parses values, retries that respect idempotency, credentials bound to origins across redirects, standard input and bounded inputs, and the output, exit-code and error-rendering policy.

`@effect/openapi-generator` is a reference only. Schema code comes from Effect core `JsonSchema` and `SchemaRepresentation`.

## Generated package

Labels: decided; module granularity and `domain/` contents are measured; the second layout is provisional.

A generated package has this layout:

- `src/domain/`: transport-free schemas and the CLI's tagged error classes.
- `src/api/`: pure request builders and response tables per operation. It knows nothing about flags. It is a request-builder layer, not an `HttpApi` definition.
- `src/cli/`: the `effect/cli` commands.
- `src/runtime/`: the gap-filling modules. They depend on `effect` services only and never name the platform.
- `src/main.ts`: runs the command, catches the final cause and sets runtime defaults.
- `src/bin.ts`: the only module that names the platform. It provides platform services, the HTTP client layer and its options, logging, the presenter and the CLI configuration.

There is one `api/` module and one `cli/` module per tag group. Commands call `api/` builders and execute through the runtime. Generated CLIs never use `HttpApi` or `HttpApiClient` as their transport.

On the Cloudflare specification, the largest in the corpus, per-group modules missed the 500 ms start-up bound. A table form met it: one `api/table.ts` row per operation, and a `runtime/interpret.ts` that builds the commands at start-up (measured). The table form is a second layout. It is built only if a first-milestone measurement shows that lazy loading of per-group modules also misses the bound on Cloudflare. If lazy loading meets the bound, per-group modules with lazy loading are the only layout and the table form is never emitted. If the table form is built, it serves specifications above a measured operation count. Both layouts then give the same command paths, flags, help and `--describe` output and send the same request bytes. Each table row holds every fact about its operation, request encodings included, in one row type the runtime owns. A golden fixture compares the two layouts, including the request bytes of a JSON, a form-urlencoded and a multipart operation. Until that measurement reports, generation emits per-group modules only, and Cloudflare-sized specifications wait for its result (provisional).

Regeneration writes file by file (a temporary sibling file, then `rename`), records the manifest last, and deletes only files the manifest lists whose hash still matches. Do not edit generated files by hand.

Emitted object keys are sorted, with no lint exception. Order that carries meaning (parameters, media and response alternatives, servers, security alternatives, form and multipart parts, diagnostics) is carried by arrays.

`domain/` is one module holding only the schemas a request can reach, with fields sorted and without `examples`, `example` or `default`. Response schemas join it with `--validate-response` (measured).

Single-file bodies go through a `FileBody` service whose Bun implementation uses `Bun.file` (measured).

## Runtime target

Labels: decided for the client behavior; the operator confirms Bun-only.

Generated CLIs run on Bun. Their `dependencies` pin `effect` and `@effect/platform-bun` exactly to the generator's own versions, now `4.1.2`. `bin.ts` provides `BunHttpClient.layerOptions({ redirect: "manual" })`, turns trace propagation off and sends logs to stderr. A Node entry would be a later change confined to `bin.ts`, because nothing under `runtime/` names Bun. `@effect/platform-node` joins the dependencies only with that entry.

## Requests

Labels: decided; uploads, bodies on `GET`, `HEAD` and `DELETE`, and method tokens are measured.

- Method, path, parameter locations, serialization, body encoding and security are preserved exactly. Command names never imply HTTP verbs.
- Where a later OpenAPI line explicitly corrects text of an earlier line, the correction applies to the earlier lines too, with a notice per occurrence. Header values are never percent-encoded in any line, and `deepObject` ignores `explode` in every line.
- A merged body is checked against its schema, never decoded, and the original value is sent. When no field flag overrides it, the operator's bytes are sent unchanged.
- No path segment may be `.` or `..` after expansion.
- These are usage errors, raised before any connection: a value the encoding cannot represent unambiguously (an item containing its style's delimiter, a lone surrogate), and an empty `[]` or `{}` for a required parameter.
- The range of an integer outside the safe range is not checked client-side (see Schemas). The value passes as a digit string and is serialized as a bare JSON number.
- A required body with no input is sent as an empty object (`{}`) or an empty multipart body. An optional body with no input is omitted.
- Content type and `Accept` come from the declared media types. `--content-type` and `--accept` choose among them.
- Bodies on `GET`, `HEAD` and `DELETE`: OpenAPI 3.0 ignores them. OpenAPI 3.1 and later send `DELETE` bodies and refuse `GET` and `HEAD` bodies at `element` scope, because Bun's `fetch` throws before connecting.
- Fixed-field methods (`get` through `trace`, and the 3.2 `query`) are sent uppercase. A 3.2 `additionalOperations` key is sent as spelled. Bun sends 35 uppercase method tokens verbatim and silently sends `GET` for any other token, so an operation whose key is outside that set, lowercase and mixed-case keys included, is refused at `operation` scope, and the runtime checks the same allowlist before sending. The allowlist comes from Bun's own method table, is provided by `bin.ts`, and is checked again on every Bun upgrade. The 3.2 `query` method sends `QUERY`, with or without a body.
- XML bodies are opaque: they come from a file or standard input and are sent byte for byte. XML serialization driven by a schema is refused.
- Multipart bodies are streamed by the runtime's writer, never buffered through `FormData`. Names and filenames are escaped as Bun's `FormData` escapes them, and `filename` is the file's basename. Single-file bodies keep `Content-Length`.

## Servers and credentials

Labels: decided; the redirect mechanism is measured.

- Spec servers become defaults only when the API author accepts them in the author config. The bound origin set is the concrete origins of their expansions. A scheme or authority variable needs an `enum`, or the author lists `acceptedOrigins`.
- Base URL precedence is `--base-url`, then the environment, then `--server`, then the accepted default. The environment value counts as chosen by the operator, like `--base-url`. A `--server` URL whose origin is outside the bound set is a usage error.
- Credentials come from a file flag, the environment (default name `<PREFIX>_<SCHEME>`, overridable per scheme in the author config) or a terminal prompt. They are never taken from the command line by default. They stay `Redacted`, are attached only to bound origins, and their values are removed from every rendered excerpt, URL and summary.
- A `mutualTLS` client certificate is bound the same way: it is presented only to bound origins, never on a cross-origin redirect or to an unbound base URL.
- The runtime follows redirects with its own loop for up to 10 hops and attaches credentials on each hop only to bound origins. A `Location` must be `http` or `https` without userinfo. A cross-origin body re-send, a 307 or 308 re-send of a body that can be read only once, and a move from `https` to `http` are refused.
- No flag value, `--base-url` included, is echoed in an error message.

## Security schemes

Labels: decided; the operator decides the scope of token acquisition.

- Implemented: `apiKey` (header, query, cookie), `http` basic and bearer (the scheme name is matched case-insensitively) and `mutualTLS`.
- `oauth2` and `openIdConnect`: the operator supplies the token and the CLI passes it through. Token acquisition flows are refused at `element` scope for now. `password` and `implicit` are refused permanently.
- Other `http` schemes are refused.

## Responses and errors

Label: decided.

- Output preserves the server's bytes. Sequential media types emit one JSON value per line as items arrive.
- Binary output never goes to a terminal unless the operator passes `--output -`. `--force` only lets `--output` replace an existing file.
- Response precedence is an explicit status code, then a range, then `default`. Success is decided by the 2xx status class.
- Errors are shared tagged classes in `domain/` that carry the matched response key. One class per operation and status exceeded the 4 GiB type-check memory ceiling on the Cloudflare specification (measured).
- Errors render on stderr as text or JSON. Error-body excerpts default to 4 KiB, `--max-error-bytes 0` omits them, and excerpts are always sanitized. Retry hints appear only for methods the retry policy would retry.
- Exit codes: 0 success, 1 API error, 2 usage, 3 authentication, 4 transport, 5 response or output handling, 70 internal, 130 interrupted.

## Retries and timeouts

Labels: decided; the operator confirms the defaults.

- Idempotent methods and `QUERY` retry transient failures with jittered backoff and `Retry-After`. Transient failures are connection, DNS and timeout failures (never TLS failures or interrupts) and the statuses 408, 429, 500, 502, 503 and 504. `Retry-After` is not waited beyond the timeout: retrying stops and the error reports the server's value.
- Unsafe methods retry only with `--retry-unsafe` or an operator-supplied declared `Idempotency-Key`.
- Bodies read from standard input never retry and are never re-sent on a redirect. File bodies are read again.
- A timeout per attempt applies to response headers, and an idle timeout applies to streams.
- The author config sets defaults for retries and timeouts. A flag beats its environment variable (`<PREFIX>_RETRIES`, `<PREFIX>_TIMEOUT`, `<PREFIX>_IDLE_TIMEOUT`), which beats the author default.

## Schemas

Labels: decided; the coverage of Effect's schema importer is measured.

- Shape keywords drive flags and serialization.
- Constraint keywords that Effect's importer accepts are checked client-side. Others, `pattern` included, are sent unchecked and recorded as notices.
- A union whose branches are all constant values is read as an enum.
- A schema Effect's importer cannot read (a union it cannot intersect, or declared properties beside a schema-valued `additionalProperties`) is sent unchecked with a notice.
- A `$ref` into a location that is not a schema position, and a schema that aliases itself through a one-branch `allOf`, are refused.
- Integers outside the safe range (`int64`) are typed as `number` in the copy used for checking, so their range is not checked client-side (notice). The request sends the digit string (see Requests).
- Enum members outside the declared type are dropped with a notice. A 3.0 `nullable` in a 3.1 or later document is a notice and has no effect.
- `$dynamicRef` and dialects other than the OpenAPI dialect are refused.
- Annotations become help text. `default` is never sent.

## Naming and customization

Label: decided.

- Commands are grouped by tag and named from `operationId` by one ASCII fold.
- Path parameters are positionals. The operator may choose flags instead.
- Booleans have three states: `--x`, `--no-x` and absent.
- Body fields flatten to depth 2 as dotted flags such as `--address.city`, which `effect/cli` parses (measured). `--body` and `--body-file` pass the whole body instead. At most one input reads standard input per invocation.
- Collisions of visible names (flags and their `no-` negations, commands, file segments, credential names) are refused at `operation` scope with an override hint, never renamed. Colliding internal identifiers are renamed deterministically with a notice.
- Help descriptions are source prose only: `description`, else `summary`, else `title`. Generated facts go in separate help sections, and flags are listed alphabetically.
- The author config keys overrides by `operationId`, or by JSON Pointer for operations without one. An override that matches nothing is a notice, or a refusal under `--strict`.
- Vendor extensions are informational.

## Refusals

Label: decided.

- Every refusal is a diagnostic with a stable code, the OpenAPI feature it concerns, a scope, the document, the JSON Pointer (RFC 6901) of the place where the element is used, and the specification section.
- Diagnostics, verdict files and `--describe` output share `Schema` codecs.
- Generation emits everything it can implement. `--strict` makes any refusal fatal.
- A feature a later milestone implements is refused with a diagnostic until then, never dropped.
- A corpus verdict is `accepted`, `partly-refused` or `refused`.

## Generator dependencies

Labels: decided; YAML and the validator are measured.

- `@hyperjump/json-schema` 1.18.0, pinned exactly, for official-schema validation, with no result cache. It validates a copy of the document in which the 3.1 dialect identifier the specification text uses is replaced by the dated identifier. Its error locations are percent-decoded before they are compared with JSON Pointers.
- `yaml` 2.9.1, pinned exactly, for YAML. JSON uses `JSON.parse` plus the duplicate-key scanner. `Bun.YAML` and Effect `Yaml` are not used.
- The official OpenAPI schemas are vendored with their sha256.
- Nothing else.

## Corpus and coverage

Label: decided.

- Corpus specifications are pinned by commit SHA and sha256 and fetched in CI by pin, not vendored.
- The `ci` tier is Stripe, GitHub (3.0 and 3.1), Cloudflare, OpenAI, Kubernetes `core/v1`, Discord and Resend. Sources without a license or a stable pin are in the `extended` tier only.
- One verdict file per pinned specification is committed and checked for drift.
- An independent coverage checker joins its own walk of the specification with the built CLI's `--describe` output (introspection for operators, with a versioned schema) and with the refusal and informational records of the generation report. The join key is the JSON Pointer of the place where each element is used.

## Open decisions

Label: operator default. These defaults apply until the project owner decides otherwise:

- Stripe-style nested `deepObject` values: refused.
- Path parameters: positionals rather than flags.
- Authentication for specifications without security schemes: none; the author config may add one.
- Secrets on the command line: not offered.
- Features only OpenAPI 3.2 has: implemented.
- OAuth token acquisition: the operator supplies tokens.
- Static pass-through for other `http` schemes: refused.
- YAML input and the reach of `$ref` resolution: to be confirmed.
- A Bun-only generated runtime: to be confirmed.

## Clean break

The current line starts from `main`. An earlier implementation exists on another branch. It survives only where a review kept it, element by element, with the reason recorded.

## Repository layout

The generator itself has one directory per pipeline stage, a model directory, the generated runtime's source, a library entry and a generator CLI. The layout below is the target after the first milestone. Some paths do not exist yet.

```text
.github/workflows/check.yml      # format, lint, type-check, Bun pin check, tests, corpus (with the coverage join)
.agents/skills/                  # repository skills: conventional-commits, document-code
AGENTS.md  README.md
docs/
  project.md                     # this file
  printer.md                     # the deterministic printer's short spec
package.json  bun.lock  bunfig.toml  tsconfig.json  tsconfig.build.json  vite.config.ts
src/
  index.ts                       # library entry: generate(input, config)
  main.ts                        # generator CLI: generate, validate, verdict (effect/cli commands)
  bin.ts                         # shebang, BunServices, BunRuntime.runMain
  load/  validate/  resolve/  check/  normalize/  names/  emit/  write/  report/   # one per pipeline stage
  model/                         # branded values, entities, diagnostic and verdict codecs, author config
  runtime-src/                   # the generated runtime's source, emitted verbatim and tested directly
    domain/errors.ts             #   the CLI's tagged error classes, which runtime/ imports
    runtime/*.ts                 #   serialize, input, auth, client, output, multipart, describe,
                                 #   file-body, base-url, negotiate, response
tools/
  check-bun.ts                   # the running Bun equals the packageManager pin
  memguard.sh  run-test.sh       # memory ceiling; test runner that checks the Bun pin and fails on zero tests
  embed-runtime.ts               # runtime-src/ to a git-ignored string module
  lint-plugin.mjs  no-built-in-try-catch.mjs
tests/
  <stage>/*.test.ts  runtime/*.test.ts  security/*.test.ts  corpus/*.test.ts
  support/generated-cli.ts       # generate, build and run a CLI under memory ceilings
  fixtures/
    capture-server.ts            # HTTP server that records the requests a generated CLI sends
    golden/                      # checked-in expected generator output
    seeds/                       # test cases carried over from the earlier implementation, as data
    specs/  yaml/  resolve/      # synthetic specifications per feature
corpus/
  corpus.json                    # corpus pins, ci and extended tiers
  config/                        # author configs for corpus specifications
  verdicts/                      # one committed verdict file per pinned specification
  fixtures/                      # synthetic specifications for constructs the real corpus lacks
  tools/                         # fetch, run, coverage, walk
```

`runtime-src/` mirrors the generated package's `src/` subtree, so relative imports hold in both places. `runtime/describe.ts` is the only home of the `--describe` codec; the coverage checker imports it from there, never from `model/`.

Why this shape: the stages map one to one to the pipeline and to the trust boundary, so "no emitter reads the source document" can be checked from the import graph. The `main.ts` and `bin.ts` split is Effect's own convention.
