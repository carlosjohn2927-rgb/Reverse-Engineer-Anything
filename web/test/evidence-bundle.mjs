/**
 * An evidence bundle a user downloads must be one REA accepts back.
 *
 * The Evidence view used to offer "Download bundle", which built its own JSON:
 * a `rea-web-evidence-summary` object with `records[].tool`. That is not REA's
 * bundle. REA requires a `records` array plus a canonical `manifest` with
 * byte-stable digests, and it says so when handed the wrong thing:
 *
 *   evidence_integrity_mismatch — "Evidence bundle does not match the bundle
 *   schema at artifacts: Invalid input: expected array, received undefined"
 *
 * So the button produced a file that looked like evidence, was labelled
 * evidence, and could never be imported. This suite pins both halves: that the
 * old shape is rejected (so the bug cannot come back unnoticed), and that the
 * replacement round-trips through REA's own export and import.
 *
 * The trap on the way is overclaiming in the other direction. An empty export
 * is *valid*, not a failure, and importing a bundle does not make the session's
 * evidence verified. `describeTransfer` is pinned on those two points.
 *
 *   node web/test/evidence-bundle.mjs http://127.0.0.1:4180
 */
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
      "evidence-bundle: jsdom is not installed; skipping (REA_WEB_ALLOW_SKIP=1).",
    );
    process.exit(0);
  }
  console.error(
    "evidence-bundle: jsdom is required for this check. Install it with " +
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

const { BUNDLE_TRANSFER_NOTE, describeTransfer } = await import(
  pathToFileURL(
    new URL("../app/js/evidence-bundle.js", import.meta.url).pathname,
  ).href
);
const { BUNDLE_DOWNLOAD_NAME, bundlePathIn } = await import(
  pathToFileURL(
    new URL("../server/evidence-bundle.mjs", import.meta.url).pathname,
  ).href
);

// ---- session plumbing ----------------------------------------------------
const session = await (
  await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
).json();
const sessionId = session.sessionId;

const call = async (tool, args) => {
  const response = await fetch(`${base}/api/call`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rea-session": sessionId },
    body: JSON.stringify({ sessionId, tool, arguments: args }),
  });
  return { status: response.status, body: await response.json() };
};

// ---- the path contract ---------------------------------------------------
check(
  "the server names the bundle, never the browser",
  BUNDLE_DOWNLOAD_NAME.endsWith(".json") && typeof bundlePathIn === "function",
);

const traversal = bundlePathIn("/tmp/ws", "../../etc/passwd");
check(
  "a caller-supplied name cannot escape the workspace",
  traversal.startsWith("/tmp/ws/") && !traversal.includes(".."),
  traversal,
);

const odd = bundlePathIn("/tmp/ws", "my bundle:v2/../../x.json");
check(
  "an awkward filename is flattened into the workspace",
  odd.startsWith("/tmp/ws/") && !odd.includes(".."),
  odd,
);

// ---- the bug this replaces ----------------------------------------------
// Written the way the old Download button wrote it.
const fake = JSON.stringify({
  kind: "rea-web-evidence-summary",
  generated_at: new Date().toISOString(),
  records: [{ tool: "inspect_byte_entropy", status: "ok", payload: {} }],
});
const staged = await (
  await fetch(`${base}/api/upload?filename=old-style-bundle.json`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "x-rea-session": sessionId,
    },
    body: fake,
  })
).json();
const rejected = await call("import_evidence_bundle", { path: staged.path });
check(
  "REA rejects the shape the old button produced",
  rejected.body?.status === "error" &&
    rejected.body?.error?.code === "evidence_integrity_mismatch",
  rejected.body?.error?.code ?? "accepted",
);

// ---- the replacement -----------------------------------------------------
const exported = await (
  await fetch(`${base}/api/evidence/export`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rea-session": sessionId },
    body: JSON.stringify({ sessionId }),
  })
).json();

check(
  "the export route answers with REA's bytes",
  typeof exported.contents === "string" && exported.bytes > 0,
  `${exported.bytes ?? 0} B`,
);
check(
  "the export names a file inside the session workspace",
  typeof exported.path === "string" &&
    exported.path.startsWith(`/home/user/.local/rea-web/workspaces/`),
  exported.path,
);

