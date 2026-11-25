import {
  formatBytes,
  formatDuration,
  h,
  humanize,
  prettyJson,
} from "../dom.js";
import {
  copyButton,
  hexPreview,
  jsonBlock,
  kvGrid,
  sectionHeader,
  stat,
  valueView,
} from "../ui.js";

/** The canonical Evidence envelope shared by most REA tools. */
const envelopeOf = (payload) => {
  if (payload === null || typeof payload !== "object") return null;
  if (
    typeof payload.evidence_id === "string" &&
    payload.normalized_result !== undefined
  )
    return payload;
  if (payload.evidence?.evidence_id !== undefined) return payload.evidence;
  return null;
};

/** Tabs of tailored projections over one tool result. */
const PROJECTIONS = {
  inspect_go_binary: (result) => goProjection(result),
  inspect_managed_artifact: (result) => managedProjection(result),
  inspect_sqlite_database: (result) => sqliteProjection(result),
  inspect_native_exports: (result) => exportsProjection(result),
  inspect_elf_notes: (result) => notesProjection(result),
  inspect_byte_entropy: (result) => entropyProjection(result),
  inspect_artifact: (result) => inventoryProjection(result),
  binary_overview: (result) => overviewProjection(result),
  binary_session: (result) => sessionProjection(result),
  analyze_javascript_application: (result) => javascriptProjection(result),
  inspect_pe_imports: (result) => peImportsProjection(result),
};

const normalizedOf = (result) => {
  const envelope = envelopeOf(result.payload);
  return envelope?.normalized_result ?? result.payload;
};

/** Human summary chips shown above the payload. */
export const resultHeader = (result) => {
  const envelope = envelopeOf(result.payload);
  const subject = envelope?.subject;
  return h(
    "div",
    { class: "result-meta" },
    h("span", {
      class: `badge ${result.status === "ok" ? "ok" : "bad"}`,
      text: result.status === "ok" ? "Completed" : "Failed",
    }),
    h("span", { class: "chip", text: humanize(result.tool) }),
    result.durationMs === undefined
      ? null
      : h("span", { class: "faint", text: formatDuration(result.durationMs) }),
    subject === undefined
      ? null
      : h("span", { class: "chip", text: subject.name ?? "artifact" }),
    envelope?.provider
      ? h("span", {
          class: "faint mono",
          title: envelope.provider.name,
          text: envelope.provider.id,
        })
      : null,
    envelope?.evidence_id
      ? copyButton("Copy evidence id", envelope.evidence_id)
      : null,
  );
};

/** Render a completed call: tailored tabs, then the raw evidence. */
export const renderResult = (result) => {
  if (result.status === "error") return renderError(result);
  const projection = PROJECTIONS[result.tool]?.(result);
  if (projection === undefined) {
    const envelope = envelopeOf(result.payload);
    return h(
      "div",
      { class: "stack" },
      resultHeader(result),
      envelope?.normalized_result === undefined
        ? jsonBlock(result.payload, "Result")
        : h(
            "div",
            { class: "stack" },
            jsonBlock(envelope.normalized_result, "Result"),
            evidenceFooter(envelope),
          ),
    );
  }
  return h(
    "div",
    { class: "stack" },
    resultHeader(result),
    projection.body,
    h(
      "details",
      { class: "raw-details" },
      h("summary", { text: "Raw evidence JSON" }),
      h("div", { class: "mono pre", text: prettyJson(result.payload) }),
    ),
  );
};

const renderError = (result) => {
  const error = result.error ?? {};
  return h(
    "div",
    { class: "stack" },
    resultHeader(result),
    h(
      "div",
      { class: "error-card" },
      h("span", { class: "badge bad", text: error.code ?? "failed" }),
      h("h3", { text: error.message ?? "The tool failed." }),
      error.remediation
        ? h(
            "p",
            { class: "muted" },
            h("strong", { text: "How to fix: " }),
            error.remediation,
          )
        : null,
      error.details
        ? h(
            "details",
            {},
            h("summary", { text: "Diagnostics" }),
            h("pre", { class: "mono pre", text: prettyJson(error.details) }),
          )
        : null,
    ),
  );
};

