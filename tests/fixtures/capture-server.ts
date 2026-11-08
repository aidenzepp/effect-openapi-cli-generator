import type { Certificate, PeerCertificate } from "node:tls";
import { Data, Effect, FileSystem, Path } from "effect";
import type { PlatformError, Scope } from "effect";

export type OriginName = "127.0.0.1" | "localhost";

export type TlsOriginName = "A" | "B";

export type HeaderList = readonly (readonly [name: string, value: string])[];

export interface RecordedRequest<Origin extends string = OriginName> {
  readonly body: Uint8Array;
  readonly connection: number;
  readonly headers: HeaderList;
  readonly method: string;
  readonly origin: Origin;
  readonly target: string;
}

export interface ConnectionEvent<Origin extends string = OriginName> {
  readonly connection: number;
  readonly kind: "close" | "open";
  readonly origin: Origin;
}

export interface SentChunk {
  readonly at: number;
  readonly connection: number;
  readonly index: number;
}

export interface PacedChunk {
  readonly data: string;
  readonly delayMs: number;
}

export interface ScriptedResponse {
  readonly body?: string;
  readonly chunks?: readonly PacedChunk[];
  readonly endless?: true;
  readonly headerDelayMs?: number;
  readonly headers?: HeaderList;
  readonly location?: string;
  readonly stallAfter?: number;
  readonly status: number;
}

export interface CaptureServerOptions {
  readonly canary?: true;
}

export interface CaptureServer<Origin extends string = OriginName> {
  readonly connections: () => number;
  readonly count: (path: string) => number;
  readonly events: () => readonly ConnectionEvent<Origin>[];
  readonly origins: Readonly<Record<Origin, string>>;
  readonly requests: () => readonly RecordedRequest<Origin>[];
  readonly script: (path: string, response: ScriptedResponse) => void;
  readonly sequence: (path: string, responses: readonly ScriptedResponse[]) => void;
  readonly sent: () => readonly SentChunk[];
  readonly stop: () => void;
}

interface Connection<Origin extends string> {
  buffer: Buffer;
  readonly id: number;
  readonly origin: Origin;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
}

interface Parsed {
  readonly consumed: number;
  readonly request: Omit<RecordedRequest, "connection" | "origin">;
}

const separator = Buffer.from("\r\n\r\n", "latin1");

const headerValue = (headers: HeaderList, name: string) =>
  headers.find(([candidate]) => candidate.toLowerCase() === name)?.[1];

const parseChunked = (buffer: Buffer, start: number) => {
  const parts: Buffer[] = [];
  let offset = start;

  for (;;) {
    const lineEnd = buffer.indexOf("\r\n", offset, "latin1");
    if (lineEnd === -1) {
      return null;
    }

    const size = Number.parseInt(buffer.toString("latin1", offset, lineEnd), 16);
    if (Number.isNaN(size)) {
      return null;
    }

    if (size === 0) {
      const trailerEnd = buffer.indexOf("\r\n\r\n", lineEnd, "latin1");

      return trailerEnd === -1
        ? null
        : { body: Buffer.concat(parts), consumed: trailerEnd + separator.length };
    }

    const dataEnd = lineEnd + 2 + size;
    if (buffer.length < dataEnd + 2) {
      return null;
    }

    parts.push(buffer.subarray(lineEnd + 2, dataEnd));
    offset = dataEnd + 2;
  }
};

// Reads one HTTP/1.1 request from the front of the buffer; null means more bytes are needed.
const parseRequest = (buffer: Buffer): Parsed | null => {
  const headEnd = buffer.indexOf(separator);
  if (headEnd === -1) {
    return null;
  }

  const [requestLine = "", ...lines] = buffer.toString("latin1", 0, headEnd).split("\r\n");
  const [method = "", target = ""] = requestLine.split(" ");
  const headers: HeaderList = lines.map((line) => {
    const colon = line.indexOf(":");

    return [line.slice(0, colon), line.slice(colon + 1).trim()] as const;
  });
  const bodyStart = headEnd + separator.length;

  if (headerValue(headers, "transfer-encoding")?.toLowerCase() === "chunked") {
    const chunked = parseChunked(buffer, bodyStart);

    return chunked === null
      ? null
      : { consumed: chunked.consumed, request: { body: chunked.body, headers, method, target } };
  }

  const length = Number(headerValue(headers, "content-length") ?? 0);
  if (buffer.length < bodyStart + length) {
    return null;
  }

  return {
    consumed: bodyStart + length,
    request: { body: buffer.subarray(bodyStart, bodyStart + length), headers, method, target },
  };
};

const defaultResponse: ScriptedResponse = { body: "ok", status: 200 };

