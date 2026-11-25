import { formatDuration, h, humanize, inputOf } from "../dom.js";
import { renderResult } from "../render/evidence.js";
import { copyButton, sectionHeader } from "../ui.js";
import { state } from "../store.js";
import { api } from "../api.js";
import { BUNDLE_TRANSFER_NOTE, describeTransfer } from "../evidence-bundle.js";

/** Evidence view: every result with an evidence id, searchable and copyable. */
export const renderEvidence = (root) => {
  const container = h("div", { class: "stack view-stack" });
  const list = h("div", { class: "evidence-list" });
  const searchInput = h("input", {
    type: "search",
    placeholder: "Filter by tool, evidence id or subject…",
    value: state.evidenceSearch ?? "",
    oninput: (event) => {
      state.evidenceSearch = inputOf(event).value;
      renderList();
    },
  });
  const renderList = () => {
    const search = (state.evidenceSearch ?? "").toLowerCase();
    const filtered = state.evidence.filter((entry) => {
      if (search.length === 0) return true;
      const haystack =
        `${entry.tool} ${entry.payload?.evidence_id ?? ""} ${entry.payload?.subject?.name ?? ""}`.toLowerCase();
      return haystack.includes(search);
    });
    list.replaceChildren(
      ...(filtered.length === 0
        ? [
            h(
              "div",
              { class: "empty-state" },
              h("h3", {
                text:
                  state.evidence.length === 0
                    ? "No evidence yet"
                    : "No matches",
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
  };
  renderList();

  container.append(
    h(
      "section",
      { class: "panel" },
      sectionHeader(
        "Evidence",
        `${state.evidence.length} record${state.evidence.length === 1 ? "" : "s"} retained in this session`,
      ),
      bundleTransferPanel(),
      h("div", { class: "tree-toolbar" }, searchInput),
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
        // The panel starts hidden so a collapsed row costs nothing to lay out;
        // opening the row has to reveal it, or the payload below the summary
        // stays invisible.
        details.hidden = !node.open;
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

/**
 * Evidence bundle transfer.
 *
 * REA exports and imports bundles by absolute local path. That is unusable
 * from a browser, and until now this view offered a "Download bundle" button
 * that wrote an invented `rea-web-evidence-summary` shape instead — a file REA
 * rejects with `evidence_integrity_mismatch`. Anyone who archived that file
 * believed they had saved evidence. The panel below replaces it: the server
 * picks a workspace path, REA writes the canonical bundle there, and the bytes
 * served back are the ones REA wrote.
 */
const bundleTransferPanel = () => {
  const status = h("p", { class: "faint small", text: BUNDLE_TRANSFER_NOTE });
  const outcome = h("div", { class: "bundle-outcome" });
  const fileInput = /** @type {HTMLInputElement} */ (
    h("input", {
      type: "file",
      accept: ".json,application/json",
      class: "visually-hidden",
      onchange: () => {
        import_().catch(() => undefined);
      },
    })
  );

  /** Send the chosen file and report REA's verdict verbatim. */
  const import_ = async () => {
    const file = fileInput.files?.[0];
    if (file === undefined) return;
    outcome.replaceChildren(
      h("p", { class: "faint small", text: `Importing ${file.name}…` }),
    );
    try {
      const result = await api.importEvidenceBundle(file);
      const described = describeTransfer({
        accepted: result.accepted,
        rejection: result.rejection,
        staged: result.staged,
        result: result.result,
      });
      outcome.replaceChildren(
        h(
          "div",
          { class: described.ok ? "notice ok" : "notice warn" },
          h("strong", { text: described.title }),
          h("p", { text: described.body }),
          described.detail === null
            ? null
            : h("p", { class: "mono small", text: described.detail }),
        ),
      );
    } catch (error) {
      outcome.replaceChildren(
        h(
          "div",
          { class: "notice warn" },
          h("strong", { text: "The bundle could not be sent" }),
          h("p", {
            text: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    } finally {
      fileInput.value = "";
    }
  };

  const exportButton = /** @type {HTMLButtonElement} */ (
    h(
      "button",
      {
        class: "ghost-button small",
        type: "button",
        onclick: async () => {
          exportButton.disabled = true;
          outcome.replaceChildren(
            h("p", {
              class: "faint small",
              text: "Asking REA to write the bundle…",
            }),
          );
          try {
            const bundle = await api.exportEvidenceBundle();
            const described = describeTransfer({
              accepted: true,
              receipt: bundle.receipt,
              name: bundle.name,
              bytes: bundle.bytes,
              sha256: bundle.sha256,
            });
            // REA's own bytes, offered as a download. Nothing re-serialises them.
            const blob = new Blob([bundle.contents], {
              type: "application/json",
            });
            const link = document.createElement("a");
            const downloadUrl = URL.createObjectURL(blob);
            link.href = downloadUrl;
            link.download = bundle.name;
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
            outcome.replaceChildren(
              h(
                "div",
                { class: "notice ok" },
                h("strong", { text: described.title }),
                h("p", { text: described.body }),
                h("p", { class: "mono small", text: described.detail ?? "" }),
              ),
            );
          } catch (error) {
            outcome.replaceChildren(
              h(
                "div",
                { class: "notice warn" },
                h("strong", { text: "REA did not export a bundle" }),
                h("p", {
                  text: error instanceof Error ? error.message : String(error),
                }),
              ),
            );
          } finally {
            exportButton.disabled = false;
          }
        },
      },
      "Export canonical bundle",
    )
  );

  const importButton = h(
    "button",
    {
      class: "ghost-button small",
      type: "button",
      onclick: () => fileInput.click(),
    },
    "Import bundle…",
  );

  return h(
    "div",
    { class: "bundle-transfer" },
    h(
      "div",
      { class: "bundle-actions" },
      exportButton,
      importButton,
      fileInput,
    ),
    status,
    outcome,
  );
};