/** Provider, confidence, authority and limitations for an Evidence envelope. */
export const evidenceFooter = (envelope) =>
  h(
    "div",
    { class: "evidence-footer" },
    kvGrid([
      [
        "Provider",
        envelope.provider
          ? `${envelope.provider.name} (${envelope.provider.id})`
          : undefined,
      ],
      ["Confidence", envelope.confidence],
      ["Authority", envelope.authority],
      ["Operation", envelope.operation],
    ]),
    envelope.limitations?.length
      ? h(
          "div",
          { class: "limitations" },
          h("span", { class: "eyebrow", text: "Limitations" }),
          h(
            "ul",
            {},
            ...envelope.limitations.map((limitation) =>
              h("li", { text: limitation }),
            ),
          ),
        )
      : null,
  );

const tabbed = (tabs) => {
  const body = h("div", { class: "tab-body" });
  const buttons = [];
  const select = (index) => {
    for (const [position, button] of buttons.entries())
      button.setAttribute("aria-selected", String(position === index));
    body.replaceChildren(tabs[index]?.render() ?? "");
  };
  const tabList = h(
    "div",
    { class: "tabs", role: "tablist" },
    ...tabs.map((tab, index) => {
      const button = h(
        "button",
        {
          class: "tab",
          role: "tab",
          type: "button",
          onclick: () => select(index),
        },
        tab.label,
        tab.count === undefined
          ? null
          : h("span", { class: "tab-count", text: String(tab.count) }),
      );
      buttons.push(button);
      return button;
    }),
  );
  select(0);
  return h("div", { class: "tabs-shell" }, tabList, body);
};

const summaryRows = (rows) =>
  h(
    "div",
    { class: "stat-row" },
    ...rows.map(([label, value, hint]) => stat(label, value, hint)),
  );

const table = (headers, rows, emptyLabel = "No rows") =>
  rows.length === 0
    ? h("p", { class: "faint pad", text: emptyLabel })
    : h(
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
                  h(
                    "td",
                    {},
                    cell instanceof Node ? cell : String(cell ?? "—"),
                  ),
                ),
              ),
            ),
          ),
        ),
      );

// ---------------------------------------------------------------- projections

function goProjection(result) {
  const data = normalizedOf(result);
  const info = data?.build_info;
  const settings = info?.settings ?? [];
  const modules = info?.dependencies ?? info?.modules ?? [];
  return {
    body: h(
      "div",
      { class: "stack" },
      summaryRows([
        ["Format", data?.format ?? "—"],
        ["Architecture", `${data?.architecture ?? "—"} ${data?.bits ?? ""}`],
        ["Bytes", data?.artifact ? formatBytes(data.artifact.bytes) : "—"],
        ["Build info", info === null ? "absent" : "present"],
      ]),
      info === null
        ? h(
            "div",
            { class: "notice" },
            "No Go build information was found. This is normal for non-Go binaries; the result does not establish that the binary is not Go.",
          )
        : tabbed([
            {
              label: "Modules",
              count: modules.length,
              render: () =>
                table(
                  ["Path", "Version"],
                  modules.map((m) => [m.path ?? m.name, m.version]),
                ),
            },
            {
              label: "Settings",
              count: settings.length,
              render: () =>
                table(
                  ["Key", "Value"],
                  settings.map((s) => [s.key ?? s.Key, s.value ?? s.Value]),
                ),
            },
            {
              label: "Compiler",
              render: () =>
                kvGrid([
                  ["Go version", info.go_version],
                  ["Compiler", info.compiler],
                  ["OS/Arch", info.target],
                ]),
            },
          ]),
      evidenceFooter(envelopeOf(result.payload) ?? {}),
    ),
  };
}

