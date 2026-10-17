import { afterAll, beforeAll, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { Effect, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
import { generate } from "../src/index.js";
import { file } from "../src/core/templates/multipart-file.js";

let directory = "";

const upload = {
  properties: {
    attachments: {
      items: { format: "binary", type: "string" },
      maxItems: 2,
      minItems: 1,
      type: "array",
    },
    document: { format: "binary", type: "string" },
    signature: { format: "binary", type: "string" },
    title: { minLength: 2, type: "string" },
  },
  required: ["document"],
  type: "object",
};

const operation = (schema: Schema.Json, required: boolean) => ({
  requestBody: { content: { "multipart/form-data": { schema } }, required },
  responses: { "200": { description: "OK" } },
});

const input = {
  components: { schemas: { Upload: upload } },
  info: { title: "Multipart Proof", version: "1" },
  openapi: "3.1.0",
  paths: {
    "/empty": {
      post: operation({ additionalProperties: false, properties: {}, type: "object" }, true),
    },
    "/optional": { post: operation({ $ref: "#/components/schemas/Upload" }, false) },
    "/upload": { post: operation({ $ref: "#/components/schemas/Upload" }, true) },
  },
};

beforeAll(async () => {
  directory = await mkdtemp(path.join(process.cwd(), ".emission-proof-multipart-"));
  const output = await Effect.runPromise(generate(input));
  expect(output.files.some((entry) => entry.path === "src/models.ts")).toBe(false);
  await symlink(path.resolve("node_modules"), path.join(directory, "node_modules"));
  await Promise.all(
    output.files.map(async (entry) => {
      const target = path.join(directory, entry.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, entry.content);
    }),
  );
  const build = Bun.spawnSync([
    path.resolve("node_modules/.bin/tsc"),
    "--noUnusedLocals",
    "-p",
    directory,
  ]);
  expect({
    code: build.exitCode,
    errors: build.stdout.toString() + build.stderr.toString(),
  }).toMatchObject({ code: 0 });

  const lint = Bun.spawnSync(["bunx", "vp", "lint", "--type-aware", path.join(directory, "src")]);
  expect({
    code: lint.exitCode,
    errors: lint.stdout.toString() + lint.stderr.toString(),
  }).toMatchObject({ code: 0 });
  await writeFile(path.join(directory, "document.bin"), new Uint8Array([0, 255, 128, 10, 13]));
  await writeFile(path.join(directory, "signature.txt"), "signature");
}, 30_000);

afterAll(async () => {
  if (directory !== "") {
    await rm(directory, { force: true, recursive: true });
  }
});

const invoke = async (args: string[]) => {
  const child = Bun.spawn(["node", path.join(directory, "dist/main.js"), ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { code, err, out };
};

const fixture = async () => {
  const requests: { body: Uint8Array; contentType: string | undefined }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      requests.push({
        body: Uint8Array.from(Buffer.concat(chunks)),
        contentType: request.headers["content-type"],
      });
      response.end("accepted");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
    server.address(),
  );

  return { origin: `http://127.0.0.1:${port}`, requests, server };
};

test("named and repeated file parts retain bytes, filenames, text and unknown fields", async () => {
  const { server, requests, origin } = await fixture();
  const document = path.join(directory, "document.bin");
  const signature = path.join(directory, "signature.txt");
  try {
    const result = await invoke([
      "upload",
      "post",
      "--base-url",
      origin,
      "--document",
      document,
      "--signature",
      signature,
      "--attachments",
      document,
      "--attachments",
      signature,
      "--title",
      "caption",
      "--additional-fields",
      '{"custom":"literal","__proto__":"prototype"}',
    ]);
    expect(result.code, result.err).toBe(0);
    expect(requests).toHaveLength(1);

    const [request] = requests;
    expect(request?.contentType).toContain("multipart/form-data; boundary=");

    const response = new Response(request?.body, {
      headers: { "content-type": request?.contentType ?? "" },
    });
    // oxlint-disable-next-line typescript/no-deprecated -- Parse only bytes captured from this trusted local fixture.
    const form = await response.formData();
    const part = form.get("document");
    if (!(part instanceof File)) {
      throw new Error("Expected document file part");
    }

    expect(part.name).toBe("document.bin");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128, 10, 13]));
    expect(form.getAll("attachments")).toHaveLength(2);
    expect(form.get("title")).toBe("caption");
    expect(form.get("custom")).toBe("literal");
    expect(form.get("__proto__")).toBe("prototype");
  } finally {
    await server[Symbol.asyncDispose]();
  }
}, 30_000);

test("optional and empty bodies preserve presence; invalid inputs send no request", async () => {
  const { server, requests, origin } = await fixture();
  const document = path.join(directory, "document.bin");
  try {
    const omitted = await invoke(["optional", "post", "--base-url", origin]);
    expect(omitted.code, omitted.err).toBe(0);
    expect(requests[0]?.body.byteLength).toBe(0);
    expect(requests[0]?.contentType).toBeUndefined();

    const empty = await invoke(["empty", "post", "--base-url", origin]);
    expect(empty.code, empty.err).toBe(0);
    expect(requests[1]?.contentType).toContain("multipart/form-data");

    const missing = await invoke(["optional", "post", "--base-url", origin, "--title", "caption"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("document");

    const collision = await invoke([
      "upload",
      "post",
      "--base-url",
      origin,
      "--document",
      document,
      "--additional-fields",
      '{"document":"override"}',
    ]);
    expect(collision.code).toBe(1);

    const nonexistent = await invoke([
      "upload",
      "post",
      "--base-url",
      origin,
      "--document",
      path.join(directory, "missing.bin"),
    ]);
    expect(nonexistent.code).toBe(1);

    const tooMany = await invoke([
      "upload",
      "post",
      "--base-url",
      origin,
      "--document",
      document,
      "--attachments",
      document,
      "--attachments",
      document,
      "--attachments",
      document,
    ]);
    expect(tooMany.code).toBe(1);
    expect(requests).toHaveLength(2);
  } finally {
    await server[Symbol.asyncDispose]();
  }
}, 30_000);

test("file read failure stays typed and does not expose raw filesystem causes", async () => {
  const failure = await Effect.runPromise(
    Effect.flip(
      file(path.join(directory, "private-missing-file")).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
  expect(failure._tag).toBe("UserError");
  expect(failure.userMessage).toContain("could not be read");
  expect(failure.userMessage).not.toContain("private-missing-file");
});

test("binary content constraints fail instead of checking local path spelling", async () => {
  const constrained = {
    ...input,
    paths: {
      "/upload": {
        post: operation(
          {
            properties: { file: { format: "binary", minLength: 2, type: "string" } },
            type: "object",
          },
          true,
        ),
      },
    },
  };
  const failure = await Effect.runPromise(Effect.flip(generate(constrained)));
  expect(failure.code).toBe("unsupported");
  expect(failure.message).toContain("content constraints");

  const source = await readFile(path.join(directory, "src/commands.ts"), "utf-8");
  expect(source).toContain('Flag.File("attachments"');
  expect(source).toContain("Schema.isMaxLength(2)");
});