// Canary statuses whose body is replaced by the request's Authorization value and body.
const echoStatuses = new Set([401, 500, 503]);

// Canary mode echoes request material so a client that renders a response verbatim leaks it.
const canaryBody = (request: RecordedRequest<string>) =>
  Buffer.concat([
    Buffer.from(headerValue(request.headers, "authorization") ?? ""),
    Buffer.from("\n", "latin1"),
    request.body,
  ]);

const canaryLocation = (request: RecordedRequest<string>, location: string) => {
  const authorization = headerValue(request.headers, "authorization");

  return authorization === undefined
    ? location
    : `${location}${location.includes("?") ? "&" : "?"}authorization=${authorization}`;
};

const head = (response: ScriptedResponse, length: number | null) => {
  const lines = [
    `HTTP/1.1 ${response.status} Scripted`,
    ...(response.headers ?? []).map(([name, value]) => `${name}: ${value}`),
    ...(response.location === undefined ? [] : [`Location: ${response.location}`]),
    length === null ? "Transfer-Encoding: chunked" : `Content-Length: ${length}`,
  ];

  return `${lines.join("\r\n")}\r\n\r\n`;
};

// Runs `task` after `delayMs`; the socket's close handler cancels whatever is still pending.
const later = <Origin extends string>(
  socket: Bun.Socket<Connection<Origin>>,
  delayMs: number,
  task: () => void,
) => {
  const timer = setTimeout(() => {
    socket.data.timers.delete(timer);
    task();
  }, delayMs);
  socket.data.timers.add(timer);
};

interface Capture<Origin extends string> {
  readonly certificates: () => readonly ClientCertificateRecord<Origin>[];
  // Starts one listener on 127.0.0.1 for `origin`, over TLS when given options, and returns its port.
  readonly listen: (origin: Origin, tls?: Bun.TLSOptions) => number;
  readonly server: Omit<CaptureServer<Origin>, "origins" | "stop">;
  readonly stop: () => void;
}

