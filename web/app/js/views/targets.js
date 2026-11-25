import { api } from "../api.js";
import { byId, errorMessage, formatBytes, h, inputOf } from "../dom.js";
import { addTarget, set, state } from "../store.js";
import { sectionHeader, toast } from "../ui.js";
import { launchTool } from "../runner.js";

/**
 * Targets view: browse the checkout for local applications, upload files, and
 * generate samples. Local folders can be opened as JavaScript applications.
 */
export const renderTargets = (root) => {
  const container = h("div", { class: "stack view-stack" });
  const browserPanel = h("section", { class: "panel" });
  const manualPanel = h("section", { class: "panel" });

  const manualInput = h("input", {
    type: "text",
    placeholder: "/absolute/path/to/app-or-binary",
    spellcheck: "false",
  });

  manualPanel.append(
    sectionHeader("Open a path", "Any absolute path the server can read"),
    h(
      "div",
      { class: "panel-body" },
      h(
        "form",
        {
          class: "row",
          onsubmit: (event) => {
            event.preventDefault();
            const path = inputOf(event).value.trim();
            if (path.length === 0) return;
            const stored = addTarget({
              name: path.split("/").pop() || path,
              path,
            });
            set({ selectedTarget: stored });
            toast("Target added", path);
            renderTree(state.lastTree ?? []);
          },
        },
        h("div", { class: "grow" }, manualInput),
        h("button", { class: "primary-button", type: "submit" }, "Add target"),
      ),
      h("p", {
        class: "faint pad-top",
        text: "Directories are analysed as JavaScript/Electron applications; files use their artifact extension to suggest tools.",
      }),
    ),
  );

  container.append(browserPanel, manualPanel);
  root.replaceChildren(container);

  let tree = [];
  const renderTree = (nodes) => {
    state.lastTree = nodes;
    const filter = (/** @type {HTMLInputElement | null} */
    (browserPanel.querySelector(".tree-filter"))?.value ?? "").toLowerCase();
    const visible = nodes.filter(
      (node) =>
        node.kind === "directory" ||
        filter.length === 0 ||
        node.name.toLowerCase().includes(filter),
    );
    browserPanel.replaceChildren(
      sectionHeader(
        "Local sources",
        state.status?.repositoryRoot ?? "",
        h("span", { class: "badge", text: `${nodes.length} entries` }),
      ),
      h(
        "div",
        { class: "tree-toolbar" },
        h("input", {
          class: "tree-filter",
          type: "search",
          placeholder: "Filter by name…",
          oninput: (event) => renderList(inputOf(event).value.toLowerCase()),
        }),
      ),
      h("div", { class: "tree-list" }, ...rowsFor(visible)),
    );
    const list = /** @type {HTMLElement | null} */ (
      browserPanel.querySelector(".tree-list")
    );
    if (list === null) throw new Error("Tree list is missing.");
    /** @param {string} value */
    const renderList = (value) =>
      list.replaceChildren(
        ...rowsFor(
          nodes.filter(
            (node) =>
              node.kind === "directory" ||
              value.length === 0 ||
              node.name.toLowerCase().includes(value),
          ),
        ),
      );
  };

  const rowsFor = (nodes) =>
    nodes.slice(0, 500).map((node) =>
      h(
        "div",
        {
          class: `tree-row depth-${Math.min(node.depth, 3)}`,
          role: "button",
          tabindex: "0",
          onclick: () => choose(node),
          onkeydown: (event) => {
            const key = /** @type {KeyboardEvent} */ (event);
            if (key.key === "Enter" || key.key === " ") choose(node);
          },
        },
        h("span", {
          class: "tree-kind",
          text:
            node.kind === "directory"
              ? "DIR"
              : node.inspectable
                ? "BIN"
                : "FILE",
        }),
        h("span", { class: "mono tree-name", text: node.name }),
        h("span", { class: "spacer" }),
        node.bytes === undefined
          ? null
          : h("span", { class: "faint", text: formatBytes(node.bytes) }),
        node.inspectable
          ? h("span", { class: "badge info", text: "inspectable" })
          : null,
      ),
    );

  const choose = async (node) => {
    if (node.kind === "directory") {
      const absolute = node.absolute ?? node.path;
      const stored = addTarget({
        name: node.name,
        path: absolute,
        kind: "folder",
      });
      set({ selectedTarget: stored });
      toast(
        "Folder added",
        `${node.name} — run “Analyse JavaScript application” from the workspace.`,
      );
      return;
    }
    const stored = addTarget({
      name: node.name,
      path: node.absolute ?? node.path,
      bytes: node.bytes,
    });
    set({ selectedTarget: stored });
    toast("Target added", node.name);
  };

  api
    .sources()
    .then((payload) => {
      tree = payload.nodes;
      renderTree(tree);
    })
    .catch((error) => {
      browserPanel.replaceChildren(
        sectionHeader("Local sources", "Unavailable"),
        h(
          "div",
          { class: "empty-state" },
          h("h3", { text: "Could not read the workspace" }),
          h("p", { text: errorMessage(error) }),
        ),
      );
    });

  return { container };
};
