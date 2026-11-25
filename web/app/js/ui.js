import {
  byId,
  copyText,
  formatBytes,
  formatDuration,
  h,
  humanize,
  prettyJson,
} from "./dom.js";

/** Transient notifications. */
export const toast = (title, body, kind = "info") => {
  const stack = byId("toasts");
  const node = h(
    "div",
    { class: `toast ${kind}`, role: "status" },
    h(
      "div",
      { class: "toast-body" },
      h("strong", { text: title }),
      body === undefined ? null : h("div", { text: body }),
    ),
  );
  stack.append(node);
  setTimeout(
    () => {
      node.style.opacity = "0";
      node.style.transform = "translateY(6px)";
      node.style.transition = "opacity 180ms, transform 180ms";
      setTimeout(() => node.remove(), 200);
    },
    kind === "error" ? 9000 : 5000,
  );
};

/** Section header with optional actions. */
export const sectionHeader = (title, subtitle, ...actions) =>
  h(
    "div",
    { class: "panel-header" },
    h(
      "div",
      {},
      h("h2", { text: title }),
      subtitle ? h("p", { text: subtitle }) : null,
    ),
    h("div", { class: "spacer" }),
    ...actions,
  );

/** Copy button bound to a value producer. */
export const copyButton = (label, valueOf) =>
  h(
    "button",
    {
      class: "ghost-button small",
      type: "button",
      onclick: async (event) => {
        event.stopPropagation();
        const ok = await copyText(
          typeof valueOf === "function" ? valueOf() : valueOf,
        );
        toast(
          ok ? "Copied" : "Copy failed",
          ok ? undefined : "The clipboard is unavailable.",
          ok ? "info" : "error",
        );
      },
    },
    label,
  );

const HEX_PREVIEW_BYTES = 64;

/** Render an unknown value compactly: tables for arrays, key/value rows for objects. */
export const valueView = (value, depth = 0) => {
  if (value === null || value === undefined)
    return h("span", { class: "faint", text: "—" });
  if (typeof value === "boolean")
    return h("span", {
      class: `badge ${value ? "ok" : ""}`,
      text: String(value),
    });
  if (typeof value === "number")
    return h("span", {
      class: "mono",
      text: Number.isInteger(value) ? String(value) : value.toFixed(4),
    });
  if (typeof value === "string") {
    if (value.length <= 80) return h("span", { class: "mono", text: value });
    return h(
      "details",
      { class: "string-expander" },
      h(
        "summary",
        { class: "mono" },
        `${value.slice(0, 80)}… (${formatBytes(value.length)})`,
      ),
      h("pre", { class: "mono", text: value }),
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return h("span", { class: "faint", text: "empty" });
    const preview = value.slice(0, 12);
    return h(
      "div",
      { class: "value-array" },
      h("div", {
        class: "faint",
        text: `${value.length} item${value.length === 1 ? "" : "s"}`,
      }),
      h(
        "div",
        { class: "value-array-items" },
        ...preview.map((item) =>
          typeof item === "object" && item !== null
            ? h(
                "div",
                { class: "value-object-card" },
                valueView(item, depth + 1),
              )
            : h("span", { class: "chip" }, valueView(item, depth + 1)),
        ),
      ),
      value.length > preview.length
        ? h("div", {
            class: "faint",
            text: `…and ${value.length - preview.length} more`,
          })
        : null,
    );
  }
  if (depth > 3)
    return h("span", {
      class: "mono faint",
      text: prettyJson(value).slice(0, 200),
    });
  return h(
    "div",
    { class: "value-object" },
    ...Object.entries(value).map(([key, child]) =>
      h(
        "div",
        { class: "value-row" },
        h("span", { class: "value-key", text: key.replaceAll("_", " ") }),
        h("div", { class: "value-content" }, valueView(child, depth + 1)),
      ),
    ),
  );
};

/** Preformatted JSON block with a copy control. */
export const jsonBlock = (value, label = "JSON") =>
  h(
    "div",
    { class: "result" },
    h(
      "div",
      { class: "result-header" },
      h("span", { text: label }),
      h("div", { class: "spacer" }),
      copyButton("Copy", () => prettyJson(value)),
    ),
    h(
      "div",
      { class: "result-body" },
      h("pre", { class: "mono", text: prettyJson(value) }),
    ),
  );

/** Hex preview for a byte-ish string (hex from read_bytes, etc.). */
export const hexPreview = (hex, offset = 0) => {
  const clean = String(hex).replaceAll(/[^0-9a-fA-F]/gu, "");
  const bytes = clean.slice(0, HEX_PREVIEW_BYTES * 2).match(/.{1,2}/gu) ?? [];
  const rows = [];
  for (let index = 0; index < bytes.length; index += 16) {
    const slice = bytes.slice(index, index + 16);
    const ascii = slice
      .map((byte) => {
        const code = Number.parseInt(byte, 16);
        return code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : ".";
      })
      .join("");
    rows.push({
      offset: (offset + index).toString(16).padStart(8, "0"),
      hex: slice.join(" ").padEnd(47, " "),
      ascii,
    });
  }
  return h(
    "div",
    { class: "hex-view mono" },
    ...rows.map((row) =>
      h(
        "div",
        {},
        h("span", { class: "hex-offset", text: row.offset }),
        " ",
        h("span", { text: row.hex }),
        " ",
        h("span", { class: "hex-ascii", text: row.ascii }),
      ),
    ),
  );
};

/** Findings list: each item is {tone, title, detail}. */
export const findingList = (findings) =>
  h(
    "div",
    { class: "finding-list" },
    ...findings.map((finding) =>
      h(
        "div",
        { class: "finding" },
        h("span", { class: `dot ${finding.tone ?? "ok"}` }),
        h(
          "div",
          {},
          h("strong", { text: finding.title }),
          finding.detail
            ? h("p", { class: "muted", text: finding.detail })
            : null,
        ),
      ),
    ),
  );

/** Stat tile. */
export const stat = (label, value, hint) =>
  h(
    "div",
    { class: "stat" },
    h("span", { class: "eyebrow", text: label }),
    h("strong", { class: "stat-value", text: value }),
    hint ? h("span", { class: "faint", text: hint }) : null,
  );

/** Metadata key/value grid. */
export const kvGrid = (pairs) =>
  h(
    "dl",
    { class: "kv-grid" },
    ...pairs
      .filter(
        ([, value]) => value !== undefined && value !== null && value !== "",
      )
      .map(([key, value]) =>
        h(
          "div",
          { class: "kv" },
          h("dt", { text: key }),
          h("dd", {}, valueView(value)),
        ),
      ),
  );

/** Small inline spinner line for running calls. */
export const runningLine = (label = "Running analysis…") =>
  h(
    "div",
    { class: "progress-line" },
    h("span", { class: "spinner-inline" }),
    label,
  );

/** Hook mirroring a scroll position for sticky tables. */
export const stickyTable = (headers, rows) =>
  h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "data-table" },
      h(
        "thead",
        {},
        h("tr", {}, ...headers.map((header) => h("th", { text: header }))),
      ),
      h(
        "tbody",
        {},
        ...rows.map((row) =>
          h(
            "tr",
            {},
            ...row.map((cell) =>
              h("td", {}, cell instanceof Node ? cell : String(cell)),
            ),
          ),
        ),
      ),
    ),
  );

export { formatBytes, formatDuration, humanize };
