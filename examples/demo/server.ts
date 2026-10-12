import { Console, Effect } from "effect";

const users = [
  { id: "ada", name: "Ada", active: true },
  { id: "grace", name: "Grace", active: false },
];

const serve = Effect.acquireRelease(
  Effect.sync(() =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: Number(process.env.PORT ?? 43123),
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
          try {
            const post = await request.json();
            return Response.json({ id: "post-demo", ...post }, { status: 201 });
          } catch {
            return Response.json({ error: "Expected JSON" }, { status: 400 });
          }
        }
        if (request.method === "GET" && route.startsWith("/api/files/")) {
          return Response.json({
            id: decodeURIComponent(route.slice("/api/files/".length)),
            name: "hello.txt",
            bytes: 12,
          });
        }
        return Response.json({ error: "Route not found" }, { status: 404 });
      },
    }),
  ),
  (server) => Effect.promise(() => server.stop(true)),
);

Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* serve;
      yield* Console.log(
        `Demo listening at http://127.0.0.1:${server.port}/api (PID ${process.pid})`,
      );
      yield* Effect.never;
    }),
  ),
);