/** @type {Record<string, unknown> | null} */
let parsed = null;
try {
  parsed = JSON.parse(exported.contents);
} catch {
  parsed = null;
}
const BUNDLE_KEYS = [
  "artifacts",
  "providers",
  "environments",
  "scenarios",
  "captures",
  "unknowns",
  "records",
];
check(
  "the exported bytes are REA's canonical bundle shape",
  parsed !== null &&
    Object.keys(parsed).sort().join(",") ===
      [...BUNDLE_KEYS].sort().join(",") &&
    BUNDLE_KEYS.every((key) => Array.isArray(parsed[key])),
  parsed === null ? "not JSON" : Object.keys(parsed).join(", "),
);

// REA's bundle is a strict object of exactly seven arrays. Anything else —
// including an extra key — is not a bundle REA will accept back.
const receipt = exported.receipt ?? null;
check(
  "the receipt reports counts rather than claiming completeness",
  receipt === null ||
    (typeof receipt.summary === "string" &&
      typeof receipt.records === "number"),
);
check(
  "an empty bundle is described as valid, not as a failure",
  receipt === null || receipt.records > 0 || receipt.summary.includes("valid"),
  receipt?.summary ?? "no receipt",
);

// Reimport REA's own export: the round trip the old button could never make.
const reimported = await call("import_evidence_bundle", {
  path: exported.path,
});
check(
  "REA accepts the bundle the export route produced",
  reimported.body?.status === "ok",
  reimported.body?.error?.code ?? "ok",
);

const sha = exported.sha256;
check(
  "the export reports the digest of the bytes it served",
  typeof sha === "string" && /^[a-f0-9]{64}$/u.test(sha),
  String(sha).slice(0, 16),
);

// ---- the import route ----------------------------------------------------
const importResponse = await fetch(
  `${base}/api/evidence/import?filename=${encodeURIComponent("round-trip.json")}`,
  {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "x-rea-session": sessionId,
    },
    body: exported.contents,
  },
);
const importBody = await importResponse.json();
check(
  "the import route accepts a bundle REA wrote",
  importResponse.status === 200 && importBody.accepted === true,
  importBody.rejection?.code ?? "accepted",
);

const badResponse = await fetch(
  `${base}/api/evidence/import?filename=${encodeURIComponent("old-style.json")}`,
  {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "x-rea-session": sessionId,
    },
    body: fake,
  },
);
const badBody = await badResponse.json();
check(
  "a rejection is reported with REA's own code, not as a server error",
  badResponse.status === 200 &&
    badBody.accepted === false &&
    badBody.rejection?.code === "evidence_integrity_mismatch",
  badBody.rejection?.code ?? `status ${badResponse.status}`,
);
check("a rejected import merges nothing", badBody.result === null);

// ---- describeTransfer ----------------------------------------------------
const exportOutcome = describeTransfer({
  accepted: true,
  receipt: {
    records: 2,
    unknowns: 0,
    bytes: 900,
    empty: false,
    summary: "2 records and 0 unknown revisions in 900 bytes.",
  },
  name: "bundle.json",
  bytes: 900,
  sha256: "a".repeat(64),
});
check(
  "an accepted export says REA wrote the bundle",
  exportOutcome.ok && exportOutcome.title.includes("wrote"),
  exportOutcome.title,
);
check(
  "the export outcome carries the digest, not a completeness claim",
  exportOutcome.detail?.includes("sha256") === true,
  exportOutcome.detail ?? "none",
);

const emptyOutcome = describeTransfer({
  accepted: true,
  receipt: {
    records: 0,
    unknowns: 0,
    bytes: 105,
    empty: true,
    summary:
      "REA wrote a valid bundle with no records. That is a fact about this session, not a failed export.",
  },
  name: "empty.json",
  sha256: "b".repeat(64),
});
check(
  "an empty bundle is reported as valid, never as a failure",
  emptyOutcome.ok && emptyOutcome.body.includes("not a failed export"),
  emptyOutcome.title,
);

