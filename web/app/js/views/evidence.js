import { formatDuration, h, humanize, inputOf, prettyJson } from "../dom.js";
import { renderResult } from "../render/evidence.js";
import { copyButton, sectionHeader } from "../ui.js";
import { state } from "../store.js";

/** Evidence view: every result with an evidence id, searchable and copyable. */
export const renderEvidence = (root) => {
  const container = h("div", { class: "stack view-stack" });
  const search = state.evidenceSearch ?? "";
  const filtered = state.evidence.filter((entry) => {
    if (search.length === 0) return true;
    const haystack =
      `${entry.tool} ${entry.payload?.evidence_id ?? ""} ${entry.payload?.subject?.name ?? ""}`.toLowerCase();
    return haystack.includes(search.toLowerCase());
  });

  const list = h(
    "div",
    { class: "evidence-list" },
    ...(filtered.length === 0
      ? [
          h(
            "div",
            { class: "empty-state" },
            h("h3", {
              text:
                state.evidence.length === 0 ? "No evidence yet" : "No matches",
            }),
            h("p", {
              text:
                state.evidence.length === 0
                  ? "Every REA analysis returns a canonical Evidence record. Run a tool and it will appear here with its provider, confidence and limitations."
                  : "Try a different tool name, evidence id or subject.",
            }),
          ),
        ]
      : filtered.map((entry) => evidenceRow(entry))),
  );

  container.append(
    h(
      "section",
      { class: "panel" },
      sectionHeader(
        "Evidence",
        `${state.evidence.length} record${state.evidence.length === 1 ? "" : "s"} retained in this session`,
        h(
          "button",
          {
            class: "ghost-button small",
            type: "button",
            onclick: async () => {
              const bundle = {
                kind: "rea-web-evidence-summary",
                generated_at: new Date().toISOString(),
                records: state.evidence.map((entry) => ({
                  tool: entry.tool,
                  status: entry.status,
                  duration_ms: entry.durationMs,
                  payload: entry.payload,
                })),
              };
              const blob = new Blob([prettyJson(bundle)], {
                type: "application/json",
              });
              const link = document.createElement("a");
              link.href = URL.createObjectURL(blob);
              link.download = `rea-web-evidence-${Date.now()}.json`;
              link.click();
              URL.revokeObjectURL(link.href);
            },
          },
          "Download bundle",
        ),
      ),
      h(
        "div",
        { class: "tree-toolbar" },
        h("input", {
          type: "search",
          placeholder: "Filter by tool, evidence id or subject…",
          value: search,
          oninput: (event) => {
            state.evidenceSearch = inputOf(event).value;
            renderEvidence(root);
          },
        }),
      ),
      list,
    ),
  );
  root.replaceChildren(container);
  return { container };
};

const evidenceRow = (entry) => {
  const envelope =
    entry.payload?.evidence_id === undefined ? null : entry.payload;
  const details = h("div", { class: "evidence-detail", hidden: true });
  return h(
    "details",
    {
      class: "evidence-row",
      ontoggle: (event) => {
        const node = /** @type {HTMLDetailsElement} */ (event.target);
        if (node.open && details.childElementCount === 0) {
          details.append(
            renderResult({
              tool: entry.tool,
              status: entry.status,
              payload: entry.payload,
              error: entry.error,
              durationMs: entry.durationMs,
            }),
          );
        }
      },
    },
    h(
      "summary",
      {},
      h("span", {
        class: `badge ${entry.status === "ok" ? "ok" : "bad"}`,
        text: entry.status ?? "ok",
      }),
      h("span", { class: "mono", text: humanize(entry.tool) }),
      envelope?.subject?.name
        ? h("span", { class: "faint mono", text: envelope.subject.name })
        : null,
      h("div", { class: "spacer" }),
      envelope?.evidence_id
        ? h("span", {
            class: "mono faint small",
            text: envelope.evidence_id.slice(0, 18),
          })
        : null,
      entry.durationMs === undefined
        ? null
        : h("span", { class: "faint", text: formatDuration(entry.durationMs) }),
    ),
    details,
  );
};

export { copyButton };
