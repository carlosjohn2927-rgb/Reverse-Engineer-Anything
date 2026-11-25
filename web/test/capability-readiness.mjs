/**
 * Operation readiness must be explainable before a tool fails.
 *
 * `rea doctor` reports which engines are installed. It does not say whether a
 * given *operation* can run, and it never inspects the host-dependent
 * integrations (adb, frida, gdb, rizin, jeb, cutter) behind 51 of the 233
 * tools. The workspace therefore showed a green Setup page and then failed
 * with `capability_unavailable` on first use.
 *
 * `POST /api/capabilities` surfaces `rea capabilities`, which answers per
 * provider and per operation group with a machine-readable availability code
 * and a remediation. This suite pins the contract, checks the Setup view
 * renders it, and asserts the two panels are complementary rather than
 * duplicating each other.
 *
 *   node web/test/capability-readiness.mjs http://127.0.0.1:4180
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
      "capability-readiness: jsdom is not installed; skipping (REA_WEB_ALLOW_SKIP=1).",
    );
    process.exit(0);
  }
  console.error(
    "capability-readiness: jsdom is required for this check. Install it with " +
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

// ---- The route -----------------------------------------------------------
const session = await fetch(`${base}/api/sessions`, { method: "POST" }).then(
  (response) => response.json(),
);
check("a session starts", typeof session.sessionId === "string");

const headers = {
  "content-type": "application/json",
  "x-rea-session": session.sessionId,
};

const startedAt = Date.now();
const response = await fetch(`${base}/api/capabilities`, {
  method: "POST",
  headers,
  body: JSON.stringify({}),
});
const payload = await response.json();
const durationMs = Date.now() - startedAt;

check(
  "the capabilities route answers",
  response.status === 200,
  `${response.status} in ${durationMs} ms`,
);
check("the route does not hang", durationMs < 60_000, `${durationMs} ms`);

const providers = payload.capabilities ?? [];
check(
  "providers are reported",
  providers.length > 0,
  `${providers.length} providers`,
);

// Every group must be machine-classifiable: available or carrying a code that
// says why not. A group that is unavailable with no code or reason is a dead
// end for the user.
const groups = providers.flatMap((entry) =>
  (entry.groups ?? []).map((group) => ({
    providerId: entry.provider?.id,
    group,
  })),
);
check(
  "operation groups are reported",
  groups.length > 0,
  `${groups.length} groups`,
);

const unexplained = groups.filter(
  (row) =>
    row.group.available !== true &&
    typeof row.group.availability_code !== "string" &&
    typeof row.group.reason !== "string",
);
check(
  "every unavailable group says why",
  unexplained.length === 0,
  unexplained
    .map((row) => `${row.providerId}:${row.group.operations?.[0]}`)
    .join(", "),
);

const available = groups.filter((row) => row.group.available === true).length;
check(
  "at least one group is available without setup",
  available > 0,
  `${available} of ${groups.length}`,
);
check(
  "group availability is not uniform",
  available < groups.length,
  `${available} available, ${groups.length - available} not — the panel must show both`,
);

// Each group names the operations it serves, so a failing tool is traceable.
const nameless = groups.filter(
  (row) =>
    !Array.isArray(row.group.operations) || row.group.operations.length === 0,
);
check("every group names its operations", nameless.length === 0);

// ---- The analysis engines -------------------------------------------------
const candidates = payload.analysis_provider_candidates ?? [];
check(
  "analysis engine candidates are reported",
  candidates.length > 0,
  candidates.map((candidate) => candidate.provider?.id).join(", "),
);
const malformed = candidates.filter(
  (candidate) =>
    typeof candidate.provider?.id !== "string" ||
    typeof candidate.availability?.status !== "string",
);
check("every candidate has an id and a status", malformed.length === 0);
check(
  "unavailable engines carry a reason",
  candidates
    .filter((candidate) => candidate.availability?.status !== "available")
    .every((candidate) => typeof candidate.availability?.reason === "string"),
);

// ---- The two panels are complementary, not duplicates ---------------------
// This is the whole reason the route exists: doctor omits the host runtimes.
const doctor = await fetch(`${base}/api/doctor`).then((r) => r.json());
const doctorRaw = JSON.stringify(doctor).toLowerCase();
const doctorCandidates = (doctor.providerInspections ?? []).map(
  (provider) => provider.id,
);
check(
  "doctor covers the analysis engines",
  doctorCandidates.includes("ghidra"),
  doctorCandidates.join(", "),
);
const hostRuntimes = ["adb", "frida", "gdb", "rizin", "jeb", "cutter"];
const missingFromDoctor = hostRuntimes.filter(
  (name) => !doctorRaw.includes(name),
);
check(
  "doctor does not cover the host runtimes",
  missingFromDoctor.length === hostRuntimes.length,
  missingFromDoctor.length === hostRuntimes.length
    ? "none covered, so capabilities is the only source"
    : `doctor covers: ${hostRuntimes.filter((n) => !missingFromDoctor.includes(n)).join(", ")}`,
);

// ---- The Setup view renders it -------------------------------------------
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

const setupButton = window.document.querySelector(
  '.rail-link[data-view="setup"]',
);
check("the rail offers Setup", setupButton !== null);
setupButton?.click();

// The panel paints its title synchronously as "Loading…"; the rows only
// appear once `/api/capabilities` resolves. Wait for the data, not the frame,
// or every assertion below races the fetch.
const loaded = await until(
  () => state.capabilities !== null && state.capabilities !== undefined,
);
check("capabilities load into the store", loaded);
const rendered = await until(() => {
  const panels = [...window.document.querySelectorAll(".panel")];
  return panels.some(
    (panel) =>
      (panel.textContent ?? "").includes("Operation readiness") &&
      !(panel.textContent ?? "").includes("Loading rea capabilities"),
  );
});
check("the Setup view renders operation readiness", rendered);

const text = window.document.getElementById("view-root")?.textContent ?? "";
check(
  "the panel reports a group count",
  /operation groups? available/i.test(text),
  /(\d+) of (\d+) operation groups? available/iu.exec(text)?.[0] ?? "",
);
check(
  "the panel lists operation names",
  text.includes("inspect_managed_artifact") ||
    text.includes("inspect_artifact"),
  "",
);
check(
  "the panel shows analysis engine readiness",
  /Analysis engines/.test(text) && /ghidra/i.test(text),
);
check(
  "an unavailable group explains itself",
  /not_configured|unsupported_host|executable_missing|Set [A-Z_]+/u.test(text),
  "",
);

// Re-check must be actionable, not decorative.
const retry = [...window.document.querySelectorAll("button")].find(
  (button) => button.textContent === "Re-check",
);
check("the panel offers a re-check action", retry !== undefined);

check("no runtime errors", errors.length === 0, errors.join(" | "));

await fetch(`${base}/api/sessions`, {
  method: "DELETE",
  headers,
}).catch(() => undefined);

if (failures.length > 0) {
  console.error(`\ncapability-readiness: ${failures.length} failure(s).`);
  process.exit(1);
}
console.log("\ncapability-readiness: all checks passed.");
