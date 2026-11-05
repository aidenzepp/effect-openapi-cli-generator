import type { SecurityRequirement } from "../runtime/auth.ts";
import type { MediaDeclaration } from "../runtime/negotiate.ts";
import * as Serialize from "../runtime/serialize.ts";

export interface UpdateInput {
  readonly body: Serialize.Body;
  readonly id: string;
  readonly ifMatch?: string | undefined;
  readonly notify?: boolean | undefined;
}

/**
 * Request builder for users update, not an HttpApi definition.
 */
export const update = (input: UpdateInput): Serialize.Request =>
  Serialize.request("PATCH", {
    body: Serialize.body("application/json", input.body),
    headers: [Serialize.header("If-Match", input.ifMatch, { explode: false, required: false })],
    path: Serialize.path("/users/{id}", [
      Serialize.simple("id", input.id, { allowReserved: false, explode: false }),
    ]),
    query: [
      Serialize.form("notify", input.notify, {
        allowReserved: false,
        explode: true,
        required: false,
      }),
    ],
  });

const updateMedia: MediaDeclaration = {
  request: ["application/json"],
  responses: { "200": ["application/json"], "404": [], default: ["application/json"] },
};

const updateSecurity: SecurityRequirement = [["bearerAuth"]];

export const updateMeta = {
  media: updateMedia,
  method: "PATCH",
  operationId: "users-update",
  origin: { document: "openapi.json", pointer: "/paths/~1users~1{id}/patch" },
  pathTemplate: "/users/{id}",
  security: updateSecurity,
};

export interface SetAvatarInput {
  readonly body: Serialize.Body;
  readonly contentType: "application/json" | "image/png";
  readonly id: string;
}

/**
 * Request builder for users set-avatar, not an HttpApi definition.
 */
export const setAvatar = (input: SetAvatarInput): Serialize.Request =>
  Serialize.request("PUT", {
    body: Serialize.body(input.contentType, input.body),
    headers: [],
    path: Serialize.path("/users/{id}/avatar", [
      Serialize.simple("id", input.id, { allowReserved: false, explode: false }),
    ]),
    query: [],
  });

const setAvatarMedia: MediaDeclaration = {
  request: ["application/json", "image/png"],
  responses: { "200": ["application/json", "image/png"] },
};

const setAvatarSecurity: SecurityRequirement = [["bearerAuth"]];

export const setAvatarMeta = {
  media: setAvatarMedia,
  method: "PUT",
  operationId: "users-set-avatar",
  origin: { document: "openapi.json", pointer: "/paths/~1users~1{id}~1avatar/put" },
  pathTemplate: "/users/{id}/avatar",
  security: setAvatarSecurity,
};