function managedProjection(result) {
  const data = normalizedOf(result);
  const classification = data?.classification ?? {};
  const references = data?.references ?? [];
  const attributes = data?.attributes ?? [];
  const tables = Object.entries(data?.metadata?.table_row_counts ?? {});
  const tone =
    classification.status === "managed"
      ? "ok"
      : classification.status === "malformed"
        ? "bad"
        : "warn";
  return {
    body: h(
      "div",
      { class: "stack" },
      summaryRows([
        [
          "Classification",
          h("span", {
            class: `badge ${tone}`,
            text: classification.status ?? "unknown",
          }),
        ],
        ["Implementation", classification.implementation ?? "—"],
        ["Assembly", data?.assembly?.name || "—"],
        ["References", references.length],
      ]),
      tabbed([
        {
          label: "Identity",
          render: () =>
            kvGrid([
              ["Container", classification.container],
              ["Runtime family", classification.runtime_family],
              ["Managed architecture", classification.managed_architecture],
              ["Assembly", data?.assembly?.name],
              ["Version", data?.assembly?.version],
              ["Module", data?.module?.name],
              ["MVID", data?.module?.mvid],
              ["Metadata version", data?.metadata?.version],
              ["Metadata status", data?.metadata?.status],
            ]),
        },
        {
          label: "References",
          count: references.length,
          render: () =>
            table(
              ["Assembly", "Version"],
              references.map((reference) => [
                reference.name,
                reference.version,
              ]),
              "This assembly declares no references.",
            ),
        },
        {
          label: "Tables",
          count: tables.length,
          render: () =>
            table(
              ["Metadata table", "Rows"],
              tables.map(([name, rows]) => [name, rows]),
              "No metadata tables were admitted.",
            ),
        },
        {
          label: "Attributes",
          count: attributes.length,
          render: () =>
            table(
              ["Attribute", "Value"],
              attributes.map((a) => [a.name, a.value ?? ""]),
              "No custom attributes.",
            ),
        },
      ]),
      (data?.limitations ?? []).length > 0
        ? h(
            "div",
            { class: "limitations" },
            h("span", { class: "eyebrow", text: "Limitations" }),
            h("ul", {}, ...data.limitations.map((text) => h("li", { text }))),
          )
        : null,
      evidenceFooter(envelopeOf(result.payload) ?? {}),
    ),
  };
}

function sqliteProjection(result) {
  const data = normalizedOf(result);
  const tables = data?.tables ?? data?.schema?.tables ?? [];
  const indexes = data?.indexes ?? data?.schema?.indexes ?? [];
  const views = data?.views ?? data?.schema?.views ?? [];
  return {
    body: h(
      "div",
      { class: "stack" },
      summaryRows([
        [
          "Engine",
          `${data?.engine?.name ?? "SQLite"} ${data?.engine?.version ?? ""}`,
        ],
        ["Tables", tables.length],
        ["Indexes", indexes.length],
        ["Views", views.length],
      ]),
      tabbed([
        {
          label: "Tables",
          count: tables.length,
          render: () =>
            h(
              "div",
              { class: "stack" },
              ...tables.map((t) =>
                h(
                  "details",
                  { class: "table-card", open: tables.length <= 3 },
                  h(
                    "summary",
                    {},
                    h("strong", { text: t.name }),
                    h("span", {
                      class: "faint",
                      text: ` ${(t.columns ?? []).length} columns`,
                    }),
                  ),
                  table(
                    ["Column", "Type", "Not null", "Primary key"],
                    (t.columns ?? []).map((c) => [
                      c.name,
                      c.type ?? "",
                      c.not_null ? "yes" : "",
                      c.primary_key ? "yes" : "",
                    ]),
                  ),
                  t.rows?.length
                    ? table(
                        (t.columns ?? []).map((c) => c.name),
                        t.rows.map((row) =>
                          Array.isArray(row) ? row : Object.values(row),
                        ),
                      )
                    : null,
                ),
              ),
              tables.length === 0
                ? h("p", { class: "faint pad", text: "No tables." })
                : null,
            ),
        },
        {
          label: "Indexes",
          count: indexes.length,
          render: () =>
            table(
              ["Name", "Table", "Unique"],
              indexes.map((i) => [
                i.name,
                i.table ?? "",
                i.unique ? "yes" : "",
              ]),
              "No indexes.",
            ),
        },
        {
          label: "Views",
          count: views.length,
          render: () =>
            table(
              ["Name", "SQL"],
              views.map((v) => [v.name, v.sql ?? ""]),
              "No views.",
            ),
        },
      ]),
      evidenceFooter(envelopeOf(result.payload) ?? {}),
    ),
  };
}

