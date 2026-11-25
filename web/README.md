# REA web workspace

A browser workspace for `rea-agents` (REA): point it at a binary, an
application, a database or a capture and read the evidence behind every
answer. The server is a thin, local companion process — it never executes the
artifacts you inspect and never uploads them anywhere.

```bash
npm ci --engine-strict=false        # once, at the repository root
npm run build:cached                # builds dist/ that the server drives

cd web
npm start                           # http://localhost:4180
```

REA's toolchain needs Node.js 24. If the server's own runtime is older, it
provisions a private copy on first use (the Setup view shows progress and can
retry it). Point it at an existing install instead with `REA_WEB_NODE`:

```bash
REA_WEB_NODE=/path/to/node24/bin/node npm start
```

## Configuration

| Variable                   | Default                       | Meaning                                      |
| -------------------------- | ----------------------------- | -------------------------------------------- |
| `REA_WEB_PORT` / `PORT`    | `4180`                        | Listen port.                                 |
| `REA_WEB_HOST`             | `0.0.0.0`                     | Bind address.                                |
| `REA_WEB_NODE`             | probed                        | Node.js 24+ binary used to run REA.          |
| `REA_WEB_WORKSPACE`        | `~/.local/rea-web/workspaces` | Per-session upload directories.              |
| `REA_WEB_ALLOWED_ORIGINS`  | —                             | Extra exact browser origins allowed by CORS. |
| `REA_WEB_SESSION_TTL_MS`   | `600000`                      | Idle time before a session is reaped.        |
| `REA_WEB_SESSION_SWEEP_MS` | `60000`                       | How often idle sessions are swept.           |
| `REA_WEB_MAX_SESSIONS`     | `8`                           | Hard cap on concurrent session processes.    |

Sessions are owned by the browser: each one gets its own REA MCP child process
and workspace directory. Closing the tab sends `DELETE /api/sessions`, and a
session that goes idle without one is reaped, so a browser that disappears
cannot leak processes or memory.

## How it is put together

```
app/index.html          shell: rail navigation, top bar, drawer, palette
app/js/main.js          boot, routing, store reactions
app/js/store.js         the single observable state object
app/js/api.js           browser client for the HTTP API
app/js/runner.js        schema-driven tool form, streamed progress, results
app/js/views/*.js       one module per view
app/js/render/          evidence projections (managed, go, sqlite, entropy, …)
server/index.mjs        HTTP server, CORS, preview framing, shutdown
server/api.mjs          routes: status, doctor, sessions, calls, uploads
server/rea-host.mjs     one REA MCP child process per browser session
server/mcp.mjs          raw JSON-RPC client for REA's streamable HTTP MCP mode
server/samples.mjs      the built-in sample artifacts, generated locally
```

The browser never talks to REA's MCP port directly — it calls this server,
which proxies the call and relays progress notifications as NDJSON.

## Checks

```bash
npm run typecheck     # tsc --noEmit (JSDoc-typed plain JavaScript)
npm run format:check  # oxfmt
npm test              # starts a server, drives the app in jsdom
```

`npm test` needs `jsdom` to be resolvable; without it the suite reports a skip
rather than failing. It exercises the whole path: start a session, generate the
built-in samples, pick a suggested analysis, submit the form and assert that a
result renders, then visit every view.

`typecheck` runs with `noImplicitAny` off: these are plain JavaScript modules
documented with JSDoc, so inferred `any` is expected at boundaries while strict
null, property and indexing checks stay on. Anything annotated is checked.