// Raw TCP (or TLS) listeners, not Bun.serve: Bun.serve sorts and merges headers, rewrites the
// target into an absolute URL and exposes no connection lifecycle, so it cannot record bytes as
// sent. With `tls`, each listener also records whether a connection presented a client certificate.
const capture = <Origin extends string>(
  options: CaptureServerOptions | undefined,
): Capture<Origin> => {
  const requests: RecordedRequest<Origin>[] = [];
  const events: ConnectionEvent<Origin>[] = [];
  const certificates: ClientCertificateRecord<Origin>[] = [];
  const sent: SentChunk[] = [];
  // Each path answers its sequence in order and repeats the last response once it runs out.
  const scripts = new Map<string, readonly ScriptedResponse[]>();
  const counts = new Map<string, number>();
  let connections = 0;

  const take = (path: string) => {
    const seen = counts.get(path) ?? 0;
    counts.set(path, seen + 1);

    const sequence = scripts.get(path) ?? [];

    return sequence[Math.min(seen, sequence.length - 1)] ?? defaultResponse;
  };

  const respond = (
    socket: Bun.Socket<Connection<Origin>>,
    request: RecordedRequest<Origin>,
    script: ScriptedResponse,
  ) => {
    const canary = options?.canary === true;
    const redirects = canary && script.status >= 300 && script.status < 400;
    const scripted = redirects
      ? { ...script, location: canaryLocation(request, script.location ?? "/") }
      : script;
    const payload =
      canary && echoStatuses.has(scripted.status)
        ? canaryBody(request)
        : Buffer.from(scripted.body ?? "");
    const closes = headerValue(request.headers, "connection")?.toLowerCase() === "close";
    const finish = () => {
      if (closes) {
        socket.end();
      }
    };

    if (scripted.endless === true) {
      socket.write(head(scripted, null));
      socket.data.timers.add(
        setInterval(() => {
          socket.write("5\r\nchunk\r\n");
        }, 10),
      );

      return;
    }

    if (scripted.chunks !== undefined) {
      socket.write(head(scripted, null));

      const pace = (index: number) => {
        const chunk = scripted.chunks?.[index];
        if (chunk === undefined) {
          socket.write("0\r\n\r\n");
          finish();

          return;
        }

        later(socket, chunk.delayMs, () => {
          const bytes = Buffer.from(chunk.data);
          socket.write(`${bytes.length.toString(16)}\r\n`);
          socket.write(Buffer.concat([bytes, Buffer.from("\r\n", "latin1")]));
          sent.push({ at: performance.now(), connection: socket.data.id, index });
          pace(index + 1);
        });
      };
      pace(0);

      return;
    }

    const prefix = Buffer.from(head(scripted, payload.length), "latin1");

    // A stalled body promises every byte in Content-Length, sends the first N and holds the socket.
    if (scripted.stallAfter !== undefined) {
      socket.write(Buffer.concat([prefix, payload.subarray(0, scripted.stallAfter)]));

      return;
    }

    socket.write(Buffer.concat([prefix, payload]));
    finish();
  };

  const dispatch = (socket: Bun.Socket<Connection<Origin>>, request: RecordedRequest<Origin>) => {
    const scripted = take(request.target.split("?")[0] ?? "");

    if (scripted.headerDelayMs === undefined) {
      respond(socket, request, scripted);
    } else {
      later(socket, scripted.headerDelayMs, () => {
        respond(socket, request, scripted);
      });
    }
  };

  const listeners: Bun.TCPSocketListener<Connection<Origin>>[] = [];

  const listen = (origin: Origin, tls?: Bun.TLSOptions) => {
    const listener = Bun.listen<Connection<Origin>>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        close: (socket) => {
          for (const timer of socket.data.timers) {
            clearTimeout(timer);
          }

          events.push({ connection: socket.data.id, kind: "close", origin: socket.data.origin });
        },
        data: (socket, chunk) => {
          const state = socket.data;
          state.buffer = Buffer.concat([state.buffer, chunk]);

          for (let parsed = parseRequest(state.buffer); parsed !== null;) {
            const request = { ...parsed.request, connection: state.id, origin: state.origin };
            requests.push(request);
            state.buffer = state.buffer.subarray(parsed.consumed);
            dispatch(socket, request);
            parsed = parseRequest(state.buffer);
          }
        },
        // Only TLS sockets handshake; the server asks for a certificate and accepts any or none.
        handshake: (socket) => {
          // SAFETY: Bun returns undefined, not the declared PeerCertificate, when the peer sent no
          // certificate; capture-server-tls.test.ts pins both cases.
          const certificate = socket.getPeerCertificate() as PeerCertificate | undefined;
          certificates.push({
            connection: socket.data.id,
            origin: socket.data.origin,
            presented: certificate !== undefined,
            subject: certificate === undefined ? null : { ...certificate.subject },
          });
        },
        open: (socket) => {
          connections += 1;
          socket.data = { buffer: Buffer.alloc(0), id: connections, origin, timers: new Set() };
          events.push({ connection: connections, kind: "open", origin });
        },
      },
      tls: tls ?? false,
    });
    listeners.push(listener);

    return listener.port;
  };

  return {
    certificates: () => certificates,
    listen,
    server: {
      connections: () => connections,
      count: (path) => counts.get(path) ?? 0,
      events: () => events,
      requests: () => requests,
      script: (path, response) => {
        scripts.set(path, [response]);
      },
      sent: () => sent,
      sequence: (path, responses) => {
        scripts.set(path, responses);
      },
    },
    stop: () => {
      for (const listener of listeners) {
        listener.stop(true);
      }
    },
  };
};

export const startCaptureServer = (options?: CaptureServerOptions): CaptureServer => {
  const { listen, server, stop } = capture<OriginName>(options);
  const origins = {
    "127.0.0.1": `http://127.0.0.1:${listen("127.0.0.1")}`,
    localhost: `http://localhost:${listen("localhost")}`,
  };

  return { ...server, origins, stop };
};

/**
 * The TEST-NET-1 literal each TLS origin's certificate also names, so a proxy witness can reach the
 * origin through a CONNECT under a non-loopback host (design 6.5, Loopback hosts).
 */
export const tlsOriginAddresses = { A: "192.0.2.10", B: "192.0.2.11" } as const satisfies Record<
  TlsOriginName,
  string
>;

/**
 * Whether one TLS connection presented a client certificate, and the certificate's subject.
 */
export interface ClientCertificateRecord<Origin extends string = TlsOriginName> {
  readonly connection: number;
  readonly origin: Origin;
  readonly presented: boolean;
  readonly subject: Readonly<Certificate> | null;
}

export interface CertificatePair {
  readonly cert: string;
  readonly key: string;
}

export interface TlsCaptureServer extends Omit<CaptureServer<TlsOriginName>, "stop"> {
  readonly caPath: string;
  readonly clientCertificate: CertificatePair;
  readonly clientCertificates: () => readonly ClientCertificateRecord[];
  readonly serverCertificates: Readonly<Record<TlsOriginName, CertificatePair>>;
}

/**
 * The TLS fixture could not make its certificates: openssl is not on PATH, or a step failed.
 */
export class TlsFixtureUnavailable extends Data.TaggedError("TlsFixtureUnavailable")<{
  readonly message: string;
  readonly reason: "openssl-failed" | "openssl-missing";
}> {}

const ellipticKey = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];

