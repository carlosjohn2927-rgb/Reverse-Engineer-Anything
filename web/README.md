# REA web workspace

A browser workspace for `rea-agents` (REA): point it at a binary, an
application, a database or a capture and read the evidence behind every
answer. The server is a thin, local companion process — it never executes the
artifacts you inspect and never uploads them anywhere.

```bash
npm ci --engine-strict=false        # once, at the repository root
npm run build:cached                # builds dist/ that the server drives

cd web
npm install                         # web's own build and test dependencies
npm run build                       # bundles the app into web/dist
npm start                           # http://localhost:4180
```

`npm start` works without a build: the server falls back to the source modules
so `npm run dev` stays a tight loop. A build is what you ship.

REA's toolchain needs Node.js 24; SQLite inspection and several providers fail
outright on older runtimes. The app handles that rather than hiding it: when
the runtime is too old, the workspace shows a banner with the consequence and a
one-click install, and the Setup view carries the same action. The install is
private to this app, needs no privileges, changes nothing global, and is picked
up by new sessions immediately. Point it at an existing install instead with
`REA_WEB_NODE`:

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
scripts/build.mjs       esbuild + lightningcss bundle, fingerprint, shell rewrite
dist/                   build output served in production (git-ignored)
app/js/main.js          boot, routing, store reactions
app/js/store.js         the single observable state object
app/js/api.js           browser client for the HTTP API
app/js/runner.js        schema-driven tool form, streamed progress, results
app/js/families.js      tool -> family map, checked complete by the tests
app/js/completions.js   prompt argument -> completion kind, pinned to REA's contract
app/js/readiness.js     per-operation readiness projection (available/unavailable/unverified)
app/js/host-integrations.js which host runtimes gate which tools, and how to configure them
app/js/evidence-bundle.js what a bundle transfer can and cannot claim
app/js/views/*.js       one module per view
app/js/render/          evidence projections (managed, go, sqlite, entropy, …)
server/index.mjs        HTTP server, CORS, preview framing, shutdown
server/api.mjs          routes: status, doctor, capabilities, host integrations, sessions,
                        calls, prompts, completions, uploads
server/rea-host.mjs     one REA MCP child process per browser session
server/mcp.mjs          raw JSON-RPC client for REA's streamable HTTP MCP mode
server/samples.mjs      the built-in sample artifacts, generated locally
server/evidence-bundle.mjs turns a browser download into an absolute path and back
```

The browser never talks to REA's MCP port directly — it calls this server,
which proxies the call and relays progress notifications as NDJSON.

## Build

`npm run build` produces `web/dist`:

| Asset            | Size  | Gzipped |
| ---------------- | ----- | ------- |
| `app.<hash>.js`  | 54 KB | 18 KB   |
| `app.<hash>.css` | 24 KB | 5.6 KB  |

One script replaces ten module requests. Every asset name carries a content
hash and is served `immutable` for a year, while `index.html` stays `no-cache`
so a deploy is picked up on the next load. The server gzips text responses on
demand, answers `If-None-Match` with `304`, and keeps a bounded cache of
compressed bodies. `npm run build:dev` builds unminified with an inline map.

## Checks

```bash
npm run typecheck     # tsc --noEmit (JSDoc-typed plain JavaScript)
npm run format:check  # oxfmt
npm test              # builds, starts a server, drives the app in jsdom
```

`npm test` runs ten suites. `dist-smoke` loads the **built** bundle — the exact
minified bytes, imported as a real ES module because jsdom does not execute
`<script type="module">` — and asserts the shell references only fingerprinted
assets. `dom-smoke` drives the readable source modules. Both cover: start a
session, generate the built-in samples, pick a suggested analysis, submit the
form, assert a result renders, visit every view, and check the rendered markup
for invalid nesting. `runtime-notice` checks the other half of the runtime
promise: on an old runtime the workspace shows the consequence up front and
offers the install action, and on a current one it shows nothing.
`drawer-dismiss` opens the tool runner and closes it three ways — button, scrim
and Escape — asserting that a closed overlay is both `hidden` and
`display: none`, so an author `display` rule can never leave it on screen.
`catalog-coverage` is the guard on completeness: REA advertises 233 tools and 6
prompts, and nothing may go missing. It checks that every advertised tool is in
exactly one family, that no family claims a tool REA no longer serves, that the
Tools view renders all 233 cards, and that every prompt appears in the
Workflows view with an input per argument. `prompt-completions` pins the
hand-written completion map to what the live server accepts: all 14 arguments
REA completes must be mapped, to the right kind, and the server must answer
every one. `capability-readiness` covers the other half of "can this run": it
pins `POST /api/capabilities` to `rea capabilities`, asserts every unavailable
operation group carries an availability code or a reason, and checks the Setup
view renders both the per-operation groups and the analysis-engine candidates.
It also asserts `doctor` does not cover the host runtimes, which is why the
panel exists. `tool-readiness` pins the projection onto tool names and, most
importantly, its asymmetry: 10 tools are canonically unavailable here, 9 are
confirmed available, and **214 are unverified** — a state that must never be
rendered as a verdict. It asserts blocked cards are marked and explained, that
unverified cards are not marked either way, and that the Tools view states the
unknown count instead of implying everything works. `host-integrations` covers
the third absence: 51 tools need a host runtime — adb, frida, gdb, rizin, jeb,
cutter, tshark, apktool, binwalk, objdump — and those runtimes appear in neither
`capabilities` nor `doctor`, so nothing in the product said whether a tool could
work. `GET /api/host-integrations` reports which settings are set and which
binaries are on `PATH`, by reading the environment and calling `accessSync` —
it never spawns a runtime, so it cannot prove one works, and the payload always
says `verified: false`. The panel therefore states configuration, not
availability, and gives no configured runtime a green dot. On this host all ten
settings are unset and only `objdump` is on `PATH`: one configured, nine not,
and none verified. `evidence-bundle` covers a bug that shipped: the Evidence
view's "Download bundle" button built its own JSON (`rea-web-evidence-summary`)
instead of asking REA, and REA rejects that file with
`evidence_integrity_mismatch` — so a download that looked like archived
evidence could never be imported. REA's four bundle tools all take absolute
local paths, which a browser cannot name or read back; `POST
/api/evidence/export` and `PUT /api/evidence/import` bridge that by choosing a
path inside the session workspace and serving REA's bytes unmodified. The suite
asserts the old shape is still rejected, that an exported bundle has REA's
exact seven-array shape and reimports, that a rejection keeps REA's own code
and merges nothing, and that an empty bundle is reported as valid rather than
as a failure. The runner shuts the server down afterwards and fails if any
REA child process outlived it.

`jsdom` is a dev dependency of `web/`, so a plain `npm install` here is enough.
If it is missing the suites fail rather than passing quietly; set
`REA_WEB_ALLOW_SKIP=1` to skip them deliberately.

`typecheck` runs with `noImplicitAny` off: these are plain JavaScript modules
documented with JSDoc, so inferred `any` is expected at boundaries while strict
null, property and indexing checks stay on. Anything annotated is checked.
