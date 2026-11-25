import { api, ApiError } from "./api.js";
import { byId, dialogById, errorMessage, h, inputById } from "./dom.js";
import { familyOf, FAMILIES } from "./catalog.js";
import { closeDrawer, initDrawer, launchTool } from "./runner.js";
import { recordEvidence, set, state, subscribe } from "./store.js";
import { toast } from "./ui.js";
import { renderEvidence } from "./views/evidence.js";
import { renderSetup } from "./views/setup.js";
import { renderTargets } from "./views/targets.js";
import { renderTools } from "./views/tools.js";
import { renderWorkspace } from "./views/workspace.js";

const VIEWS = {
  workspace: {
    title: "Workspace",
    subtitle: "Inspect a target and read the evidence behind it.",
    render: renderWorkspace,
  },
  targets: {
    title: "Targets",
    subtitle: "Local folders, uploaded files and generated samples.",
    render: renderTargets,
  },
  tools: {
    title: "Tools",
    subtitle: "Every capability REA advertises, with schema-driven inputs.",
    render: renderTools,
  },
  evidence: {
    title: "Evidence",
    subtitle: "What was observed, by which provider, with what limits.",
    render: renderEvidence,
  },
  setup: {
    title: "Setup",
    subtitle: "Runtime, readiness and deep-analysis providers.",
    render: renderSetup,
  },
};

const viewRoot = () => byId("view-root");

/** Apply a theme and persist it. */
const applyTheme = (theme) => {
  document.documentElement.dataset.theme = theme;
  byId("theme-label").textContent = theme === "dark" ? "Dark" : "Light";
  localStorage.setItem("rea-theme", theme);
};

/** Boot: status, session, then the first view. */
const boot = async () => {
  applyTheme(state.theme);
  setView(state.view, { replace: true });

  // Status is non-blocking; the session is what the UI needs.
  api
    .status()
    .then((status) => {
      set({ status });
      paintRuntimeChip();
    })
    .catch(() => undefined);

  try {
    const session = await api.startSession();
    set({
      tools: session.tools,
      toolsByName: new Map(session.tools.map((tool) => [tool.name, tool])),
      sessionReady: true,
      sessionError: null,
    });
    byId("rail-tool-count").textContent = String(session.tools.length);
    setRailStatus(
      "ok",
      `Session ${session.sessionId} · ${session.tools.length} tools`,
    );
    paintRuntimeChip();
  } catch (error) {
    set({ sessionError: errorMessage(error) });
    setRailStatus("bad", "Session failed");
    viewRoot().replaceChildren(
      h(
        "div",
        { class: "empty-state" },
        h("h3", { text: "Could not start a REA session" }),
        h("p", { text: errorMessage(error) }),
        error instanceof ApiError && error.remediation
          ? h("p", { class: "faint", text: error.remediation })
          : null,
        h(
          "button",
          {
            class: "primary-button",
            type: "button",
            onclick: () => location.reload(),
          },
          "Retry",
        ),
      ),
    );
    return;
  }
  renderCurrentView();
};

const setRailStatus = (tone, text) => {
  byId("rail-status-dot").className = `dot ${tone}`;
  byId("rail-status-text").textContent = text;
};

const paintRuntimeChip = () => {
  const runtime = state.status?.runtime;
  const chip = byId("runtime-chip");
  const text = byId("runtime-chip-text");
  if (runtime === undefined) return;
  const major = Number(
    String(runtime.nodeVersion ?? "")
      .replace(/^v/u, "")
      .split(".")[0],
  );
  const ok = major >= 24;
  const dot = /** @type {HTMLElement | null} */ (chip.querySelector(".dot"));
  if (dot !== null) dot.className = `dot ${ok ? "ok" : "warn"}`;
  text.textContent = `${runtime.nodeVersion ?? "node"} · REA ${state.status?.rea?.version ?? "?"}`;
  chip.title = ok
    ? "A supported Node.js runtime serves REA analysis."
    : "This runtime is older than REA requires; install Node.js 24 from Setup for every tool.";
};

let currentView = null;

const renderCurrentView = () => {
  if (!state.sessionReady) return;
  const view = VIEWS[state.view] ?? VIEWS.workspace;
  byId("view-title").textContent = view.title;
  byId("view-subtitle").textContent = view.subtitle;
  for (const button of document.querySelectorAll(".rail-link"))
    button.setAttribute(
      "aria-current",
      /** @type {HTMLElement} */ (button).dataset.view === state.view
        ? "page"
        : "false",
    );
  byId("rail-evidence-count").textContent =
    state.evidence.length === 0 ? "" : String(state.evidence.length);
  currentView = view.render(viewRoot());
};

const setView = (view, { replace = false } = {}) => {
  if (VIEWS[view] === undefined) view = "workspace";
  state.view = view;
  if (!replace) history.replaceState(null, "", `#${view}`);
  if (state.sessionReady) renderCurrentView();
};

