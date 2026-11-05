import type { ServersTable } from "../runtime/base-url.ts";

export const servers: ServersTable = {
  boundOrigins: ["https://api.example.com"],
  defaultServer: 0,
  servers: [
    { url: "https://api.example.com/{version}", variables: { version: { default: "v1" } } },
  ],
};
