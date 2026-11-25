import { h, humanize, inputOf } from "../dom.js";
import { FAMILIES, familyOf, pathKeyOf } from "../catalog.js";
import { set, state } from "../store.js";
import { launchTool } from "../runner.js";

/** Tools view: the full REA catalog grouped by family with schema-driven forms. */
export const renderTools = (root) => {
  const container = h("div", { class: "stack view-stack" });
  const familyFilter = state.toolFamily ?? "all";
  const search = state.toolSearch ?? "";

  const tools = state.tools.filter((tool) => {
    if (familyFilter !== "all" && familyOf(tool.name) !== familyFilter)
      return false;
    if (search.length === 0) return true;
    const haystack =
      `${tool.name} ${tool.title} ${tool.description}`.toLowerCase();
    return haystack.includes(search.toLowerCase());
  });

  const grouped = new Map();
  for (const tool of tools) {
    const family = familyOf(tool.name);
    if (!grouped.has(family)) grouped.set(family, []);
    grouped.get(family).push(tool);
  }

  const searchInput = h("input", {
    type: "search",
    placeholder: "Search 233 tools by name or description…",
    value: search,
    oninput: (event) => {
      state.toolSearch = inputOf(event).value;
      renderTools(root);
    },
  });
  searchInput.setAttribute("aria-label", "Search tools");

  const chips = h(
    "div",
    { class: "chip-row" },
    h(
      "button",
      {
        class: `chip-button ${familyFilter === "all" ? "active" : ""}`,
        type: "button",
        onclick: () => {
          state.toolFamily = "all";
          renderTools(root);
        },
      },
      "All",
      h("span", { class: "chip-count", text: String(state.tools.length) }),
    ),
    ...FAMILIES.map((family) => {
      const count = state.tools.filter(
        (tool) => familyOf(tool.name) === family.id,
      ).length;
      return h(
        "button",
        {
          class: `chip-button ${familyFilter === family.id ? "active" : ""}`,
          type: "button",
          onclick: () => {
            state.toolFamily = family.id;
            renderTools(root);
          },
        },
        family.label,
        h("span", { class: "chip-count", text: String(count) }),
      );
    }),
  );

  const sections = [...grouped.entries()].map(([familyId, list]) => {
    const family = FAMILIES.find((candidate) => candidate.id === familyId);
    return h(
      "section",
      { class: "panel" },
      h(
        "div",
        { class: "panel-header" },
        h(
          "div",
          {},
          h("h2", { text: family?.label ?? "Other" }),
          h("p", { text: family?.blurb ?? "Every remaining tool." }),
        ),
        h("div", { class: "spacer" }),
        h("span", { class: "badge", text: `${list.length} tools` }),
      ),
      h(
        "div",
        { class: "tool-grid" },
        ...list.map((tool) =>
          h(
            "button",
            {
              class: "tool-card",
              type: "button",
              onclick: () => launchTool(tool.name, defaultArgs(tool)),
            },
            h(
              "span",
              { class: "tool-card-title" },
              h("strong", { text: tool.title ?? humanize(tool.name) }),
              tool.hostDependent
                ? h("span", { class: "badge warn", text: "host" })
                : null,
              ...annotationBadges(tool),
            ),
            h("span", {
              class: "muted blurb",
              text: tool.description?.slice(0, 150) ?? "",
            }),
            h("code", {
              class: "tool-cmd",
              text: tool.cli ?? `rea ${tool.name.replaceAll("_", "-")}`,
            }),
          ),
        ),
      ),
    );
  });

  container.append(
    h("section", { class: "toolbar-panel" }, searchInput, chips),
    ...(sections.length === 0
      ? [
          h(
            "div",
            { class: "empty-state" },
            h("h3", { text: "No tools match" }),
            h("p", { text: "Try a different family or search term." }),
          ),
        ]
      : sections),
  );
  root.replaceChildren(container);
  return { container };
};

/**
 * MCP annotations REA publishes for every tool. They are the difference between
 * a read-only inspection and a call that rewrites the session's analysis state,
 * so show the ones that change what a click will do. `idempotentHint` is left
 * out: it tells you nothing about safety.
 *
 * @param {import("../store.js").Tool} tool
 */
const annotationBadges = (tool) => {
  const annotations = tool.annotations;
  if (annotations === undefined || annotations === null) return [];
  const badges = [];
  if (annotations.readOnlyHint === true)
    badges.push(h("span", { class: "badge ok", text: "read-only" }));
  if (annotations.destructiveHint === true)
    badges.push(
      h("span", {
        class: "badge warn",
        title: "Edits analysis state; original bytes are not modified.",
        text: "edits state",
      }),
    );
  if (annotations.openWorldHint === true)
    badges.push(
      h("span", {
        class: "badge",
        title: "Reaches a device, browser, engine or network target.",
        text: "open world",
      }),
    );
  return badges;
};

const defaultArgs = (tool) => {
  const target = state.selectedTarget;
  if (target === null) return {};
  const key = pathKeyOf(tool);
  return key === null ? {} : { [key]: target.path };
};

export { set };
