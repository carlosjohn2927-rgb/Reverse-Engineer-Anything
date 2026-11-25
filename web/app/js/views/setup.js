import { api } from "../api.js";
import { errorMessage, h } from "../dom.js";
import { readinessFromCapabilities } from "../readiness.js";
import {
  classifyIntegration,
  CONFIGURED_IS_NOT_VERIFIED,
  HOST_INTEGRATIONS,
} from "../host-integrations.js";
import {
  HOST_SUPPORT_IS_NOT_AVAILABILITY,
  hostRestrictionSummary,
  restrictionsFromPayload,
} from "../host-restrictions.js";
import { sectionHeader, toast } from "../ui.js";
import { set, state } from "../store.js";

/** Setup view: runtime status, doctor output and provider remediation. */
export const renderSetup = (root) => {
  const container = h("div", { class: "stack view-stack" });
  const runtimePanel = h("section", { class: "panel" });
  const doctorPanel = h(
    "section",
    { class: "panel" },
    sectionHeader("Readiness", "Loading rea doctor…"),
  );

  const renderRuntime = () => {
    const runtime = state.status?.runtime;
    const rea = state.status?.rea;
    const needsNode24 =
      runtime !== undefined &&
      !/^v?(?:24|26)\./u.test(runtime.nodeVersion ?? "");
    runtimePanel.replaceChildren(
      sectionHeader(
        "Runtime",
        "REA runs in a child process with its own Node.js",
      ),
      h(
        "div",
        { class: "panel-body stack" },
        h(
          "div",
          { class: "stat-row" },
          statTile(
            "REA",
            rea?.version ?? "not built",
            rea?.built ? "compiled runtime found" : "run npm run build:cached",
          ),
          statTile(
            "REA runtime",
            runtime?.nodeVersion ?? "—",
            runtime?.provisioned ? "provisioned by this app" : "server runtime",
          ),
          statTile(
            "Web server",
            runtime?.server ?? "—",
            `pid ${state.status?.sessions ?? 0} sessions`,
          ),
        ),
        needsNode24
          ? h(
              "div",
              { class: "notice warn" },
              h("strong", {
                text: "Node.js 24 is required for SQLite and the full tool set.",
              }),
              h("p", {
                class: "muted",
                text: "The web server detected an older runtime. Install the supported Node.js 24 build into this app's cache so REA child processes use it. Nothing global is changed.",
              }),
              h(
                "button",
                {
                  class: "primary-button",
                  type: "button",
                  onclick: async (event) => {
                    const button = /** @type {HTMLButtonElement} */ (
                      event.currentTarget
                    );
                    button.disabled = true;
                    button.textContent = "Installing…";
                    try {
                      const result = await api.installRuntime();
                      toast("Runtime installed", result.executable);
                      const status = await api.status();
                      set({ status });
                      renderRuntime();
                      loadDoctor();
                    } catch (error) {
                      toast("Install failed", errorMessage(error), "error");
                      button.disabled = false;
                      button.textContent = "Install Node.js 24";
                    }
                  },
                },
                "Install Node.js 24",
              ),
            )
          : h(
              "div",
              { class: "notice ok" },
              h("strong", { text: "Runtime is supported" }),
              h("p", {
                class: "muted",
                text: "REA child processes use the resolved runtime shown above.",
              }),
            ),
      ),
    );
  };

  const loadCapabilities = async () => {
    try {
      const capabilities = await api.capabilities();
      // Publish the per-operation projection so the Tools view can mark the
      // tools that canonically cannot run here.
      set({
        capabilities,
        operationReadiness: readinessFromCapabilities(capabilities),
      });
    } catch (error) {
      set({ capabilities: { unavailable_reason: errorMessage(error) } });
    }
    renderCapabilities();
  };

  const loadDoctor = async () => {
    doctorPanel.replaceChildren(
      sectionHeader("Readiness", "Running rea doctor…"),
    );
    try {
      const doctor = await api.doctor();
      set({ doctor });
      const checks = doctor.scope_checks ?? [];
      doctorPanel.replaceChildren(
        sectionHeader(
          "Readiness",
          doctor.healthy === true
            ? "All scoped checks pass"
            : "Some checks need attention",
          h("span", {
            class: `badge ${doctor.healthy ? "ok" : "warn"}`,
            text: doctor.healthy ? "healthy" : "attention",
          }),
        ),
        h(
          "div",
          { class: "check-list" },
          ...checks.map((check) =>
            h(
              "div",
              { class: "check-row" },
              h("span", { class: `dot ${check.ok ? "ok" : "warn"}` }),
              h(
                "div",
                { class: "check-main" },
                h("strong", { text: check.name }),
                h("span", {
                  class: "faint",
                  text: check.detail ?? check.classification ?? "",
                }),
                check.remediation
                  ? h("p", { class: "muted", text: check.remediation })
                  : null,
              ),
            ),
          ),
        ),
        h(
          "div",
          { class: "panel-actions" },
          h(
            "button",
            {
              class: "ghost-button small",
              type: "button",
              onclick: () => loadDoctor(),
            },
            "Re-run doctor",
          ),
        ),
      );
    } catch (error) {
      doctorPanel.replaceChildren(
        sectionHeader("Readiness", "rea doctor failed"),
        h(
          "div",
          { class: "empty-state" },
          h("h3", { text: "Doctor unavailable" }),
          h("p", { text: errorMessage(error) }),
        ),
      );
    }
  };

  container.append(runtimePanel, doctorPanel);

  const providersPanel = h("section", { class: "panel" });
  const renderProviders = () => {
    const providers = state.doctor?.providerInspections ?? [];
    if (providers.length === 0) {
      providersPanel.replaceChildren();
      return;
    }
    providersPanel.replaceChildren(
      sectionHeader(
        "Deep-analysis providers",
        "Bring-your-own decompilers and engines",
      ),
      h(
        "div",
        { class: "check-list" },
        ...providers.map((provider) =>
          h(
            "div",
            { class: "check-row" },
            h("span", { class: `dot ${provider.available ? "ok" : "warn"}` }),
            h(
              "div",
              { class: "check-main" },
              h("strong", { text: provider.id }),
              h("span", {
                class: "faint",
                text: provider.available
                  ? `available${provider.providerVersion ? ` · ${provider.providerVersion}` : ""}`
                  : "not configured",
              }),
              ...(provider.checks ?? [])
                .filter((check) => !check.ok && check.remediation)
                .slice(0, 2)
                .map((check) =>
                  h("p", { class: "muted", text: check.remediation }),
                ),
            ),
          ),
        ),
      ),
    );
  };

  // ---- Operation readiness ------------------------------------------------
  // `doctor` says which engines are installed. `capabilities` says which
  // *operations* are available right now, per provider, and why the rest are
  // not — including the host-dependent tools (adb, frida, gdb, rizin, jeb,
  // cutter) that doctor never inspects. A tool failing with
  // `capability_unavailable` should be explainable here before it is tried.
  const capabilityPanel = h("section", { class: "panel" });
  const renderCapabilities = () => {
    const payload = state.capabilities;
    if (payload === null || payload === undefined) {
      capabilityPanel.replaceChildren(
        sectionHeader("Operation readiness", "Loading rea capabilities…"),
      );
      return;
    }
    if (payload.unavailable_reason !== undefined) {
      capabilityPanel.replaceChildren(
        headerWithRetry(
          "Operation readiness",
          "rea capabilities could not be read",
          () => void loadCapabilities(),
        ),
        h(
          "div",
          { class: "panel-body" },
          h("pre", {
            class: "code-block workflow-text",
            text: payload.unavailable_reason,
          }),
        ),
      );
      return;
    }
    // Flatten to one row per (provider, group) so a partially available
    // provider is visible instead of collapsed to a single verdict.
    const rows = (payload.capabilities ?? []).flatMap((entry) =>
      (entry.groups ?? []).map((group) => ({
        provider: entry.provider,
        group,
      })),
    );
    if (rows.length === 0) {
      capabilityPanel.replaceChildren(
        h(
          "div",
          { class: "empty-state" },
          h("h3", { text: "No operation readiness reported" }),
          h("p", {
            text: "REA returned no capability groups. Open a target to populate analysis providers.",
          }),
        ),
      );
      return;
    }
    const available = rows.filter((row) => row.group.available === true).length;
    const candidates = payload.analysis_provider_candidates ?? [];
    capabilityPanel.replaceChildren(
      headerWithRetry(
        "Operation readiness",
        `${available} of ${rows.length} operation groups available`,
        () => void loadCapabilities(),
      ),
      h(
        "div",
        { class: "check-list" },
        ...rows.map((row) =>
          h(
            "div",
            { class: "check-row" },
            h("span", {
              class: `dot ${row.group.available ? "ok" : "warn"}`,
            }),
            h(
              "div",
              { class: "check-main" },
              h(
                "div",
                { class: "row" },
                h("strong", { text: row.provider.name ?? row.provider.id }),
                row.group.availability_code === null ||
                  row.group.availability_code === undefined
                  ? null
                  : h("span", {
                      class: "badge",
                      text: row.group.availability_code,
                    }),
                h("span", {
                  class: "faint small mono",
                  text: `${row.group.operations.length} op${row.group.operations.length === 1 ? "" : "s"}`,
                }),
              ),
              h("span", {
                class: "faint mono small",
                text: row.group.operations.join(", "),
              }),
              row.group.available
                ? null
                : h("p", {
                    class: "muted",
                    text: row.group.reason ?? "Unavailable in this session.",
                  }),
              ...((row.group.limitations ?? []).slice(0, 1) ?? []).map(
                (limit) => h("p", { class: "muted small", text: limit }),
              ),
            ),
          ),
        ),
      ),
    );
    if (candidates.length > 0) {
      capabilityPanel.append(
        sectionHeader(
          "Analysis engines",
          "What the decompiler-backed tools depend on",
        ),
        h(
          "div",
          { class: "check-list" },
          ...candidates.map((candidate) =>
            h(
              "div",
              { class: "check-row" },
              h("span", {
                class: `dot ${candidate.availability?.status === "available" ? "ok" : "warn"}`,
              }),
              h(
                "div",
                { class: "check-main" },
                h("strong", {
                  text: candidate.provider?.name ?? candidate.provider?.id,
                }),
                h("span", {
                  class: "faint mono small",
                  text: candidate.availability?.status ?? "unknown",
                }),
                candidate.availability?.reason
                  ? h("p", {
                      class: "muted",
                      text: candidate.availability.reason,
                    })
                  : null,
              ),
            ),
          ),
        ),
      );
    }
  };

  // ---- Host integrations ----------------------------------------------
  // The 51 tools behind adb, frida, gdb, rizin, jeb and cutter appear in
  // neither `doctor` nor `capabilities`, so nothing in the app mentioned them.
  // This reports configuration presence only, and says so.
  const hostPanel = h("section", { class: "panel" });
  const renderHost = () => {
    const observed = state.hostIntegrations;
    if (observed === null || observed === undefined) {
      hostPanel.replaceChildren(
        sectionHeader("Host integrations", "Checking configuration…"),
      );
      return;
    }
    const rows = HOST_INTEGRATIONS.map((integration) => ({
      integration,
      verdict: classifyIntegration(integration, observed),
    }));
    const configured = rows.filter((row) => row.verdict.state === "configured");
    const gated = HOST_INTEGRATIONS.reduce(
      (total, integration) => total + integration.tools,
      0,
    );
    hostPanel.replaceChildren(
      sectionHeader(
        "Host integrations",
        `${configured.length} of ${rows.length} configured · ${gated} tools depend on these`,
        h(
          "button",
          {
            class: "ghost-button small",
            type: "button",
            onclick: () => void loadHostIntegrations(),
          },
          "Re-check",
        ),
      ),
      h(
        "div",
        { class: "notice-row" },
        h(
          "div",
          { class: "notice" },
          h("strong", { text: "Configuration is not availability" }),
          h("p", { class: "muted small", text: CONFIGURED_IS_NOT_VERIFIED }),
        ),
      ),
      h(
        "div",
        { class: "check-list" },
        ...rows.map((row) =>
          h(
            "div",
            { class: "check-row" },
            h("span", {
              class: `dot ${row.verdict.state === "configured" ? "warn" : "bad"}`,
            }),
            h(
              "div",
              { class: "check-main" },
              h(
                "div",
                { class: "row" },
                h("strong", { text: row.integration.label }),
                h("span", {
                  class: "badge",
                  text: `${row.integration.tools} tool${row.integration.tools === 1 ? "" : "s"}`,
                }),
                row.verdict.state === "configured"
                  ? h("span", { class: "badge warn", text: "configured" })
                  : h("span", { class: "badge bad", text: "not configured" }),
              ),
              row.verdict.via === null
                ? h("p", { class: "muted", text: row.integration.remediation })
                : h("p", {
                    class: "faint mono small",
                    text: `found via ${row.verdict.via}`,
                  }),
            ),
          ),
        ),
      ),
    );
  };

  // ---- Host-restricted features ----------------------------------------
  // A different question from configuration: ten integrations are gated on
  // the host itself, so on an unsupported platform no setting will ever make
  // them pass. Both states looked identical (absent from `capabilities`), and
  // they need opposite answers — one needs a path, the other needs a machine.
  const restrictionPanel = h("section", { class: "panel" });
  const renderRestrictions = () => {
    const observed = state.hostRestrictions;
    if (observed === null || observed === undefined) {
      restrictionPanel.replaceChildren(
        sectionHeader("Host-restricted integrations", "Checking this host…"),
      );
      return;
    }
    const host = observed.host ?? { platform: "unknown", arch: "unknown" };
    const blocked = observed.features.filter((feature) => !feature.supported);
    const allowed = observed.features.filter((feature) => feature.supported);
    restrictionPanel.replaceChildren(
      sectionHeader(
        "Host-restricted integrations",
        hostRestrictionSummary(observed.features, host),
        h(
          "button",
          {
            class: "ghost-button small",
            type: "button",
            onclick: () => void loadRestrictions(),
          },
          "Re-check",
        ),
      ),
      h(
        "div",
        { class: "notice-row" },
        h(
          "div",
          { class: "notice" },
          h("strong", { text: "Host support is not availability" }),
          h("p", {
            class: "muted small",
            text: HOST_SUPPORT_IS_NOT_AVAILABILITY,
          }),
        ),
      ),
      // Blocked features first: they are the ones that cannot be fixed here.
      h(
        "div",
        { class: "check-list" },
        ...[...blocked, ...allowed].map((feature) =>
          h(
            "div",
            { class: "check-row" },
            h("span", { class: `dot ${feature.supported ? "warn" : "bad"}` }),
            h(
              "div",
              { class: "check-main" },
              h(
                "div",
                { class: "row" },
                h("strong", { text: feature.label }),
                h("span", {
                  class: "badge",
                  text: `${feature.tools.length} tool${feature.tools.length === 1 ? "" : "s"}`,
                }),
                feature.supported
                  ? h("span", { class: "badge warn", text: "host supported" })
                  : h("span", {
                      class: "badge bad",
                      text: "host not supported",
                    }),
              ),
              h("p", {
                class: "muted",
                text: feature.supported
                  ? `Supported on ${feature.supportedWhen}. Still needs its own configuration.`
                  : feature.reason,
              }),
              feature.supported
                ? null
                : h("p", { class: "faint small", text: feature.remediation }),
              h("p", {
                class: "faint mono small",
                text: feature.tools.join(", "),
              }),
            ),
          ),
        ),
      ),
    );
  };

  const loadRestrictions = async () => {
    try {
      const payload = await api.hostRestrictions();
      set({ hostRestrictions: restrictionsFromPayload(payload) });
    } catch (error) {
      set({
        hostRestrictions: {
          host: null,
          features: [],
          error: errorMessage(error),
        },
      });
    }
    renderRestrictions();
  };

  const loadHostIntegrations = async () => {
    try {
      set({ hostIntegrations: await api.hostIntegrations() });
    } catch (error) {
      set({
        hostIntegrations: {
          env: {},
          onPath: [],
          verified: false,
          error: errorMessage(error),
        },
      });
    }
    renderHost();
  };

  container.append(
    runtimePanel,
    doctorPanel,
    providersPanel,
    capabilityPanel,
    hostPanel,
    restrictionPanel,
  );

  root.replaceChildren(container);
  renderRuntime();
  renderProviders();
  renderCapabilities();
  renderHost();
  renderRestrictions();
  void loadDoctor().then(renderProviders);
  void loadCapabilities();
  void loadHostIntegrations();
  void loadRestrictions();
  return { container };
};

/** Section header with a re-run action for the capability panel. */
const headerWithRetry = (title, subtitle, onRetry) =>
  sectionHeader(
    title,
    subtitle,
    h(
      "button",
      { class: "ghost-button small", type: "button", onclick: onRetry },
      "Re-check",
    ),
  );

const statTile = (label, value, hint) =>
  h(
    "div",
    { class: "stat" },
    h("span", { class: "eyebrow", text: label }),
    h("strong", { class: "stat-value", text: value }),
    h("span", { class: "faint", text: hint }),
  );
