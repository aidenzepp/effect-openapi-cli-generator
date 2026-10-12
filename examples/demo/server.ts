import { serve as serveHttp } from "bun";
import process from "node:process";
import { Console, Effect, Schema } from "effect";

const users = [
  { active: true, id: "ada", name: "Ada" },
  { active: false, id: "grace", name: "Grace" },
];

const serve = Effect.acquireRelease(
  Effect.sync(() =>
    serveHttp({
      async fetch(request) {
        const url = new URL(request.url);
        const route = url.pathname;
        console.log(`${request.method} ${route}${url.search}`);
        if (request.method === "GET" && route === "/api/users") {
          const active = url.searchParams.get("active");

          return Response.json(
            users.filter((user) => active === null || String(user.active) === active),
          );
        }

        if (request.method === "GET" && route.startsWith("/api/users/")) {
          const id = decodeURIComponent(route.slice("/api/users/".length));
          const user = users.find((candidate) => candidate.id === id);

          return user
            ? Response.json(user)
            : Response.json({ error: "User not found" }, { status: 404 });
        }

        if (request.method === "POST" && route === "/api/posts") {
          return await Effect.runPromise(
            Effect.tryPromise(() => request.json()).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))),
              Effect.match({
                onFailure: () => Response.json({ error: "Expected JSON object" }, { status: 400 }),
                onSuccess: (post) => Response.json({ id: "post-demo", ...post }, { status: 201 }),
              }),
            ),
          );
        }

        if (request.method === "GET" && route.startsWith("/api/files/")) {
          return Response.json({
            bytes: 12,
            id: decodeURIComponent(route.slice("/api/files/".length)),
            name: "hello.txt",
          });
        }

        return Response.json({ error: "Route not found" }, { status: 404 });
      },
      hostname: "127.0.0.1",
      port: Number(process.env.PORT ?? 43_123),
    }),
  ),
  (server) => Effect.promise(() => server.stop(true)),
);

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* runDemo() {
      const server = yield* serve;
      yield* Console.log(
        `Demo listening at http://127.0.0.1:${server.port}/api (PID ${process.pid})`,
      );
      yield* Effect.never;
    }),
  ),
);
