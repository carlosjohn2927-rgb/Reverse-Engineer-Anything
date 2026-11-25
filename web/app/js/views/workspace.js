import { api } from "../api.js";
import {
  errorMessage,
  formatBytes,
  formatDuration,
  h,
  humanize,
  inputOf,
} from "../dom.js";
import {
  kindForPath,
  kindsForPath,
  pathKeyOf,
  PRESET_COPY,
  PRESETS,
} from "../catalog.js";
import { renderResult } from "../render/evidence.js";
import {
  addTarget,
  recordActivity,
  recordEvidence,
  set,
  state,
} from "../store.js";
import { copyButton, sectionHeader, toast } from "../ui.js";
import { launchTool } from "../runner.js";

const LAUNCHERS = [
  {
    id: "samples",
    title: "Analyse a built-in sample",
    blurb:
      "A valid .NET assembly, WebAssembly module, SQLite database and an entropy test file, generated locally.",
    action: "samples",
    icon: "sparkles",
  },
  {
    id: "upload",
    title: "Upload a file",
    blurb:
      "Send a binary, APK, capture or database from this device into the session workspace.",
    action: "upload",
    icon: "upload",
  },
  {
    id: "folder",
    title: "Inspect a local folder",
    blurb:
      "Pick a JavaScript app, an extracted .asar, or a build output on the server's filesystem.",
    action: "folder",
    icon: "folder",
  },
  {
    id: "website",
    title: "Inspect a website",
    blurb:
      "Find an open website tab through a connected Chrome or Chromium browser.",
    action: "website",
    icon: "website",
  },
  {
    id: "tool",
    title: "Run a tool directly",
    blurb: "All 233 REA tools with schema-driven forms and streamed progress.",
    action: "tools",
    icon: "wrench",
  },
];

const icon = (name) => {
  const paths = {
    sparkles:
      "M10 2.5 11.6 7 16 8.6 11.6 10.2 10 14.7 8.4 10.2 4 8.6 8.4 7 10 2.5Zm5.5 9 1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1 1-2.5Z",
    upload:
      "M10 3v8.2l2.9-2.9 1.4 1.4L10 14l-4.3-4.3 1.4-1.4 2.9 2.9V3h2ZM4 15h12v2H4v-2Z",
    folder: "M3 5h5l1.5 2H17v9H3V5Z",
    website:
      "M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Zm5.4 6.6h-2.2a12 12 0 0 0-.9-4 5.6 5.6 0 0 1 3.1 4Zm-5.4-4.8c.7 1 1.2 2.8 1.4 4.8H8.6c.2-2  .7-3.8 1.4-4.8ZM4.6 11h2.2c.1 1.5.4 2.9.9 4a5.6 5.6 0 0 1-3.1-4Zm2.2-1.9H4.6a5.6 5.6 0 0 1 3.1-4 12 12 0 0 0-.9 4Zm1.8 1.9h2.8c-.2 2-.7 3.8-1.4 4.8-.7-1-1.2-2.8-1.4-4.8Zm3.7 4a12 12 0 0 0 .9-4h2.2a5.6 5.6 0 0 1-3.1 4Z",
    wrench:
      "M6.2 3.4a4.2 4.2 0 0 0 5.3 5.3l4.4 4.4-1.5 1.5-4.4-4.4a4.2 4.2 0 0 1-5.3-5.3l2.5 2.5 1.6-.4.4-1.6-3-2Z",
    file: "M5 3h7l3 3v11H5V3Zm2 2v10h6V7h-2V5H7Z",
    crosshair:
      "M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12Zm-1 5v2H7v-2h2Zm4 0h2v2h-2v-2Z",
  };
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[name] ?? paths.file);
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 20 20");
  node.append(path);
  return node;
};

