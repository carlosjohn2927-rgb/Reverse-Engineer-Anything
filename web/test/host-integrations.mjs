/**
 * The integrations behind 51 tools must at least be visible.
 *
 * adb (24 tools), frida (8), gdb (4), rizin (4), jeb (4), cutter (2) and the
 * tshark/apktool/binwalk set appear in **neither** `rea doctor` nor
 * `rea capabilities` — verified against live payloads, which mention none of
 * them. So the workspace said nothing at all about the tools most likely to
 * fail on a fresh machine.
 *
 * The trap is labelling. This probe only observes whether a setting is present
 * or a binary resolves on PATH; it never runs them. "Configured adb" must not
 * become "adb available", because no device is required to be attached. This
 * suite pins that distinction, plus the two things that would make the panel
 * dangerous: a green tick for presence, and a verdict when the probe failed.
 *
 *   node web/test/host-integrations.mjs http://127.0.0.1:4180
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const base = process.argv[2] ?? "http://127.0.0.1:4180";

let JSDOM;
try {
  const require = createRequire(import.meta.url);
  ({ JSDOM } = require("jsdom"));
} catch {
  if (process.env.REA_WEB_ALLOW_SKIP === "1") {
    console.log(
      "host-integrations: jsdom is not installed; skipping (REA_WEB_ALLOW_SKIP=1).",
    );
    process.exit(0);
  }
  console.error(
    "host-integrations: jsdom is required for this check. Install it with " +
      "`npm i -D jsdom` or set REA_WEB_ALLOW_SKIP=1 to skip.",
  );
  process.exit(1);
}

const failures = [];
const check = (label, ok, detail = "") => {
  if (!ok) failures.push(`${label} ${detail}`.trim());
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` — ${detail}`}`,
  );
};

const { HOST_INTEGRATIONS, classifyIntegration, CONFIGURED_IS_NOT_VERIFIED } =
  await import(
    pathToFileURL(
      new URL("../app/js/host-integrations.js", import.meta.url).pathname,
    ).href
  );

// ---- The classification rules -------------------------------------------
check(
  "the integration list covers the tool-gating runtimes",
  ["adb", "frida", "gdb", "rizin", "jeb", "cutter"].every((id) =>
    HOST_INTEGRATIONS.some((integration) => integration.id === id),
  ),
  HOST_INTEGRATIONS.map((integration) => integration.id).join(", "),
);
check(
  "every integration names a setting and a remediation",
  HOST_INTEGRATIONS.every(
    (integration) =>
      integration.env.length > 0 && integration.remediation.length > 20,
  ),
);

const empty = { env: {}, onPath: [] };
check(
  "nothing observed means not configured, never configured",
  HOST_INTEGRATIONS.every(
    (integration) =>
      classifyIntegration(integration, empty).state === "not_configured",
  ),
);

const adb = HOST_INTEGRATIONS.find((integration) => integration.id === "adb");
check(
  "an env var marks the integration configured",
  classifyIntegration(adb, { env: { REA_ADB_PATH: "/opt/adb" }, onPath: [] })
    .state === "configured",
);
check(
  "a binary on PATH marks it configured, and says how",
  classifyIntegration(adb, { env: {}, onPath: ["adb"] }).via === "PATH:adb",
);
check(
  "blank env values do not count as configured",
  classifyIntegration(adb, { env: { REA_ADB_PATH: "   " }, onPath: [] })
    .state === "not_configured",
);
check(
  "an integration with no PATH fallback ignores unrelated binaries",
  classifyIntegration(
    HOST_INTEGRATIONS.find((integration) => integration.id === "jeb"),
    { env: {}, onPath: ["jeb"] },
  ).state === "not_configured",
);
check(
  "the caveat distinguishes configuration from function",
  CONFIGURED_IS_NOT_VERIFIED.includes("does not mean the runtime works"),
);

// ---- The live probe ------------------------------------------------------
const startedAt = Date.now();
const response = await fetch(`${base}/api/host-integrations`);
const observed = await response.json();

check(
  "the probe answers",
  response.status === 200,
  `${response.status} in ${Date.now() - startedAt} ms`,
);
check(
  "the probe never claims verification",
  observed.verified === false,
  `verified=${observed.verified}`,
);
check(
  "the probe reports the settings it looked for",
  typeof observed.env === "object" && observed.env !== null,
  Object.keys(observed.env ?? {}).length + " settings",
);
check(
  "the probe reports PATH hits as a list",
  Array.isArray(observed.onPath),
  (observed.onPath ?? []).join(", ") || "none",
);

// The settings REA documents must actually be the ones we read.
const documented = ["REA_ADB_PATH", "REA_GDB_COMMAND", "REA_RIZIN_COMMAND"];
const missing = documented.filter((name) => !(name in (observed.env ?? {})));
check(
  "the documented settings are all probed",
  missing.length === 0,
  missing.join(", "),
);

// ---- Neither doctor nor capabilities reports these -----------------------
// This is the reason the panel exists; if REA ever gains coverage here, the
// panel should shrink rather than duplicate.
const doctor = await fetch(`${base}/api/doctor`).then((r) => r.json());
const session = await fetch(`${base}/api/sessions`, { method: "POST" }).then(
  (r) => r.json(),
);
const headers = {
  "content-type": "application/json",
  "x-rea-session": session.sessionId,
};
const capabilities = await fetch(`${base}/api/capabilities`, {
  method: "POST",
  headers,
  body: JSON.stringify({}),
}).then((r) => r.json());

const ids = ["adb", "frida", "gdb", "rizin", "jeb", "cutter"];
const reported = new Set(
  (capabilities.capabilities ?? []).flatMap((entry) =>
    (entry.groups ?? []).flatMap((group) => group.operations ?? []),
  ),
);
const doctorRaw = JSON.stringify(doctor).toLowerCase();
const gatedTools = session.tools
  .filter((tool) => tool.hostDependent === true)
  .map((tool) => tool.name);
check(
  "the catalog flags the tools these integrations gate",
  gatedTools.length > 0,
  `${gatedTools.length} host-dependent tools`,
);
check(
  "none of them are in the capability report",
  gatedTools.every((name) => !reported.has(name)),
  `${gatedTools.filter((name) => reported.has(name)).length} unexpectedly reported`,
);
check(
  "doctor mentions none of these runtimes",
  ids.every((id) => !doctorRaw.includes(id)),
  ids.filter((id) => doctorRaw.includes(id)).join(", ") || "none",
);

// ---- The Setup panel ----------------------------------------------------
const html = readFileSync(
  new URL("../app/index.html", import.meta.url),
  "utf8",
);
const dom = new JSDOM(html, {
  url: `${base}/`,
  pretendToBeVisual: true,
  runScripts: "outside-only",
});
const { window } = dom;
const errors = [];

const realFetch = globalThis.fetch;
const shim = async (input, init) => {
  let raw = typeof input === "string" ? input : (input?.url ?? String(input));
  if (raw.startsWith("/")) raw = `${base}${raw}`;
  const upstream = await realFetch(raw, init);
  const text = await upstream.text();
  return {
    ok: upstream.ok,
    status: upstream.status,
    headers: upstream.headers,
    text: async () => text,
    json: async () => JSON.parse(text),
    body: {
      getReader() {
        const buffer = Buffer.from(text, "utf8");
        let sent = false;
        return {
          async read() {
            if (sent) return { value: undefined, done: true };
            sent = true;
            return { value: new Uint8Array(buffer), done: false };
          },
        };
      },
    },
  };
};
const define = (key, value) => {
  try {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  } catch {
    // A non-configurable sandbox global keeps its own value.
  }
};
for (const key of [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "HTMLElement",
  "Node",
  "CustomEvent",
  "Event",
  "NodeFilter",
  "MutationObserver",
  "TextDecoder",
  "TextEncoder",
])
  if (window[key] !== undefined) define(key, window[key]);
define("fetch", shim);
window.fetch = shim;
window.HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
window.HTMLDialogElement.prototype.close = function () {
  this.open = false;
};
window.URL.createObjectURL = () => "blob:mock";
process.on("unhandledRejection", (reason) =>
  errors.push(
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  ),
);

const moduleUrl = (path) =>
  pathToFileURL(new URL(`../app/js/${path}`, import.meta.url).pathname).href;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, timeout = 90_000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (predicate()) return true;
    } catch {
      // Still rendering.
    }
    await wait(150);
  }
  return false;
};

await import(moduleUrl("main.js"));
const { state } = await import(moduleUrl("store.js"));
await until(() => state.sessionReady);
window.document.querySelector('.rail-link[data-view="setup"]')?.click();

const loaded = await until(
  () => state.hostIntegrations !== null && state.hostIntegrations !== undefined,
);
check("the Setup view loads host integrations", loaded);

const rendered = await until(() =>
  (window.document.getElementById("view-root")?.textContent ?? "").includes(
    "Host integrations",
  ),
);
check("the Setup view renders the host integrations panel", rendered);

const text = window.document.getElementById("view-root")?.textContent ?? "";
check(
  "the panel states how many are configured",
  /\d+ of \d+ configured/u.test(text),
  /(\d+ of \d+ configured[^·]*)/u.exec(text)?.[0] ?? "",
);
check(
  "the panel states how many tools depend on them",
  /(\d+) tools depend on these/u.test(text),
  /(\d+) tools depend on these/u.exec(text)?.[0] ?? "",
);
check(
  "the panel names the runtimes",
  ["adb", "frida", "gdb", "rizin", "jeb", "cutter"].every((id) =>
    text.toLowerCase().includes(id),
  ),
);
check(
  "the panel carries the configuration-is-not-availability caveat",
  text.includes("Configuration is not availability"),
);
check(
  "the panel shows a remediation for unconfigured runtimes",
  /Set REA_|make .* available on PATH|Start a JEB client/u.test(text),
);
// The dangerous rendering: a green dot for a configured-but-unverified runtime.
const configuredRows = [
  ...window.document.querySelectorAll(".check-row"),
].filter((row) => (row.textContent ?? "").includes("configured"));
check(
  "a configured runtime is never shown as healthy",
  configuredRows.every((row) => row.querySelector(".dot.ok") === null),
  `${configuredRows.filter((row) => row.querySelector(".dot.ok") !== null).length} green`,
);

check("no runtime errors", errors.length === 0, errors.join(" | "));

await fetch(`${base}/api/sessions`, {
  method: "DELETE",
  headers,
}).catch(() => undefined);

if (failures.length > 0) {
  console.error(`\nhost-integrations: ${failures.length} failure(s).`);
  process.exit(1);
}
console.log("\nhost-integrations: all checks passed.");