const runOpenssl = (openssl: string, args: readonly string[]) =>
  Effect.suspend(() => {
    const result = Bun.spawnSync([openssl, ...args], { stderr: "pipe", stdout: "ignore" });

    return result.exitCode === 0
      ? Effect.void
      : Effect.fail(
          new TlsFixtureUnavailable({
            message: `openssl ${args[0] ?? ""} exited ${result.exitCode} while making the TLS fixture's certificates: ${result.stderr.toString().trim()}`,
            reason: "openssl-failed",
          }),
        );
  });

// A test CA, then a leaf it signs: a key and request, then the certificate with `extensions`.
const makeLeaf = Effect.fnUntraced(function* makeLeaf(
  openssl: string,
  file: (name: string) => string,
  leaf: { readonly extensions: string; readonly name: string; readonly serial: number },
) {
  const fs = yield* FileSystem.FileSystem;
  const pair = { cert: file(`${leaf.name}.pem`), key: file(`${leaf.name}.key`) };
  yield* fs.writeFileString(file(`${leaf.name}.ext`), leaf.extensions);
  yield* runOpenssl(openssl, [
    "req",
    ...ellipticKey,
    "-keyout",
    pair.key,
    "-out",
    file(`${leaf.name}.csr`),
    "-subj",
    `/CN=capture-server ${leaf.name}`,
  ]);
  yield* runOpenssl(openssl, [
    "x509",
    "-req",
    "-in",
    file(`${leaf.name}.csr`),
    "-CA",
    file("ca.pem"),
    "-CAkey",
    file("ca.key"),
    "-set_serial",
    String(leaf.serial),
    "-days",
    "2",
    "-extfile",
    file(`${leaf.name}.ext`),
    "-out",
    pair.cert,
  ]);

  return pair;
});

const serverExtensions = (origin: TlsOriginName) =>
  [
    `subjectAltName=IP:127.0.0.1,DNS:localhost,IP:${tlsOriginAddresses[origin]}`,
    "basicConstraints=CA:FALSE",
    "extendedKeyUsage=serverAuth",
    "",
  ].join("\n");

/**
 * Starts origins A and B: `https` listeners on 127.0.0.1 with distinct ports, each asking every
 * connection for a client certificate, accepting any or none, and recording which it got. The test
 * CA, both server certificates and a client certificate are made with openssl in a temp directory
 * the scope removes, after it stops the listeners. Trust `caPath` (fetch `tls.ca`, or
 * `NODE_EXTRA_CA_CERTS` for a child process) to verify the origins. Scripts are shared by path, as
 * in `startCaptureServer`, so A can answer a 307 or 308 whose `Location` is on B.
 */
export const startTlsCaptureServer = (
  options?: CaptureServerOptions,
): Effect.Effect<
  TlsCaptureServer,
  PlatformError.PlatformError | TlsFixtureUnavailable,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* startTlsCaptureServerGen() {
    const openssl = Bun.which("openssl");
    if (openssl === null) {
      return yield* new TlsFixtureUnavailable({
        message:
          "openssl is not on PATH; the TLS capture server needs it to make its test certificates",
        reason: "openssl-missing",
      });
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "capture-server-tls-" });
    const file = (name: string) => path.join(directory, name);

    yield* runOpenssl(openssl, [
      "req",
      "-x509",
      ...ellipticKey,
      "-keyout",
      file("ca.key"),
      "-out",
      file("ca.pem"),
      "-days",
      "2",
      "-subj",
      "/CN=capture-server test CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign",
    ]);

    const serverCertificates = {
      A: yield* makeLeaf(openssl, file, {
        extensions: serverExtensions("A"),
        name: "A",
        serial: 1,
      }),
      B: yield* makeLeaf(openssl, file, {
        extensions: serverExtensions("B"),
        name: "B",
        serial: 2,
      }),
    };
    const clientCertificate = yield* makeLeaf(openssl, file, {
      extensions: "basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\n",
      name: "client",
      serial: 3,
    });

    const { certificates, listen, server } = yield* Effect.acquireRelease(
      Effect.sync(() => capture<TlsOriginName>(options)),
      (started) => Effect.sync(started.stop),
    );
    const listenTls = (origin: TlsOriginName) =>
      listen(origin, {
        cert: Bun.file(serverCertificates[origin].cert),
        key: Bun.file(serverCertificates[origin].key),
        rejectUnauthorized: false,
        requestCert: true,
      });

    return {
      ...server,
      caPath: file("ca.pem"),
      clientCertificate,
      clientCertificates: certificates,
      origins: {
        A: `https://127.0.0.1:${listenTls("A")}`,
        B: `https://127.0.0.1:${listenTls("B")}`,
      },
      serverCertificates,
    };
  });
