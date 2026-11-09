import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import * as Users from "../api/users.ts";
import { Avatar, UserUpdate } from "../domain/schemas.ts";
import * as Describe from "../runtime/describe.ts";
import * as Input from "../runtime/input.ts";
import * as Negotiate from "../runtime/negotiate.ts";
import * as Output from "../runtime/output.ts";

export const update = Command.make(
  "update",
  {
    addressCity: Flag.String("address.city").pipe(Flag.optional),
    body: Input.bodyFlag,
    bodyFile: Input.bodyFileFlag,
    id: Argument.String("id").pipe(Argument.withDescription("User id.")),
    ifMatch: Flag.String("if-match").pipe(Flag.optional),
    name: Flag.String("name").pipe(Flag.optional, Flag.withDescription("Display name.")),
    notify: Flag.Boolean("notify").pipe(
      Flag.optional,
      Flag.withDescription("Send a notification email."),
    ),
  },
  (flags) =>
    Input.mergeBody({
      body: flags.body,
      bodyFile: flags.bodyFile,
      fields: { "/address/city": flags.addressCity, "/name": flags.name },
      required: true,
      schema: UserUpdate,
    }).pipe(
      Effect.flatMap((merged) =>
        Users.update({
          body: merged,
          id: flags.id,
          ifMatch: Option.getOrUndefined(flags.ifMatch),
          notify: Option.getOrUndefined(flags.notify),
        }),
      ),
      Effect.flatMap(Output.send(Users.updateMeta)),
    ),
).pipe(
  Command.provideEffectDiscard(Output.recordRun("EXAMPLE")),
  Command.withDescription("Update a user."),
  Command.annotate(Describe.Binding, {
    operation: Users.updateMeta,
    parameters: {
      "address.city": {
        location: "body",
        pointer: "/components/schemas/UserUpdate/properties/address/properties/city",
        wireName: "/address/city",
      },
      id: { location: "path", pointer: "/paths/~1users~1{id}/patch/parameters/0", wireName: "id" },
      "if-match": {
        location: "header",
        pointer: "/paths/~1users~1{id}/patch/parameters/2",
        wireName: "If-Match",
      },
      name: {
        location: "body",
        pointer: "/components/schemas/UserUpdate/properties/name",
        wireName: "/name",
      },
      notify: {
        location: "query",
        pointer: "/paths/~1users~1{id}/patch/parameters/1",
        wireName: "notify",
      },
    },
  }),
  Command.annotate(Output.Help, {
    arguments: { id: "path id" },
    flags: {
      "address.city": "body /address/city",
      "if-match": "header If-Match",
      name: "body /name",
      notify: "query notify; --no-notify sends false",
    },
    sections: [
      ["REQUEST", "PATCH /users/{id}, body application/json (required), operationId users-update"],
      [
        "AUTH",
        "bearerAuth (http bearer): --bearer-auth-file <path|->, env EXAMPLE_BEARER_AUTH, TTY prompt",
      ],
      [
        "RESPONSES",
        "200 application/json; 404; default application/json. Non-2xx exits 1 (401/403 exit 3)",
      ],
    ],
  }),
);

export const setAvatar = Command.make(
  "set-avatar",
  {
    accept: Negotiate.acceptFlag,
    body: Input.bodyFlag,
    bodyFile: Input.bodyFileFlag,
    contentType: Negotiate.contentTypeFlag,
    id: Argument.String("id").pipe(Argument.withDescription("User id.")),
    url: Flag.String("url").pipe(Flag.optional),
  },
  (flags) =>
    Input.selectBody({
      alternatives: {
        "application/json": Input.mergeBody({
          body: flags.body,
          bodyFile: flags.bodyFile,
          fields: { "/url": flags.url },
          required: true,
          schema: Avatar,
        }),
        "image/png": Input.binaryBody({
          body: flags.body,
          bodyFile: flags.bodyFile,
          required: true,
        }),
      },
      chosen: flags.contentType,
      foreign: { "image/png": { url: Option.isSome(flags.url) } },
      media: Users.setAvatarMeta.media,
    }).pipe(
      Effect.flatMap((selected) =>
        Users.setAvatar({ body: selected.body, contentType: selected.contentType, id: flags.id }),
      ),
      Effect.flatMap(Output.send(Users.setAvatarMeta, flags.accept)),
    ),
).pipe(
  Command.provideEffectDiscard(Output.recordRun("EXAMPLE")),
  Command.withDescription("Set a user avatar."),
  Command.annotate(Describe.Binding, {
    operation: Users.setAvatarMeta,
    parameters: {
      id: {
        location: "path",
        pointer: "/paths/~1users~1{id}~1avatar/put/parameters/0",
        wireName: "id",
      },
      url: {
        location: "body",
        pointer: "/components/schemas/Avatar/properties/url",
        wireName: "/url",
      },
    },
  }),
  Command.annotate(Output.Help, {
    arguments: { id: "path id" },
    flags: { url: "body /url" },
    sections: [
      [
        "REQUEST",
        "PUT /users/{id}/avatar, body application/json or image/png (required), operationId users-set-avatar",
      ],
      [
        "AUTH",
        "bearerAuth (http bearer): --bearer-auth-file <path|->, env EXAMPLE_BEARER_AUTH, TTY prompt",
      ],
      ["RESPONSES", "200 application/json or image/png. Non-2xx exits 1 (401/403 exit 3)"],
    ],
  }),
);

export const group = Command.make("users").pipe(Command.withSubcommands([update, setAvatar]));