/** The workspace view: launch, target list, suggestions, recent results. */
export const renderWorkspace = (root) => {
  const container = h("div", { class: "stack view-stack" });
  const runtimeNotice = buildRuntimeNotice();

  const header = h(
    "section",
    { class: "hero" },
    h(
      "div",
      { class: "hero-copy" },
      h("p", { class: "eyebrow", text: "LOCAL ANALYSIS · PRIVATE SESSION" }),
      h("h2", { text: "What are we looking at today?" }),
      h("p", {
        class: "muted",
        text: "Choose an app, binary, or capture. REA will suggest the right analysis and show the evidence behind every result.",
      }),
    ),
    h(
      "div",
      { class: "hero-actions" },
      h(
        "button",
        {
          class: "primary-button",
          type: "button",
          title:
            state.selectedTarget === null
              ? "Choose or upload a target before analysis"
              : `Analyse ${state.selectedTarget.name}`,
          onclick: () => {
            void analyzeSelectedTarget();
          },
        },
        "Analyse selected target",
      ),
      h(
        "button",
        {
          class: "ghost-button",
          type: "button",
          onclick: () => openFolderPicker(),
        },
        "＋ Add a target",
      ),
      h(
        "button",
        { class: "ghost-button", type: "button", onclick: () => chooseFiles() },
        "Upload files",
      ),
    ),
  );

  const workspaceStats = h(
    "section",
    { class: "workspace-stats", "aria-label": "Session overview" },
    ...[
      ["Targets", state.targets.length, "artifacts in this session"],
      ["Analyses", state.activity.length, "tool runs recorded"],
      ["Evidence", state.evidence.length, "results retained here"],
    ].map(([label, value, hint]) =>
      h(
        "div",
        { class: "workspace-stat" },
        h("span", { class: "workspace-stat-mark", "aria-hidden": "true" }),
        h(
          "div",
          {},
          h("strong", { text: String(value) }),
          h("span", { class: "faint", text: `${label} · ${hint}` }),
        ),
      ),
    ),
  );

  const launchers = h(
    "div",
    { class: "grid-cards launchers" },
    ...LAUNCHERS.map((launcher) =>
      h(
        "button",
        {
          class: "card interactive launcher",
          type: "button",
          onclick: () => {
            if (launcher.action === "samples") return generateSamples();
            if (launcher.action === "upload") return chooseFiles();
            if (launcher.action === "folder") return openFolderPicker();
            if (launcher.action === "website") return set({ view: "targets" });
            set({ view: "tools" });
          },
        },
        h(
          "span",
          { class: "launcher-icon", "aria-hidden": "true" },
          icon(launcher.icon),
        ),
        h("strong", { text: launcher.title }),
        h("span", { class: "muted blurb", text: launcher.blurb }),
      ),
    ),
  );

  const targetsSection = h("section", { class: "panel" });
  const suggestions = h("section", { class: "panel" });
  const activitySection = h("section", { class: "panel" });
  const dashboardColumns = h(
    "div",
    { class: "dashboard-columns" },
    targetsSection,
    activitySection,
  );

  const renderTargets = () => {
    targetsSection.replaceChildren(
      sectionHeader(
        "Targets",
        state.targets.length === 0
          ? "Nothing loaded yet"
          : `${state.targets.length} in this session`,
        h(
          "button",
          {
            class: "ghost-button small",
            type: "button",
            onclick: () => openFolderPicker(),
          },
          "Add folder",
        ),
        h(
          "button",
          {
            class: "ghost-button small",
            type: "button",
            onclick: () => chooseFiles(),
          },
          "Upload",
        ),
      ),
      state.targets.length === 0
        ? emptyState(
            "crosshair",
            "No targets yet",
            "Generate a sample, upload a file, or pick a folder to begin. REA never uploads your artifacts; analysis runs locally.",
          )
        : h(
            "div",
            { class: "target-list" },
            ...state.targets.map((target) => {
              const kind = kindForPath(target.path ?? target.name);
              const selected = state.selectedTarget?.id === target.id;
              return h(
                "button",
                {
                  class: `target-row ${selected ? "selected" : ""}`,
                  type: "button",
                  onclick: () => set({ selectedTarget: target }),
                },
                h("span", { class: "target-kind", text: kind.label }),
                h(
                  "span",
                  { class: "target-main" },
                  h("strong", {
                    class: "mono",
                    text: target.name ?? target.path,
                  }),
                  h("span", { class: "faint mono", text: target.path ?? "" }),
                ),
                target.bytes === undefined
                  ? null
                  : h("span", {
                      class: "chip",
                      text: formatBytes(target.bytes),
                    }),
                kind.id === "js" || target.kind === "folder"
                  ? h("span", { class: "badge info", text: "folder" })
                  : null,
              );
            }),
          ),
    );
  };

  const renderSuggestions = () => {
    const target = state.selectedTarget;
    if (target === null) {
      suggestions.replaceChildren(
        sectionHeader(
          "Suggested analyses",
          "Select a target to see what REA can answer",
        ),
        emptyState(
          "sparkles",
          "Pick a target",
          "Suggestions are derived from the artifact type and each tool's own advertised input schema.",
        ),
      );
      return;
    }
    const kinds =
      target.kind === "folder"
        ? [kindForPath("app.js")]
        : kindsForPath(target.path ?? target.name);
    // A .dll may be a native PE or a .NET assembly; offer both sets, deduped.
    const names = [
      ...new Set(kinds.flatMap((kind) => PRESETS[kind.id] ?? PRESETS.file)),
    ].filter((name) => state.toolsByName.has(name));
    suggestions.replaceChildren(
      sectionHeader(
        "Suggested analyses",
        `${kinds.map((kind) => kind.label).join(" / ")} · ${target.name}`,
        h("span", { class: "badge info", text: `${names.length} applicable` }),
      ),
      h(
        "div",
        { class: "suggestion-grid" },
        ...names.map((name) => {
          const tool = state.toolsByName.get(name);
          return h(
            "button",
            {
              class: "suggestion",
              type: "button",
              onclick: () => launchTool(name, presetsFor(tool, target)),
            },
            h("strong", { text: tool?.title ?? humanize(name) }),
            h("span", {
              class: "muted blurb",
              text: PRESET_COPY[name] ?? tool?.description?.slice(0, 130) ?? "",
            }),
            h("span", {
              class: "mono faint",
              text: `rea ${name.replaceAll("_", "-")}`,
            }),
          );
        }),
      ),
      h(
        "div",
        { class: "panel-actions" },
        h(
          "button",
          {
            class: "ghost-button small",
            type: "button",
            onclick: () => set({ view: "tools" }),
          },
          "Browse all tools",
        ),
      ),
    );
  };

  const renderActivity = () => {
    activitySection.replaceChildren(
      sectionHeader(
        "Recent results",
        state.activity.length === 0
          ? "Results appear here as you work"
          : `${state.activity.length} this session`,
      ),
      state.activity.length === 0
        ? emptyState(
            "file",
            "Nothing yet",
            "Run an analysis to see it here with its timing and evidence id.",
          )
        : h(
            "div",
            { class: "activity-list" },
            ...state.activity.slice(0, 8).map((entry) =>
              h(
                "div",
                {
                  class: `activity-row ${entry.status === "error" ? "failed" : ""}`,
                },
                h("span", {
                  class: `badge ${entry.status === "error" ? "bad" : "ok"}`,
                  text: entry.status === "error" ? "failed" : "ok",
                }),
                h("span", {
                  class: "mono",
                  text: entry.tool.replaceAll("_", "-"),
                }),
                h("span", { class: "faint", text: entry.subject ?? "" }),
                h("div", { class: "spacer" }),
                h("span", {
                  class: "faint",
                  text:
                    entry.durationMs === undefined
                      ? ""
                      : formatDuration(entry.durationMs),
                }),
              ),
            ),
          ),
    );
  };

  container.append(
    ...(runtimeNotice === null ? [] : [runtimeNotice]),
    header,
    workspaceStats,
    launchers,
    dashboardColumns,
    suggestions,
  );
  root.replaceChildren(container);
  renderTargets();
  renderSuggestions();
  renderActivity();
  return { container };
};

