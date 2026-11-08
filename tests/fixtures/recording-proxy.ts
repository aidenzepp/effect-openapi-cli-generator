import { once } from "node:events";
import { connect, createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";

/**
 * The local listener a proxied authority is sent to.
 */
export interface ProxyTarget {
  readonly hostname: string;
  readonly port: number;
}

/**
 * One accepted proxy connection: its request line, the authority it named and its header lines
 * in the order received.
 */
export interface ProxyRecord {
  readonly headerLines: readonly string[];
  readonly kind: "connect" | "forward";
  readonly proxy: string;
  readonly requestLine: string;
  readonly target: string;
}

/**
 * A label that tells instances apart, and the map from the `host:port` authority a client names
 * to the local listener it reaches. An authority missing from the map is answered `502`.
 */
export interface RecordingProxyOptions {
  readonly label: string;
  readonly targets: Readonly<Record<string, ProxyTarget>>;
}

export interface RecordingProxy {
  readonly records: () => readonly ProxyRecord[];
  readonly reset: () => void;
  readonly stop: () => void;
  readonly url: string;
  readonly urlWithUserinfo: (username: string, password: string) => string;
}

const separator = Buffer.from("\r\n\r\n", "latin1");

const badGateway = "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

const dropped = /^(?:connection|proxy-authorization|proxy-connection):/iu;

const defaultPort = (url: URL) => (url.protocol === "https:" ? "443" : "80");

// The `host:port` a request names: the CONNECT target as written, or the absolute-form URL's.
const authorityOf = (method: string, target: string) => {
  if (method === "CONNECT") {
    return { authority: target, url: null };
  }

  const url = URL.parse(target);

  return url === null
    ? { authority: target, url: null }
    : { authority: `${url.hostname}:${url.port === "" ? defaultPort(url) : url.port}`, url };
};

// Writes the head and any bytes already read once the upstream connects, then pipes both ways.
const relay = (client: Socket, upstream: Socket, first: Buffer, rest: Buffer) => {
  upstream.on("error", () => {
    client.destroy();
  });
  client.on("error", () => {
    upstream.destroy();
  });
  upstream.on("connect", () => {
    upstream.write(first);
    if (rest.length > 0) {
      upstream.write(rest);
    }

    client.pipe(upstream);
    upstream.pipe(client);
  });
};

/**
 * Starts a recording forward HTTP proxy on `127.0.0.1` (probe SP5's `makeProxy`, with a target
 * map). A `CONNECT` is tunnelled byte for byte after `200 Connection Established`. An absolute-form
 * request is sent upstream in origin form, without `Proxy-Authorization` and `Proxy-Connection`
 * and with `Connection: close`, so each hop is its own proxy connection.
 */
export const startRecordingProxy = async (
  options: RecordingProxyOptions,
): Promise<RecordingProxy> => {
  const records: ProxyRecord[] = [];
  const sockets = new Set<Socket>();

  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  };

  const handle = (client: Socket, head: string, rest: Buffer) => {
    const lines = head.split("\r\n");
    const requestLine = lines[0] ?? "";
    const headerLines = lines.slice(1);
    const [method = "", requestTarget = "", version = "HTTP/1.1"] = requestLine.split(" ");
    const { authority, url } = authorityOf(method, requestTarget);
    const kind = method === "CONNECT" ? "connect" : "forward";
    records.push({ headerLines, kind, proxy: options.label, requestLine, target: authority });

    const destination = options.targets[authority];
    if (destination === undefined || (kind === "forward" && url === null)) {
      client.end(badGateway);

      return;
    }

    const upstream = connect(destination.port, destination.hostname);
    track(upstream);

    if (kind === "connect") {
      upstream.on("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      });
      relay(client, upstream, Buffer.alloc(0), rest);

      return;
    }

    const forwarded = [
      `${method} ${url?.pathname ?? "/"}${url?.search ?? ""} ${version}`,
      ...headerLines.filter((line) => !dropped.test(line)),
      "Connection: close",
    ];
    relay(client, upstream, Buffer.from(`${forwarded.join("\r\n")}\r\n\r\n`, "latin1"), rest);
  };

  const server = createServer((client) => {
    track(client);
    client.on("error", () => {
      client.destroy();
    });

    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(separator);
      if (end === -1) {
        return;
      }

      // Hold further bytes until the upstream is piped, so none are lost in between.
      client.off("data", onData);
      client.pause();
      handle(client, buffer.toString("latin1", 0, end), buffer.subarray(end + separator.length));
    };
    client.on("data", onData);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  // SAFETY: the server listens on a TCP host and port, never a pipe, so its address is an AddressInfo.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- net.Server.address() is typed for pipes as well
  const { port } = server.address() as AddressInfo;
  const host = `127.0.0.1:${port}`;

  return {
    records: () => records,
    reset: () => {
      records.length = 0;
    },
    stop: () => {
      server.close();
      for (const socket of sockets) {
        socket.destroy();
      }
    },
    url: `http://${host}`,
    urlWithUserinfo: (username, password) =>
      `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}`,
  };
};
