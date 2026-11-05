import { afterAll, describe, expect, test } from "bun:test";
import { directRoute } from "../../src/runtime-src/runtime/client.ts";

// Pins the Bun behavior the direct route relies on (probe SP5c, Bun 1.4.3): with HTTP_PROXY set,
// a loopback fetch with `proxy: false` reaches the origin, and one without it goes via the proxy.
// Bun reads the proxy environment at start-up, so the fetches run in a child process. Loopback only.
const timeout = 30_000;

const servers: Bun.Server<unknown>[] = [];

const child = `
  const port = process.argv[1];
  const get = async (init) => (await fetch("http://127.0.0.1:" + port + "/probe", init)).text();
  console.log(JSON.stringify({
    direct: await get({ proxy: false }),
    viaEnv: await get(undefined),
  }));
`;

afterAll(() => {
  for (const server of servers) {
    void server.stop(true);
  }
});

describe("Bun proxy: false", () => {
  test(
    "routes a loopback fetch direct; without it the proxy environment applies",
    async () => {
      expect(Object.entries(directRoute ?? {})).toEqual([["proxy", false]]);

      const proxied: string[] = [];
      const origin = Bun.serve({
        fetch: () => new Response("origin"),
        hostname: "127.0.0.1",
        port: 0,
      });
      const proxy = Bun.serve({
        fetch: (request) => {
          proxied.push(request.url);

          return new Response("proxy");
        },
        hostname: "127.0.0.1",
        port: 0,
      });
      servers.push(origin, proxy);

      const proxyUrl = `http://127.0.0.1:${proxy.port}`;
      const run = Bun.spawn([process.execPath, "-e", child, String(origin.port)], {
        env: {
          HOME: process.env.HOME ?? "",
          HTTP_PROXY: proxyUrl,
          PATH: process.env.PATH ?? "",
          http_proxy: proxyUrl,
        },
        stderr: "inherit",
        stdout: "pipe",
      });

      try {
        const text = await new Response(run.stdout).text();
        await run.exited;

        expect(JSON.parse(text)).toEqual({ direct: "origin", viaEnv: "proxy" });
        expect(proxied).toHaveLength(1);
      } finally {
        run.kill();
      }
    },
    timeout,
  );
});