function exportsProjection(result) {
  const data = normalizedOf(result);
  const exports = data?.exports ?? [];
  return {
    body: h(
      "div",
      { class: "stack" },
      summaryRows([
        ["Format", data?.format],
        ["Architecture", data?.architecture],
        ["Exports", exports.length],
      ]),
      table(
        ["Name", "Value", "Size", "Type", "Binding", "Version"],
        exports.map((entry) => [
          h("span", { class: "mono", text: entry.name }),
          h("span", { class: "mono faint", text: entry.value }),
          entry.size,
          entry.type,
          entry.binding,
          entry.version?.name ?? "",
        ]),
      ),
      evidenceFooter(envelopeOf(result.payload) ?? {}),
    ),
  };
}

function notesProjection(result) {
  const data = normalizedOf(result);
  const notes = data?.notes ?? data?.entries ?? [];
  return {
    body: h(
      "div",
      { class: "stack" },
      summaryRows([
        ["Format", data?.format],
        ["Notes", notes.length],
      ]),
      table(
        ["Owner", "Type", "Details"],
        notes.map((note) => [
          note.owner ?? note.name,
          note.type ?? note.note_type,
          prettyJson(note.fields ?? note).slice(0, 160),
        ]),
      ),
      evidenceFooter(envelopeOf(result.payload) ?? {}),
    ),
  };
}

function entropyProjection(result) {
  const data = normalizedOf(result);
  const blocks = data?.blocks ?? [];
  const peak = Math.max(
    1,
    ...blocks.map((block) => Number(block.entropy ?? 0)),
  );
  return {
    body: h(
      "div",
      { class: "stack" },
      summaryRows([
        ["Block size", data?.block_size ? formatBytes(data.block_size) : "—"],
        ["Blocks", blocks.length],
        [
          "Overall entropy",
          data?.entropy?.toFixed?.(4) ?? data?.overall_entropy ?? "—",
        ],
      ]),
      h(
        "div",
        {
          class: "entropy-chart",
          role: "img",
          "aria-label": "Block entropy chart",
        },
        ...blocks.slice(0, 256).map((block) =>
          h("span", {
            class: "entropy-bar",
            style: `height:${Math.max(2, (Number(block.entropy ?? 0) / peak) * 100)}%`,
            title: `${block.offset}: ${Number(block.entropy ?? 0).toFixed(3)}`,
          }),
        ),
      ),
      h(
        "p",
        { class: "faint" },
        "Entropy near 8.0 suggests compressed or encrypted data; a flat low band suggests zero padding. Entropy is an observation, not proof of packing.",
      ),
      evidenceFooter(envelopeOf(result.payload) ?? {}),
    ),
  };
}

function inventoryProjection(result) {
  const data = normalizedOf(result);
  return {
    body: h(
      "div",
      { class: "stack" },
      kvGrid([
        ["Format", data?.format ?? data?.kind],
        ["Architecture", data?.architecture],
        ["Bytes", data?.bytes ?? data?.artifact?.bytes],
        ["SHA-256", data?.sha256 ?? data?.artifact?.sha256],
        ["Entries", data?.entries?.length],
      ]),
      data?.entries?.length
        ? table(
            ["Path", "Kind", "Bytes"],
            data.entries
              .slice(0, 200)
              .map((entry) => [
                entry.path ?? entry.name,
                entry.kind ?? entry.type,
                entry.bytes ?? entry.size,
              ]),
          )
        : null,
      evidenceFooter(envelopeOf(result.payload) ?? {}),
    ),
  };
}

