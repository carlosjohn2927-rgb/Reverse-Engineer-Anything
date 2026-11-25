import { api } from "../api.js";
import { errorMessage, h } from "../dom.js";
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

  root.replaceChildren(container);
  renderRuntime();
  renderProviders();
  void loadDoctor().then(renderProviders);
  return { container };
};

const statTile = (label, value, hint) =>
  h(
    "div",
    { class: "stat" },
    h("span", { class: "eyebrow", text: label }),
    h("strong", { class: "stat-value", text: value }),
    h("span", { class: "faint", text: hint }),
  );