/**
 * Warn, in the workspace itself, when the runtime behind REA is too old for
 * part of the tool set. Setup can fix it in one click; without this banner the
 * first sign is a `capability_unavailable` failure on a real analysis.
 */
const buildRuntimeNotice = () => {
  const runtime = state.status?.runtime;
  if (runtime === undefined) return null;
  const major = Number(
    String(runtime.nodeVersion ?? "")
      .replace(/^v/u, "")
      .split(".")[0],
  );
  if (major >= 24) return null;
  const installing = state.upload?.active === true;
  const button = h(
    "button",
    {
      class: "primary-button small",
      type: "button",
      disabled: installing,
      onclick: async (event) => {
        const node = /** @type {HTMLButtonElement} */ (event.currentTarget);
        node.disabled = true;
        node.textContent = "Installing…";
        try {
          await api.installRuntime();
          const status = await api.status();
          set({ status });
          toast("Node.js 24 installed", "New sessions will use it.", "info");
          // A child started before the install keeps the old runtime, so the
          // session has to be recreated for the new tools to work.
          await api.endSession();
          location.reload();
        } catch (error) {
          toast("Could not install Node.js 24", errorMessage(error), "error");
          node.disabled = false;
          node.textContent = "Install Node.js 24";
        }
      },
    },
    installing ? "Installing…" : "Install Node.js 24",
  );
  return h(
    "div",
    { class: "notice warn" },
    h(
      "div",
      { class: "notice-row" },
      h("span", { class: "badge warn", text: "runtime" }),
      h("strong", { text: "Some analyses are unavailable on this runtime" }),
    ),
    h("p", {
      class: "muted",
      text: `REA is running on Node.js ${runtime.nodeVersion ?? "unknown"}. SQLite inspection and a few other providers need Node.js 24, which this app can install privately — nothing global is changed.`,
    }),
    h(
      "div",
      { class: "panel-actions" },
      button,
      h(
        "button",
        {
          class: "ghost-button small",
          type: "button",
          onclick: () => set({ view: "setup" }),
        },
        "Open setup",
      ),
    ),
  );
};

const emptyState = (iconName, title, body) =>
  h(
    "div",
    { class: "empty-state" },
    h("span", { class: "empty-icon" }, icon(iconName)),
    h("h3", { text: title }),
    h("p", { text: body }),
  );