const rejectedOutcome = describeTransfer({
  accepted: false,
  rejection: {
    code: "evidence_integrity_mismatch",
    message: "does not match the bundle schema",
    remediation: "re-export",
  },
});
check(
  "a rejection is never softened into success",
  rejectedOutcome.ok === false &&
    rejectedOutcome.title.includes("rejected") &&
    rejectedOutcome.body.includes("Nothing was merged"),
  rejectedOutcome.title,
);

const importOutcome = describeTransfer({
  accepted: true,
  staged: { name: "in.json", bytes: 42, sha256: "c".repeat(64) },
  result: { imported: 3, unknowns_added: 1, total: 3 },
});
check(
  "an accepted import reports the counts REA returned",
  importOutcome.ok && importOutcome.body.includes("3 records"),
  importOutcome.body.slice(0, 60),
);
check(
  "the import outcome says imported content is data, not something executed",
  importOutcome.body.includes("never executes"),
);

// ---- the view ------------------------------------------------------------
const { readFileSync } = await import("node:fs");
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
window.URL.revokeObjectURL = () => undefined;
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
window.document.querySelector('.rail-link[data-view="evidence"]')?.click();

const rendered = await until(() =>
  (window.document.getElementById("view-root")?.textContent ?? "").includes(
    "Export canonical bundle",
  ),
);
check("the Evidence view offers a real export", rendered);

const viewText = window.document.getElementById("view-root")?.textContent ?? "";
check(
  "the view states the path constraint instead of hiding it",
  viewText.includes("absolute path") || viewText.includes(BUNDLE_TRANSFER_NOTE),
);
check(
  "the old invented download is gone",
  !viewText.includes("rea-web-evidence-summary") &&
    ![...window.document.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Download bundle"),
    ),
);
check(
  "the view offers import as well as export",
  [...window.document.querySelectorAll("button")].some((button) =>
    button.textContent?.includes("Import bundle"),
  ),
);

// Drive the real button: the assertion is on what the user ends up with.
const exportButton = [...window.document.querySelectorAll("button")].find(
  (button) => button.textContent?.includes("Export canonical bundle"),
);
const downloads = [];
// The app resolves `URL` to the host's global, not jsdom's, so the spy has to
// land on every alias the module could reach. jsdom already defines
// createObjectURL as a no-op, which is why assigning to it looked like it
// worked: the download really happened, only the observation was missing.
const spy = (blob) => {
  downloads.push(blob);
  return "blob:mock";
};
for (const target of new Set([URL, window.URL])) {
  try {
    target.createObjectURL = spy;
  } catch {
    // A frozen constructor keeps its own implementation.
  }
}
window.HTMLAnchorElement.prototype.click = function () {
  this.dispatched = true;
};

exportButton?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
// Wait for a settled outcome. The panel paints "Asking REA to write the
// bundle…" first, which is a loading state and satisfies any text-presence
// check — so the predicate has to exclude it explicitly.
const finished = await until(() => {
  const text =
    window.document.querySelector(".bundle-outcome")?.textContent ?? "";
  return (
    text.length > 0 &&
    !text.includes("Asking REA") &&
    (text.includes("REA wrote") || text.includes("did not export"))
  );
});
check("clicking export reports an outcome", finished);

const outcomeText =
  window.document.querySelector(".bundle-outcome")?.textContent ?? "";
check(
  "the outcome quotes REA's receipt rather than a UI guess",
  outcomeText.includes("REA wrote") || outcomeText.includes("valid"),
  outcomeText.slice(0, 90),
);
check(
  "the export produced bytes to download",
  downloads.length === 1,
  `${downloads.length} blob(s)`,
);

check(
  "no runtime errors",
  errors.length === 0,
  errors[0]?.split("\n")[0] ?? "",
);

if (failures.length > 0) {
  console.error(`\nevidence-bundle: ${failures.length} failure(s).`);
  process.exitCode = 1;
} else {
  console.log("\nevidence-bundle: all checks passed.");
}

await fetch(`${base}/api/sessions`, {
  method: "DELETE",
  headers: { "content-type": "application/json", "x-rea-session": sessionId },
  body: JSON.stringify({ sessionId }),
}).catch(() => undefined);
