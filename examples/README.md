# Run the generated CLIs

These are concrete generator inputs and outputs, committed for inspection. Generated source is in each `cli/src/` directory. Neither CLI needs this generator at runtime.

Run the commands below from this repository root:

```sh
cd /Users/sterling/.codex/worktrees/openapi-generator/effect-openapi-cli-generator
```

## Friendly local demo

`demo/openapi.json` describes users, posts, and file metadata. This is a new readable demo, not the integration-test fixture. It uses no external API or authentication. Posts are echoed, not saved; files return metadata, not uploaded/downloaded bytes.

Build the generated CLI once:

```sh
(cd examples/demo/cli && bun install && bun run build)
```

Start the server in another terminal, from the repository root:

```sh
bun examples/demo/server.ts
```

It binds only `127.0.0.1:43123`, logs each request, and prints its PID. Stop with Ctrl-C. If the port is occupied, use `PORT=43124 bun examples/demo/server.ts` and change `--base-url` below accordingly. A server started during preparation may already occupy 43123; use that instance or stop it before restarting.

```sh
node examples/demo/cli/dist/main.js --help
node examples/demo/cli/dist/main.js users list --active false --base-url http://127.0.0.1:43123/api
node examples/demo/cli/dist/main.js users get ada --base-url http://127.0.0.1:43123/api
node examples/demo/cli/dist/main.js posts create --body '{"title":"Hello","published":false}' --base-url http://127.0.0.1:43123/api
node examples/demo/cli/dist/main.js posts create --body-file examples/demo/post.json --base-url http://127.0.0.1:43123/api
node examples/demo/cli/dist/main.js files get 'folder/hello' --base-url http://127.0.0.1:43123/api
```

| Command                        | HTTP endpoint                   | Expected JSON                                                      |
| ------------------------------ | ------------------------------- | ------------------------------------------------------------------ |
| `users list --active false`    | `GET /api/users?active=false`   | `[{"id":"grace","name":"Grace","active":false}]`                   |
| `users get ada`                | `GET /api/users/ada`            | `{"id":"ada","name":"Ada","active":true}`                          |
| `posts create --body ...`      | `POST /api/posts`               | `{"id":"post-demo","title":"Hello","published":false}`             |
| `posts create --body-file ...` | `POST /api/posts`               | `{"id":"post-demo","title":"Hello from a file","published":false}` |
| `files get 'folder/hello'`     | `GET /api/files/folder%2Fhello` | `{"id":"folder/hello","name":"hello.txt","bytes":12}`              |

The CLI prints the response without adding a newline. Unknown users return HTTP 404 and a nonzero CLI exit.

## Exact integration fixture

`integration/openapi.json` is the JSON serialization of `document` in `tests/integration.test.ts`, including its `parameter`/`operation` helpers. It preserves the hostile quotes, backticks, interpolation-like text, comment terminator, newline, `@tag`, and own `__proto__` schema property. These are deliberate code-generation safety inputs. Its generated output is `integration/cli/`; it is not the friendly users/posts/files API.

```sh
(cd examples/integration/cli && bun install && bun run build)
node examples/integration/cli/dist/main.js --help
node examples/integration/cli/dist/main.js account deep items get --help
```

The test suite supplies its own temporary capture server and proves HTTP semantics. The friendly server does not implement those fixture endpoints. A corresponding command against a capture server would be:

```sh
node examples/integration/cli/dist/main.js account deep items get 'a/b雪' --parent 'p/q' --enabled false --count 0 --wire-name '' --body '{"enabled":false,"__proto__":{"safe":true}}' --base-url http://127.0.0.1:CAPTURE_PORT/api
```

Replace `CAPTURE_PORT` with a real capture server port; this is a template, not a command for the friendly server. Despite its command name `get`, this operation sends **POST**.

## Regenerate after generator changes

These outputs were regenerated from the readable source refactor and verified with the current repository tools. To compare a fresh build without overwriting either checked-in output:

```sh
bun run build
node dist/cli.js --input examples/integration/openapi.json --output examples/integration/cli-next
node dist/cli.js --input examples/demo/openapi.json --output examples/demo/cli-next
```

Output directories must not already exist. Inspect the new output before replacing the reviewed `cli/` trees. Dependencies, build output, and example Bun lockfiles are ignored; source, package metadata, and TypeScript configs remain reviewable.

## Verification

The regenerated sources pass repository formatting, type-aware lint, and TypeScript checks; both generated packages build. The full test suite also installs the packed generator outside this checkout and exercises generated HTTP requests, including false, zero, empty strings, own `__proto__` keys, encoded slashes, errors, and interruption. The friendly demo post schema allows only `title` and `published`; preservation of extra keys and zero belongs to the exact integration fixture.