/** Seed default arguments for a suggested tool from the selected target. */
export const presetsFor = (tool, target) => {
  if (tool === undefined) return {};
  const key = pathKeyOf(tool);
  const args = {};
  if (key !== null) args[key] = target.path;
  if (
    tool.name === "analyze_javascript_application" &&
    target.kind === "folder"
  )
    args.input_path = target.path;
  return args;
};

const generateSamples = async () => {
  try {
    toast(
      "Generating samples",
      "Building a .NET assembly, WASM module, SQLite database and entropy file…",
    );
    const payload = await api.samples();
    let managedTarget;
    for (const file of payload.files) {
      const stored = addTarget({
        name: file.name,
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
        sample: file.id,
      });
      if (file.id === "managed") managedTarget = stored;
    }
    set({ selectedTarget: managedTarget ?? state.targets[0] });
    if (managedTarget === undefined) {
      toast(
        "Samples ready",
        `${payload.files.length} artifacts were generated, but the .NET sample was not returned for the quick analysis.`,
        "warn",
      );
      return;
    }
    toast(
      "Samples ready",
      "Starting a .NET sample analysis; the other generated artifacts are available as targets.",
      "info",
    );
    let result;
    try {
      result = await api.callTool("inspect_managed_artifact", {
        path: managedTarget.path,
      });
    } catch (error) {
      toast("Samples ready, but analysis failed", errorMessage(error), "error");
      return;
    }
    recordActivity({
      tool: "inspect_managed_artifact",
      status: result.status,
      durationMs: result.durationMs,
      subject: result.payload?.subject?.name,
      evidenceId: result.payload?.evidence_id,
    });
    if (result.payload?.evidence_id !== undefined)
      recordEvidence({
        tool: "inspect_managed_artifact",
        status: result.status,
        payload: result.payload,
        durationMs: result.durationMs,
      });
    toast(
      result.status === "ok"
        ? "Sample analysis complete"
        : "Sample analysis failed",
      result.status === "ok"
        ? "See Recent results or Evidence for the .NET sample findings."
        : (result.error?.message ??
            "REA could not analyze the generated sample."),
      result.status === "ok" ? "info" : "error",
    );
  } catch (error) {
    toast("Could not generate samples", errorMessage(error), "error");
  }
};

/** @type {HTMLInputElement} */
const SAMPLE_INPUT = /** @type {HTMLInputElement} */ (
  h("input", { type: "file", id: "file-input", multiple: true, hidden: true })
);

const chooseFiles = () => {
  if (!SAMPLE_INPUT.isConnected) document.body.append(SAMPLE_INPUT);
  SAMPLE_INPUT.value = "";
  SAMPLE_INPUT.onchange = async () => {
    const files = [...(SAMPLE_INPUT.files ?? [])];
    if (files.length === 0) return;
    set({ upload: { active: true } });
    try {
      for (const file of files) {
        toast("Uploading", `${file.name} (${formatBytes(file.size)})`);
        const staged = await api.upload(file);
        const stored = addTarget({
          name: staged.name,
          path: staged.path,
          bytes: staged.bytes,
          sha256: staged.sha256,
        });
        set({ selectedTarget: stored });
      }
      toast(
        "Uploaded",
        `${files.length} file${files.length === 1 ? "" : "s"} staged.`,
      );
    } catch (error) {
      toast("Upload failed", errorMessage(error), "error");
    } finally {
      set({ upload: null });
    }
  };
  SAMPLE_INPUT.click();
};

const openFolderPicker = () => set({ view: "targets" });

const analyzeSelectedTarget = async () => {
  const target = state.selectedTarget;
  if (target === null) {
    toast(
      "Choose a target first",
      "Add a folder, upload a file, or analyse a built-in sample before running an analysis.",
      "warn",
    );
    return;
  }
  const kinds =
    target.kind === "folder"
      ? [kindForPath("app.js")]
      : kindsForPath(target.path ?? target.name);
  const toolName = [
    ...new Set(kinds.flatMap((kind) => PRESETS[kind.id] ?? PRESETS.file)),
  ].find((name) => state.toolsByName.has(name));
  if (toolName === undefined) {
    toast(
      "No analysis tool found",
      `REA has no matching preset for ${target.name}. Browse the tool catalog to choose one manually.`,
      "warn",
    );
    return;
  }
  await launchTool(
    toolName,
    presetsFor(state.toolsByName.get(toolName), target),
    { autoRun: true },
  );
};

/** Start one preset analysis directly from the workspace. */
export const runPreset = async (toolName, args) => {
  const result = await launchTool(toolName, args);
  if (result !== undefined) {
    recordEvidence({
      tool: toolName,
      payload: result.payload,
      error: result.error,
      status: result.status,
      durationMs: result.durationMs,
    });
  }
};
