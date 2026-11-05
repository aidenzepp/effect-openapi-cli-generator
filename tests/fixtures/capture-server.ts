export type OriginName = "127.0.0.1" | "localhost";

export type HeaderList = readonly (readonly [name: string, value: string])[];

export interface RecordedRequest {
  readonly body: Uint8Array;
  readonly connection: number;
  readonly headers: HeaderList;
  readonly method: string;
  readonly origin: OriginName;
  readonly target: string;
}

export interface ConnectionEvent {
  readonly connection: number;
  readonly kind: "close" | "open";
  readonly origin: OriginName;
}

export interface ScriptedResponse {
  readonly body?: string;
  readonly endless?: true;
  readonly headers?: HeaderList;
  readonly location?: string;
  readonly status: number;
}

export interface CaptureServerOptions {
  readonly canary?: true;
}

export interface CaptureServer {
  readonly connections: () => number;
  readonly events: () => readonly ConnectionEvent[];
  readonly origins: Readonly<Record<OriginName, string>>;
  readonly requests: () => readonly RecordedRequest[];
  readonly script: (path: string, response: ScriptedResponse) => void;
  readonly stop: () => void;
}

interface Connection {
  buffer: Buffer;
  readonly id: number;
  readonly origin: OriginName;
  timer: ReturnType<typeof setInterval> | null;
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

const head = (response: ScriptedResponse, length: number | null) => {
  const lines = [
    `HTTP/1.1 ${response.status} Scripted`,
    ...(response.headers ?? []).map(([name, value]) => `${name}: ${value}`),
    ...(response.location === undefined ? [] : [`Location: ${response.location}`]),
    length === null ? "Transfer-Encoding: chunked" : `Content-Length: ${length}`,
  ];

  return `${lines.join("\r\n")}\r\n\r\n`;
};

// A raw TCP listener, not Bun.serve: Bun.serve sorts and merges headers, rewrites the target
// into an absolute URL and exposes no connection lifecycle, so it cannot record bytes as sent.
export const startCaptureServer = (options?: CaptureServerOptions): CaptureServer => {
  const requests: RecordedRequest[] = [];
  const events: ConnectionEvent[] = [];
  const scripts = new Map<string, ScriptedResponse>();
  let connections = 0;

  const respond = (socket: Bun.Socket<Connection>, request: RecordedRequest) => {
    const path = request.target.split("?")[0] ?? "";
    const scripted = scripts.get(path) ?? defaultResponse;
    const echoes = options?.canary === true && (scripted.status === 401 || scripted.status === 500);
    const body = echoes ? (headerValue(request.headers, "authorization") ?? "") : scripted.body;

    if (scripted.endless === true) {
      socket.write(head(scripted, null));
      socket.data.timer = setInterval(() => {
        socket.write("5\r\nchunk\r\n");
      }, 10);

      return;
    }

    const bytes = Buffer.from(body ?? "");
    socket.write(Buffer.concat([Buffer.from(head(scripted, bytes.length), "latin1"), bytes]));

    if (headerValue(request.headers, "connection")?.toLowerCase() === "close") {
      socket.end();
    }
  };

  const listen = (hostname: OriginName) =>
    Bun.listen<Connection>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        close: (socket) => {
          if (socket.data.timer !== null) {
            clearInterval(socket.data.timer);
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
            respond(socket, request);
            parsed = parseRequest(state.buffer);
          }
        },
        open: (socket) => {
          connections += 1;
          socket.data = {
            buffer: Buffer.alloc(0),
            id: connections,
            origin: hostname,
            timer: null,
          };
          events.push({ connection: connections, kind: "open", origin: hostname });
        },
      },
    });

  const listeners = { "127.0.0.1": listen("127.0.0.1"), localhost: listen("localhost") };

  return {
    connections: () => connections,
    events: () => events,
    origins: {
      "127.0.0.1": `http://127.0.0.1:${listeners["127.0.0.1"].port}`,
      localhost: `http://localhost:${listeners.localhost.port}`,
    },
    requests: () => requests,
    script: (path, response) => {
      scripts.set(path, response);
    },
    stop: () => {
      listeners["127.0.0.1"].stop(true);
      listeners.localhost.stop(true);
    },
  };
};