// ---- Rail navigation -----------------------------------------------------
for (const button of document.querySelectorAll(".rail-link"))
  button.addEventListener("click", () =>
    setView(/** @type {HTMLElement} */ (button).dataset.view ?? "workspace"),
  );

byId("theme-toggle").addEventListener("click", () => {
  const next = state.theme === "dark" ? "light" : "dark";
  state.theme = next;
  applyTheme(next);
});

byId("command-button").addEventListener("click", () => openPalette());

initDrawer();

// ---- Command palette -----------------------------------------------------
const palette = dialogById("palette");
const paletteInput = inputById("palette-input");
const paletteResults = byId("palette-results");
let paletteIndex = 0;
let paletteItems = [];

const buildPaletteItems = (query) => {
  const items = [];
  for (const [id, view] of Object.entries(VIEWS))
    items.push({
      kind: "view",
      label: view.title,
      hint: view.subtitle,
      run: () => setView(id),
    });
  const needle = query.trim().toLowerCase();
  for (const tool of state.tools) {
    if (
      needle.length > 0 &&
      !`${tool.name} ${tool.title}`.toLowerCase().includes(needle)
    )
      continue;
    items.push({
      kind:
        FAMILIES.find((family) => family.id === familyOf(tool.name))?.label ??
        "tool",
      label: tool.title ?? tool.name,
      hint: tool.cli ?? tool.name,
      run: () => launchTool(tool.name, currentTargetArgs(tool)),
    });
    if (items.length > 90) break;
  }
  return needle.length === 0 ? items.slice(0, 40) : items;
};

const currentTargetArgs = (tool) => {
  const target = state.selectedTarget;
  if (target === null) return {};
  const properties = tool.inputSchema?.properties ?? {};
  for (const key of ["path", "input_path", "inputPath"])
    if (properties[key] !== undefined) return { [key]: target.path };
  return {};
};

const paintPalette = () => {
  paletteResults.replaceChildren(
    ...paletteItems.map((item, index) =>
      h(
        "li",
        {
          role: "option",
          "aria-selected": String(index === paletteIndex),
          onclick: () => {
            runPaletteItem(index);
          },
        },
        h("span", { text: item.label }),
        h("span", { class: "palette-kind", text: item.kind }),
      ),
    ),
  );
  paletteResults.children[paletteIndex]?.scrollIntoView({ block: "nearest" });
};

const runPaletteItem = (index) => {
  const item = paletteItems[index];
  closePalette();
  item?.run();
};

const openPalette = () => {
  palette.showModal();
  paletteInput.value = "";
  paletteItems = buildPaletteItems("");
  paletteIndex = 0;
  paintPalette();
  paletteInput.focus();
};

const closePalette = () => {
  if (palette.open) palette.close();
};

paletteInput.addEventListener("input", () => {
  paletteItems = buildPaletteItems(paletteInput.value);
  paletteIndex = 0;
  paintPalette();
});

paletteInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    paletteIndex = Math.min(paletteItems.length - 1, paletteIndex + 1);
    paintPalette();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    paletteIndex = Math.max(0, paletteIndex - 1);
    paintPalette();
  } else if (event.key === "Enter") {
    event.preventDefault();
    runPaletteItem(paletteIndex);
  }
});

palette.addEventListener("click", (event) => {
  if (event.target === palette) closePalette();
});

document.addEventListener("keydown", (event) => {
  const meta = event.metaKey || event.ctrlKey;
  if (meta && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (palette.open) closePalette();
    else openPalette();
  }
  if (
    event.key === "/" &&
    document.activeElement?.tagName !== "INPUT" &&
    !palette.open
  ) {
    event.preventDefault();
    openPalette();
  }
});

// ---- Store reactions -----------------------------------------------------
// The store is the single driver for these views. A patch key may carry a
// value (a tool, a target), so presence — not a `true` value — is the signal.
subscribe((change) => {
  const touched = (...keys) => keys.some((key) => key in change);
  const paintCurrent = () => {
    if (!state.sessionReady) return;
    try {
      renderCurrentView();
    } catch (error) {
      // A broken paint must never abort the action that triggered it.
      console.error("view render failed", error);
      toast("View failed to render", errorMessage(error), "error");
    }
  };
  if (touched("evidence")) {
    byId("rail-evidence-count").textContent =
      state.evidence.length === 0 ? "" : String(state.evidence.length);
    if (state.view === "evidence") paintCurrent();
  }
  if (
    touched("activity", "targets", "selectedTarget", "upload") &&
    (state.view === "workspace" || state.view === "targets")
  )
    paintCurrent();
});

window.addEventListener("hashchange", () => {
  const view = location.hash.replace("#", "");
  if (VIEWS[view] !== undefined && view !== state.view)
    setView(view, { replace: true });
});

window.addEventListener("beforeunload", () => {
  void api.endSession();
});

// Expose a tiny hook for the evidence footer copy affordance.
window.addEventListener("error", (event) => {
  if (event.error instanceof ApiError)
    toast("Request failed", event.error.message, "error");
});

void boot();
