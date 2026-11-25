/**
 * "Original artifact bytes are not modified" was true of eleven tools and false
 * of the other twenty-one.
 *
 * Every tool with `destructiveHint: true` was told the same thing in the
 * drawer, and every destructive card carried the same badge: "edits state".
 * REA's own descriptions say otherwise:
 *
 *   uninstall_adb_package   "package removal ... without data retention"
 *   push_adb_file           "Push one local file to an absolute device path"
 *   export_evidence_bundle  "Atomically write ... to the requested local path"
 *   capture_process_scenario "Run one caller-selected command under a PTY"
 *
 * The reassurance was not wrong about the artifact — it was answering a
 * question the user had not asked while ignoring four they had. Someone who
 * reads "bytes are not modified" and then removes a package from a phone has
 * been misled by the interface, not by REA.
 *
 * MCP carries no effect list to fix this properly: the tool listing exposes
 * only the four boolean hints. So the classification is by REA's documented
 * behaviour, quotes that description, and reports anything it cannot place as
 * *unclassified* rather than as harmless. A missing label is recoverable; a
 * soothing one is not.
 *
 *   node web/test/destructive-tools.mjs http://127.0.0.1:4180
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
      "destructive-tools: jsdom is not installed; skipping (REA_WEB_ALLOW_SKIP=1).",
    );
    process.exit(0);
  }
  console.error(
    "destructive-tools: jsdom is required for this check. Install it with " +
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

const {
  DESTRUCTIVE_SURFACES,
  destructiveProfile,
  destructiveSummary,
  classifiedTools,
} = await import(
  pathToFileURL(new URL("../app/js/destructive.js", import.meta.url).pathname)
    .href
);

// ---- the live catalog ----------------------------------------------------
const session = await (
  await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
).json();
const tools = session.tools ?? [];
const destructive = tools.filter(
  (tool) => tool.annotations?.destructiveHint === true,
);

check(
  "REA advertises destructive tools",
  destructive.length > 0,
  `${destructive.length} tools`,
);
check(
  "every destructive tool has a reading here",
  destructive.every((tool) => destructiveProfile(tool)?.unclassified === false),
  destructive
    .filter((tool) => destructiveProfile(tool)?.unclassified !== false)
    .map((tool) => tool.name)
    .join(", ") || "all classified",
);
check(
  "the classification covers no tool REA does not advertise",
  classifiedTools().every((name) => tools.some((tool) => tool.name === name)),
  classifiedTools()
    .filter((n) => !tools.some((t) => t.name === n))
    .join(", ") || "none stale",
);

// ---- the defect this replaces -------------------------------------------
const uninstall = tools.find((tool) => tool.name === "uninstall_adb_package");
const uninstallProfile = destructiveProfile(uninstall);
check(
  "removing a device package is not called an analysis-state edit",
  uninstallProfile?.surfaces.includes("device") === true,
  uninstallProfile?.surfaces.join(",") ?? "none",
);
check(
  "a device tool never claims the artifact bytes are safe",
  uninstallProfile?.artifactBytesSafe === false,
);
check(
  "a device tool says the change cannot be undone from here",
  uninstallProfile?.details.some((detail) =>
    detail.undo.includes("Cannot be undone from here"),
  ) === true,
);

const exportProfile = destructiveProfile(
  tools.find((tool) => tool.name === "export_evidence_bundle"),
);
check(
  "exporting a bundle is reported as a filesystem write",
  exportProfile?.surfaces.join(",") === "filesystem",
  exportProfile?.surfaces.join(",") ?? "none",
);

const commentProfile = destructiveProfile(
  tools.find((tool) => tool.name === "set_comment"),
);
check(
  "the analysis-state tools are the only ones that may call bytes untouched",
  commentProfile?.artifactBytesSafe === true &&
    commentProfile.surfaces.join(",") === "analysis-state",
  commentProfile?.surfaces.join(",") ?? "none",
);

const allSafe = destructive.filter(
  (tool) => destructiveProfile(tool)?.artifactBytesSafe === true,
);
check(
  "only a minority of the destructive tools leave bytes untouched",
  allSafe.length < destructive.length / 2,
  `${allSafe.length} of ${destructive.length}`,
);

// ---- every surface used is described ------------------------------------
const usedSurfaces = new Set(
  destructive.flatMap((tool) => destructiveProfile(tool)?.surfaces ?? []),
);
check(
  "every surface a tool names has a description and an undo",
  [...usedSurfaces].every((surface) =>
    DESTRUCTIVE_SURFACES.some(
      (entry) =>
        entry.id === surface &&
        entry.consequence.length > 0 &&
        entry.undo.length > 0,
    ),
  ),
  [...usedSurfaces].join(","),
);
check(
  "the device surface outranks analysis state",
  DESTRUCTIVE_SURFACES[0]?.id === "device",
  DESTRUCTIVE_SURFACES[0]?.id,
);

// ---- unclassified is loud, not silent -----------------------------------
const unknown = destructiveProfile({
  name: "no_such_tool_at_all",
  annotations: { destructiveHint: true },
});
check(
  "an unknown destructive tool is unclassified, never assumed harmless",
  unknown?.unclassified === true && unknown.artifactBytesSafe === false,
);
check(
  "an unclassified tool says it can change anything it reaches",
  unknown?.because.includes("change anything it can reach") === true,
  unknown?.because.slice(0, 60),
);
check(
  "a non-destructive tool has no destructive profile",
  destructiveProfile({
    name: "inspect_artifact",
    annotations: { readOnlyHint: true },
  }) === null,
);
check(
  "a tool with no annotations has no destructive profile",
  destructiveProfile({ name: "inspect_artifact", annotations: null }) === null,
);

// ---- the summary --------------------------------------------------------
const summary = destructiveSummary(destructive.length, 0);
check(
  "the summary says the tools do not all do the same thing",
  summary.includes("do not all do the same thing"),
  summary.slice(0, 70),
);
check(
  "the summary counts the device-mutating tools",
  summary.includes("6 change a connected device"),
  summary.match(/\d+ change a connected device/)?.[0] ?? "not stated",
);
check(
  "the summary flags unclassified tools when there are any",
  destructiveSummary(32, 3).includes("3 of them are not described here"),
);

// ---- the Tools view -----------------------------------------------------
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
window.document.querySelector('.rail-link[data-view="tools"]')?.click();

const rendered = await until(() =>
  (window.document.getElementById("view-root")?.textContent ?? "").includes(
    "Destructive tools",
  ),
);
check("the Tools view states the destructive split", rendered);

const viewText = window.document.getElementById("view-root")?.textContent ?? "";
check(
  "the view never says destructive tools all edit state",
  !viewText.includes(
    "Edits analysis state. Original artifact bytes are not modified",
  ),
);
check(
  "the view names the device consequence",
  viewText.includes("change a connected device"),
);

// The card badge for a device tool must not read "edits state".
const cards = [...window.document.querySelectorAll(".tool-card")];
const uninstallCard = cards.find(
  (card) => card.getAttribute("data-tool") === "uninstall_adb_package",
);
check("a device tool card is reachable", uninstallCard !== undefined);
const uninstallBadges = [
  ...(uninstallCard?.querySelectorAll(".badge") ?? []),
].map((badge) => badge.textContent);
check(
  "a device tool is badged as a device change",
  uninstallBadges.includes("device"),
  uninstallBadges.join(","),
);
check(
  "a device tool is not badged as an analysis-state edit",
  !uninstallBadges.includes("edits state"),
  uninstallBadges.join(","),
);

const commentCard = cards.find(
  (card) => card.getAttribute("data-tool") === "set_comment",
);
const commentBadges = [...(commentCard?.querySelectorAll(".badge") ?? [])].map(
  (badge) => badge.textContent,
);
check(
  "an analysis-state tool keeps its edits-state badge",
  commentBadges.includes("edits state"),
  commentBadges.join(","),
);

check(
  "no runtime errors",
  errors.length === 0,
  errors[0]?.split("\n")[0] ?? "",
);

if (failures.length > 0) {
  console.error(`\ndestructive-tools: ${failures.length} failure(s).`);
  process.exitCode = 1;
} else {
  console.log("\ndestructive-tools: all checks passed.");
}

await fetch(`${base}/api/sessions`, {
  method: "DELETE",
  headers: {
    "content-type": "application/json",
    "x-rea-session": session.sessionId,
  },
  body: JSON.stringify({ sessionId: session.sessionId }),
}).catch(() => undefined);
