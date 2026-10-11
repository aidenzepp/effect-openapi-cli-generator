export const runtimeSource = String.raw`
import { Effect, FileSystem, Option, Schema, Stdio, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
export class InvalidBaseUrl extends Schema.TaggedError<InvalidBaseUrl>()("InvalidBaseUrl", { message: Schema.String, value: Schema.String }) {}
export class InvalidBody extends Schema.TaggedError<InvalidBody>()("InvalidBody", { message: Schema.String, source: Schema.String }) {}
export class RequestFailed extends Schema.TaggedError<RequestFailed>()("RequestFailed", { message: Schema.String }) {}
export class HttpStatusFailure extends Schema.TaggedError<HttpStatusFailure>()("HttpStatusFailure", { status: Schema.Number, body: Schema.String }) { override get message() { return "HTTP " + this.status + ": " + this.body; } }
export type RequestFailure = InvalidBaseUrl | InvalidBody | RequestFailed | HttpStatusFailure;
export const validateBaseUrl = (value: string) => Effect.try({ try: () => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Expected HTTP(S) URL without credentials, query or fragment');
  return url.href.replace(/\/+$/, '');
}, catch: (cause) => new InvalidBaseUrl({value, message: String(cause)}) });
export const readBody = (input: { readonly body: Option.Option<string>; readonly bodyFile: Option.Option<string> }, required: boolean, schema: Schema.Codec<unknown>) => Effect.gen(function* () {
  if (Option.isSome(input.body) && Option.isSome(input.bodyFile)) return yield* new InvalidBody({source: 'input', message: 'Use exactly one of --body and --body-file'});
  if (Option.isNone(input.body) && Option.isNone(input.bodyFile)) {
    if (required) return yield* new InvalidBody({source: 'input', message: 'A JSON --body or --body-file is required'});
    return Option.none();
  }
  const source = Option.isSome(input.bodyFile) ? input.bodyFile.value : '--body';
  const text = Option.isSome(input.body) ? input.body.value : yield* (yield* FileSystem.FileSystem).readFileString(source).pipe(Effect.mapError((cause) => new InvalidBody({source, message: String(cause)})));
  const value: unknown = yield* Effect.try({try: () => JSON.parse(text), catch: (cause) => new InvalidBody({source, message: String(cause)})});
  yield* Schema.decodeUnknownEffect(schema, {onExcessProperty: 'error'})(value).pipe(Effect.mapError((cause) => new InvalidBody({source, message: String(cause)})));
  return Option.some(value);
});
export const pathValue = (value: string | number | boolean) => Effect.try({try: () => {
  const text = String(value);
  if (text === '.' || text === '..') throw new Error('Dot segments are not valid path parameter values');
  return encodeURIComponent(text).replace(/[!'()*]/g, (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase());
}, catch: (cause) => new RequestFailed({message: String(cause)})});
export const executeRequest = (method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'OPTIONS' | 'HEAD' | 'PATCH' | 'TRACE', url: string, body: Option.Option<unknown>) => Effect.scoped(Effect.gen(function* () {
  let request = HttpClientRequest.make(method)(url);
  if (Option.isSome(body)) request = yield* HttpClientRequest.bodyJson(request, body.value).pipe(Effect.mapError((cause) => new RequestFailed({message: String(cause)})));
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(request).pipe(Effect.mapError((cause) => new RequestFailed({message: String(cause)})));
  const text = yield* response.text.pipe(Effect.mapError((cause) => new RequestFailed({message: String(cause)})));
  if (response.status < 200 || response.status > 299) return yield* new HttpStatusFailure({status: response.status, body: text});
  if (text.length > 0) {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.make(text).pipe(Stream.run(stdio.stdout({endOnDone: false})), Effect.mapError((cause) => new RequestFailed({message: String(cause)})));
  }
}));
`;