function overviewProjection(result) {
  const data = normalizedOf(result);
  return {
    body: h(
      "div",
      { class: "stack" },
      summaryRows([
        ["Procedures", data?.procedure_count ?? "—"],
        ["Strings", data?.string_count ?? "—"],
        ["Segments", data?.segment_count ?? "—"],
      ]),
      data?.segments?.length
        ? table(
            ["Name", "Start", "End", "Permissions"],
            data.segments.map((segment) => [
              segment.name,
              segment.start,
              segment.end,
              segment.permissions ?? segment.flags,
            ]),
          )
        : null,
      evidenceFooter(envelopeOf(result.payload) ?? {}),
    ),
  };
}

function sessionProjection(result) {
  const data = normalizedOf(result);
  const providers = data?.capabilities ?? [];
  const available = providers.flatMap((provider) =>
    (provider.groups ?? [])
      .filter((group) => group.available)
      .map((group) => ({ provider: provider.provider, group })),
  );
  return {
    body: h(
      "div",
      { class: "stack" },
      summaryRows([
        ["Session", data?.open === true ? "open" : "idle"],
        ["Providers", providers.length],
        ["Available groups", available.length],
      ]),
      table(
        ["Provider", "Operations", "Effects"],
        available.map(({ provider, group }) => [
          provider?.name ?? provider?.id,
          (group.operations ?? []).join(", "),
          (group.effects ?? []).join(", "),
        ]),
        "No provider reported an available capability group on this host.",
      ),
      h(
        "p",
        { class: "faint" },
        "Unavailable groups name their own remedy (install a decompiler, set a provider variable, or use a supported host). The workspace surfaces that reason next to each tool.",
      ),
    ),
  };
}

function javascriptProjection(result) {
  const data = normalizedOf(result);
  const modules = data?.modules ?? [];
  const boundaries = data?.electron_boundaries ?? [];
  return {
    body: h(
      "div",
      { class: "stack" },
      summaryRows([
        ["Modules", modules.length],
        ["Imports", data?.imports?.length ?? "—"],
        ["Electron boundaries", boundaries.length],
      ]),
      tabbed([
        {
          label: "Modules",
          count: modules.length,
          render: () =>
            table(
              ["Path", "Kind", "Imports", "Exports"],
              modules.map((module) => [
                module.path ?? module.file,
                module.kind ?? module.format ?? "",
                module.imports?.length ?? "",
                module.exports?.length ?? "",
              ]),
            ),
        },
        {
          label: "Boundaries",
          count: boundaries.length,
          render: () =>
            table(
              ["Kind", "Detail"],
              boundaries.map((boundary) => [
                boundary.kind,
                prettyJson(boundary).slice(0, 200),
              ]),
              "No Electron boundaries were observed.",
            ),
        },
      ]),
      evidenceFooter(envelopeOf(result.payload) ?? {}),
    ),
  };
}

function peImportsProjection(result) {
  const data = normalizedOf(result);
  const imports = data?.imports ?? data?.dlls ?? [];
  return {
    body: h(
      "div",
      { class: "stack" },
      summaryRows([
        ["Imported DLLs", imports.length],
        ["Import hash", data?.imphash ?? "—"],
      ]),
      table(
        ["DLL", "Functions", "Delay load"],
        imports.map((entry) => [
          entry.dll ?? entry.name,
          entry.functions?.length ?? entry.function_count ?? "",
          entry.delay_load ? "yes" : "",
        ]),
      ),
      evidenceFooter(envelopeOf(result.payload) ?? {}),
    ),
  };
}

export { envelopeOf, hexPreview, sectionHeader };
