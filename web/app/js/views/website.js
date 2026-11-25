import { api } from "../api.js";
import { errorMessage, h } from "../dom.js";
import { renderResult } from "../render/evidence.js";
import { recordEvidence } from "../store.js";
import { launchTool } from "../runner.js";
import { sectionHeader, toast } from "../ui.js";

/** Guided passive inspection of a website already open in a local CDP browser. */
export const renderWebsiteFlow = () => {
  const panel = h("section", {
    class: "panel website-flow",
    id: "website-flow",
  });
  const siteInput = h("input", {
    id: "website-url",
    type: "url",
    placeholder: "https://example.com",
    autocomplete: "url",
    required: true,
    spellcheck: "false",
  });
  const endpointInput = h("input", {
    id: "website-cdp-endpoint",
    type: "text",
    value: "http://127.0.0.1:9222",
    placeholder: "http://127.0.0.1:9222",
    autocomplete: "off",
    spellcheck: "false",
  });
  const findButton = h(
    "button",
    { class: "primary-button", type: "submit" },
    "Find open page",
  );
  const message = h("p", {
    class: "website-message faint",
    role: "status",
    "aria-live": "polite",
  });
  const discovery = h("div", { class: "website-discovery" });
  const selected = h("div", { class: "website-selected" });
  let origin = null;
  let cdpEndpoint = endpointInput.value;
  let pageTargets = [];
  let selectedTarget = null;
  let cancelRequested = false;
  const pageLimitInput = h("input", {
    id: "website-crawl-page-limit",
    type: "number",
    min: "1",
    max: "25",
    value: "12",
  });
  const depthInput = h("input", {
    id: "website-crawl-depth",
    type: "number",
    min: "0",
    max: "4",
    value: "2",
  });
  const saveCapturedInput = h("input", {
    id: "website-save-captured",
    type: "checkbox",
  });
  const fetchSourceMapsInput = h("input", {
    id: "website-fetch-source-maps",
    type: "checkbox",
  });
  const crawlButton = h(
    "button",
    { class: "primary-button", type: "button", onclick: () => crawlWebsite() },
    "Crawl and analyze site",
  );
  const cancelButton = h(
    "button",
    {
      class: "ghost-button small",
      type: "button",
      hidden: true,
      onclick: () => {
        cancelRequested = true;
      },
    },
    "Stop after current page",
  );
  const crawlStatus = h("p", {
    class: "website-message faint",
    role: "status",
    "aria-live": "polite",
  });
  const crawlReport = h("div", { class: "website-crawl-report" });
  const crawlExport = h("div", { class: "website-crawl-export" });

  panel.append(
    sectionHeader(
      "Inspect a website",
      "Connect to a page already open in Chrome or Chromium",
      h("span", { class: "badge info", text: "Browser connection required" }),
    ),
    h(
      "div",
      { class: "panel-body website-body" },
      h("p", {
        class: "muted website-intro",
        text: "Enter the site address and the browser's local CDP endpoint. REA uses the address to find matching open tabs; it does not open the site itself.",
      }),
      h(
        "form",
        {
          class: "website-form",
          onsubmit: async (event) => {
            event.preventDefault();
            const site = siteInput.value.trim();
            const endpoint = endpointInput.value.trim();
            let parsed;
            try {
              parsed = new URL(site);
            } catch {
              message.textContent =
                "Enter a complete website address, such as https://example.com.";
              return;
            }
            if (
              !["http:", "https:"].includes(parsed.protocol) ||
              parsed.username !== "" ||
              parsed.password !== ""
            ) {
              message.textContent =
                "Use an HTTP or HTTPS address without embedded credentials.";
              return;
            }
            if (endpoint.length === 0) {
              message.textContent =
                "Enter the local CDP endpoint for your browser.";
              return;
            }

            origin = parsed.origin;
            cdpEndpoint = endpoint;
            pageTargets = [];
            selectedTarget = null;
            selected.replaceChildren();
            discovery.replaceChildren();
            findButton.disabled = true;
            findButton.textContent = "Searching…";
            message.textContent = `Looking for an open ${origin} tab…`;
            try {
              const result = await api.callTool("list_browser_targets", {
                cdp_endpoint: cdpEndpoint,
                allowed_origins: [origin],
              });
              recordResult(result);
              if (result.status !== "ok") {
                discovery.replaceChildren(renderResult(result));
                message.textContent =
                  "Could not list browser pages. Check the endpoint and browser setup.";
                return;
              }
              const normalized = result.payload?.normalized_result;
              pageTargets = Array.isArray(normalized?.targets)
                ? normalized.targets
                : [];
              if (pageTargets.length === 0) {
                message.textContent = `No open page matched ${origin}. Open that site in the connected browser, then try again.`;
                return;
              }
              message.textContent = `Found ${pageTargets.length} matching page${pageTargets.length === 1 ? "" : "s"}. Select one to inspect it.`;
              renderPages();
            } catch (error) {
              message.textContent = errorMessage(error);
              toast(
                "Could not find the website tab",
                errorMessage(error),
                "error",
              );
            } finally {
              findButton.disabled = false;
              findButton.textContent = "Find open page";
            }
          },
        },
        h(
          "div",
          { class: "form-field" },
          h(
            "div",
            { class: "form-label" },
            h("label", { for: "website-url", text: "Website address" }),
          ),
          siteInput,
          h("span", {
            class: "field-hint",
            text: "The site must already be open in the connected browser. REA filters to its origin.",
          }),
        ),
        h(
          "div",
          { class: "form-field" },
          h(
            "div",
            { class: "form-label" },
            h("label", {
              for: "website-cdp-endpoint",
              text: "Browser CDP endpoint",
            }),
          ),
          endpointInput,
          h("span", {
            class: "field-hint",
            text: "Default: http://127.0.0.1:9222. The browser must be on the same computer as the REA server and launched with remote debugging enabled. In a hosted preview, 127.0.0.1 means the preview server, not your computer.",
          }),
        ),
        h("div", { class: "row" }, findButton),
      ),
      h(
        "div",
        { class: "notice website-safety" },
        h("strong", { text: "Use a dedicated browser profile" }),
        h("p", {
          class: "muted",
          text: "CDP can access the connected browser profile. A site crawl actively navigates the selected tab through same-origin links and leaves it on the last visited page. It does not click controls or submit forms, but normal page-load requests can still have effects. Use a dedicated profile and crawl only sites you are authorized to inspect.",
        }),
      ),
      message,
      discovery,
      selected,
    ),
  );

  async function crawlWebsite() {
    if (selectedTarget === null || origin === null) return;
    const maxPages = Number(pageLimitInput.value);
    const maxDepth = Number(depthInput.value);
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 25) {
      crawlStatus.textContent =
        "Maximum pages must be a whole number from 1 to 25.";
      return;
    }
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 4) {
      crawlStatus.textContent =
        "Link depth must be a whole number from 0 to 4.";
      return;
    }

    const startUrl = normalizeCrawlUrl(
      siteInput.value.trim(),
      selectedTarget.url,
      origin,
      true,
    );
    if (startUrl === null) {
      crawlStatus.textContent =
        "The selected page is not on the requested website origin.";
      return;
    }

    cancelRequested = false;
    crawlButton.disabled = true;
    cancelButton.hidden = false;
    crawlReport.replaceChildren();
    crawlExport.replaceChildren();
    const saveCaptured = saveCapturedInput.checked;
    const fetchSourceMaps = fetchSourceMapsInput.checked;
    crawlStatus.textContent = "Starting the bounded same-origin crawl…";
    const queue = [{ url: startUrl, depth: 0 }];
    const queued = new Set([crawlKey(startUrl)]);
    const visited = new Set();
    const rows = [];
    const savedPages = [];
    let currentUrl = selectedTarget.url;
    const callForPage = (tool, args, label) =>
      api.callTool(tool, args, {
        onProgress: (progress) => {
          crawlStatus.textContent = `${label} · ${progress.message}`;
        },
      });

    try {
      while (queue.length > 0 && rows.length < maxPages && !cancelRequested) {
        const current = queue.shift();
        if (current === undefined) break;
        const key = crawlKey(current.url);
        if (visited.has(key)) continue;
        visited.add(key);
        crawlStatus.textContent = `Visiting page ${String(rows.length + 1)} of ${String(maxPages)} · depth ${String(current.depth)} · ${current.url}`;

        try {
          if (current.url !== currentUrl) {
            const navigation = await callForPage(
              "capture_browser_scenario",
              {
                browser: {
                  mode: "connect",
                  cdp_endpoint: cdpEndpoint,
                  target_id: selectedTarget.target_id,
                },
                start_url: { url: current.url, query: [] },
                actions: [
                  {
                    step_id: "settle-page",
                    action: "wait_for_timeout",
                    duration_ms: 500,
                  },
                ],
                capture: {
                  after_each_step: [],
                  at_end: ["url"],
                  events: [],
                  network: {
                    request_body: false,
                    response_body: false,
                    header_values: false,
                  },
                },
                detail: "complete",
              },
              `Navigating to ${current.url}`,
            );
            if (navigation.status !== "ok") {
              rows.push({ url: current.url, status: "navigation failed" });
              continue;
            }
            currentUrl = current.url;
          }

          const page = await callForPage(
            "inspect_web_page",
            {
              cdp_endpoint: cdpEndpoint,
              target_id: selectedTarget.target_id,
              allowed_origins: [origin],
              include_script_sources: true,
            },
            `Inspecting ${current.url} and capturing scripts`,
          );
          if (page.status !== "ok") {
            rows.push({ url: current.url, status: "page inspection failed" });
            continue;
          }
          const pageFacts = page.payload?.normalized_result;
          const actualUrl = pageFacts?.target?.url;
          let actualOrigin;
          try {
            actualOrigin = new URL(actualUrl).origin;
          } catch {
            actualOrigin = null;
          }
          if (actualOrigin !== origin) {
            rows.push({
              url: current.url,
              status: "redirect left website origin",
            });
            continue;
          }
          currentUrl = actualUrl;
          const capturedScripts = Array.isArray(pageFacts?.scripts?.items)
            ? pageFacts.scripts.items
                .filter(
                  (script) =>
                    script.source?.included === true &&
                    typeof script.source.artifact?.text === "string" &&
                    isSameOriginHttpUrl(script.url, origin),
                )
                .map((script) => ({
                  url: script.url,
                  scriptKey: script.script_key,
                  artifact: script.source.artifact,
                }))
            : [];

          const savedPage = {
            url: actualUrl,
            scripts: capturedScripts,
            sourceMaps: [],
            sourceMapCoverage: null,
          };
          savedPages.push(savedPage);
          const analysis = await callForPage(
            "analyze_web_bundle",
            {
              cdp_endpoint: cdpEndpoint,
              target_id: selectedTarget.target_id,
              allowed_origins: [origin],
              include_script_sources: true,
              fetch_source_maps: fetchSourceMaps,
              detail: "complete",
            },
            `Analyzing ${current.url}`,
          );
          recordResult(analysis);
          const analysisFacts = analysis.payload?.normalized_result;
          const sourceMaps = analysisFacts?.source_maps;
          if (sourceMaps !== undefined && sourceMaps !== null) {
            savedPage.sourceMapCoverage = {
              status: sourceMaps.status,
              requested: sourceMaps.requested,
              processed: sourceMaps.processed,
              limitation: sourceMaps.limitation ?? null,
            };
            if (Array.isArray(sourceMaps.items))
              for (const item of sourceMaps.items) {
                if (
                  ["included", "partial"].includes(item.status) &&
                  typeof item.artifact?.text === "string" &&
                  isSameOriginHttpUrl(
                    item.effective_url ?? item.declared_url,
                    origin,
                  )
                )
                  savedPage.sourceMaps.push({
                    url: item.effective_url ?? item.declared_url,
                    scriptKey: item.script_key,
                    status: item.status,
                    artifact: item.artifact,
                  });
              }
          }
          const capture = analysisFacts?.capture;
          rows.push({
            url: actualUrl,
            status: analysis.status === "ok" ? "analyzed" : "analysis failed",
            scripts:
              capture === undefined
                ? null
                : `${String(capture.scripts_analyzed)} / ${String(capture.scripts_observed)} scripts`,
            evidenceId: analysis.payload?.evidence_id,
          });

          if (current.depth < maxDepth) {
            const links =
              pageFacts?.metadata?.dom_urls ??
              pageFacts?.safe_metadata?.dom_urls;
            if (Array.isArray(links))
              for (const link of links) {
                if (
                  link.attribute !== "href" ||
                  link.destination_scope !== "approved" ||
                  typeof link.url !== "string"
                )
                  continue;
                const destination = normalizeCrawlUrl(
                  link.url,
                  actualUrl,
                  origin,
                  false,
                );
                if (destination === null) continue;
                const destinationKey = crawlKey(destination);
                if (visited.has(destinationKey) || queued.has(destinationKey))
                  continue;
                queued.add(destinationKey);
                queue.push({ url: destination, depth: current.depth + 1 });
              }
          }
        } catch (error) {
          rows.push({
            url: current.url,
            status: `failed · ${errorMessage(error)}`,
          });
        }
        renderCrawlReport(rows, maxPages, queue.length, cancelRequested);
      }
      const stopped = cancelRequested;
      const budgetReached = rows.length >= maxPages && queue.length > 0;
      let exportOutcome = null;
      if (saveCaptured) {
        crawlStatus.textContent =
          "Saving captured client-side scripts and available source maps to the session workspace…";
        exportOutcome = await persistCrawlArtifacts(savedPages);
        renderCrawlExport(exportOutcome);
      } else {
        crawlExport.replaceChildren(
          h("p", {
            class: "field-hint",
            text: "Capture saving was turned off. Analysis results remain available in the Evidence panel.",
          }),
        );
      }
      const crawlSummary = stopped
        ? `Stopped after ${String(rows.length)} page${rows.length === 1 ? "" : "s"}.`
        : budgetReached
          ? `Page limit reached: analyzed ${String(rows.length)} of up to ${String(maxPages)} pages. More same-origin links remain.`
          : `Finished: visited ${String(rows.length)} page${rows.length === 1 ? "" : "s"}; link depth limit ${String(maxDepth)}.`;
      renderCrawlReport(rows, maxPages, queue.length, stopped);
      const exportNote =
        exportOutcome === null
          ? ""
          : exportOutcome.assetCount > 0
            ? exportOutcome.manifestFile === null
              ? ` Saved ${String(exportOutcome.assetCount)} client-side source file${exportOutcome.assetCount === 1 ? "" : "s"}; the manifest could not be saved.`
              : ` Saved ${String(exportOutcome.assetCount)} client-side source file${exportOutcome.assetCount === 1 ? "" : "s"} plus a manifest to the session workspace.`
            : exportOutcome.manifestFile === null
              ? " No client-side source artifacts were available and the manifest could not be saved."
              : " No client-side source artifacts were available; a crawl manifest was saved.";
      crawlStatus.textContent = `${crawlSummary}${exportNote}`;
    } finally {
      crawlButton.disabled = false;
      cancelButton.hidden = true;
      cancelRequested = false;
    }
  }

  async function downloadWorkspaceArtifact(file, button) {
    button.disabled = true;
    try {
      const blob = await api.downloadWorkspaceFile(file.name);
      const objectUrl = URL.createObjectURL(blob);
      const link = h("a", {
        href: objectUrl,
        download: file.name,
        hidden: true,
      });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
      toast("Could not download crawl file", errorMessage(error), "error");
    } finally {
      button.disabled = false;
    }
  }

  function renderCrawlExport(outcome) {
    const savedList = h(
      "ul",
      { class: "website-export-files" },
      ...outcome.saved.map((file) => {
        const downloadButton = h(
          "button",
          {
            class: "ghost-button small website-export-download",
            type: "button",
            onclick: () => downloadWorkspaceArtifact(file, downloadButton),
          },
          "Download",
        );
        return h(
          "li",
          {},
          h("span", { class: "mono", text: file.name }),
          downloadButton,
        );
      }),
    );
    crawlExport.replaceChildren(
      h("strong", {
        text:
          outcome.assetCount > 0
            ? `Saved ${String(outcome.assetCount)} client-side source file${outcome.assetCount === 1 ? "" : "s"}${outcome.manifestFile === null ? "; the manifest could not be saved" : " plus the manifest to the session workspace"}`
            : outcome.manifestFile === null
              ? "No client-side source artifacts were available, and the crawl manifest could not be saved"
              : "No client-side source artifacts were available; saved the crawl manifest to the session workspace",
      }),
      outcome.saved.length > 0 ? savedList : null,
      outcome.skipped.length > 0
        ? h("p", {
            class: "field-hint",
            text: `${String(outcome.skipped.length)} item${outcome.skipped.length === 1 ? " was" : "s were"} skipped (for example, too large for the workspace transfer).`,
          })
        : null,
      outcome.errors.length > 0
        ? h("p", {
            class: "field-hint error-text",
            text: `Some files could not be saved: ${outcome.errors.join("; ")}`,
          })
        : null,
      h("p", {
        class: "field-hint",
        text: "The manifest lists saved files and source-map coverage. Source maps are optional; server-side code is not captured.",
      }),
    );
  }

  function renderCrawlReport(rows, maxPages, queuedCount, stopped) {
    crawlReport.replaceChildren(
      rows.length === 0
        ? null
        : h(
            "div",
            { class: "website-crawl-table" },
            h(
              "div",
              { class: "website-crawl-row website-crawl-head" },
              h("strong", { text: "Page" }),
              h("strong", { text: "Result" }),
              h("strong", { text: "Coverage" }),
            ),
            ...rows.map((row) =>
              h(
                "div",
                { class: "website-crawl-row" },
                h("span", { class: "mono", text: row.url }),
                h("span", {
                  class: `badge ${row.status === "analyzed" ? "ok" : "warn"}`,
                  text: row.status,
                }),
                h("span", {
                  class: "faint",
                  text: row.scripts ?? row.evidenceId ?? "—",
                }),
              ),
            ),
          ),
      queuedCount > 0 && rows.length >= maxPages && !stopped
        ? h("p", {
            class: "field-hint",
            text: `${String(queuedCount)} additional same-origin link${queuedCount === 1 ? "" : "s"} remained when the page cap was reached.`,
          })
        : null,
    );
  }

  function renderPages() {
    const list = h(
      "div",
      { class: "website-page-list" },
      ...pageTargets.map((target) => {
        const active = selectedTarget?.target_id === target.target_id;
        return h(
          "button",
          {
            class: `website-page ${active ? "selected" : ""}`,
            type: "button",
            onclick: () => {
              selectedTarget = target;
              renderPages();
              renderSelectedPage();
            },
          },
          h("strong", { text: target.title || target.url }),
          h("span", { class: "mono faint", text: target.url }),
          h("span", {
            class: `badge ${target.attached === true ? "warn" : "ok"}`,
            text: target.attached === true ? "debugger attached" : "page tab",
          }),
        );
      }),
    );
    discovery.replaceChildren(list);
  }

  function renderSelectedPage() {
    if (selectedTarget === null) {
      selected.replaceChildren();
      return;
    }
    selected.replaceChildren(
      h(
        "div",
        { class: "website-selected-head" },
        h(
          "div",
          {},
          h("p", { class: "eyebrow", text: "Selected page" }),
          h("strong", { text: selectedTarget.title || selectedTarget.url }),
          h("p", { class: "mono faint", text: selectedTarget.url }),
        ),
      ),
      h(
        "div",
        { class: "row website-actions" },
        h(
          "button",
          {
            class: "primary-button",
            type: "button",
            onclick: () =>
              launchTool("inspect_web_page", {
                cdp_endpoint: cdpEndpoint,
                target_id: selectedTarget.target_id,
                allowed_origins: [origin],
                include_script_sources: false,
              }),
          },
          "Inspect page",
        ),
        h(
          "button",
          {
            class: "ghost-button",
            type: "button",
            onclick: () =>
              launchTool("analyze_web_bundle", {
                cdp_endpoint: cdpEndpoint,
                target_id: selectedTarget.target_id,
                allowed_origins: [origin],
                include_script_sources: true,
                fetch_source_maps: false,
                detail: "complete",
              }),
          },
          "Analyze website code",
        ),
      ),
      h(
        "div",
        { class: "website-crawl-controls" },
        h("p", { class: "eyebrow", text: "Bounded full-site crawl" }),
        h("p", {
          class: "field-hint",
          text: "Visits same-origin links only, breadth-first. Query-string variants are skipped. Set a page and link-depth budget; routes behind interactions or sign-in may need manual coverage.",
        }),
        h(
          "div",
          { class: "website-crawl-fields" },
          h(
            "div",
            { class: "form-field" },
            h("label", {
              for: "website-crawl-page-limit",
              text: "Maximum pages",
            }),
            pageLimitInput,
          ),
          h(
            "div",
            { class: "form-field" },
            h("label", {
              for: "website-crawl-depth",
              text: "Maximum link depth",
            }),
            depthInput,
          ),
        ),
        h(
          "label",
          { class: "website-capture-option" },
          saveCapturedInput,
          h("span", {
            text: "Save captured client-side scripts and available source maps to the session workspace",
          }),
        ),
        h(
          "label",
          { class: "website-capture-option" },
          fetchSourceMapsInput,
          h("span", {
            text: "Fetch declared source maps (optional; same-origin only)",
          }),
        ),
        h("p", {
          class: "field-hint website-capture-note",
          text: "Source maps may not be published or accessible. Only browser-visible client-side code is captured; server-side code is not included.",
        }),
        h("div", { class: "row website-actions" }, crawlButton, cancelButton),
        crawlStatus,
        crawlReport,
        crawlExport,
      ),
      h("p", {
        class: "field-hint pad-top",
        text: "Page inspection observes structure and accessibility. Bundle analysis parses captured scripts for routes and API candidates without executing them.",
      }),
    );
  }

  return panel;
};

const persistCrawlArtifacts = async (pages) => {
  const stamp = new Date()
    .toISOString()
    .replaceAll(/[^0-9]/gu, "")
    .slice(0, 17);
  const saved = [];
  const skipped = [];
  const errors = [];
  const manifest = {
    format: "rea-website-crawl-capture-v1",
    created_at: new Date().toISOString(),
    scope:
      "browser-visible client-side source only; server-side code is not captured",
    pages: [],
  };
  const maxJsonBytes = 7 * 1024 * 1024;
  const writeArtifact = async (name, text) => {
    const jsonBytes = new TextEncoder().encode(
      JSON.stringify({ name, text }),
    ).byteLength;
    if (jsonBytes > maxJsonBytes) {
      skipped.push(name);
      return null;
    }
    try {
      const result = await api.writeText(name, text);
      const file = { name, path: result.path, bytes: result.bytes };
      saved.push(file);
      return file;
    } catch (error) {
      errors.push(`${name}: ${errorMessage(error)}`);
      return null;
    }
  };

  for (const [pageIndex, page] of pages.entries()) {
    const pageManifest = {
      url: stripUrlQuery(page.url),
      scripts: [],
      source_maps: [],
      source_map_coverage: page.sourceMapCoverage,
    };
    for (const [scriptIndex, script] of page.scripts.entries()) {
      if (typeof script.artifact?.text !== "string") continue;
      const name = `website-crawl-${stamp}-page-${String(pageIndex + 1).padStart(2, "0")}-script-${String(scriptIndex + 1).padStart(3, "0")}.js`;
      const file = await writeArtifact(name, script.artifact.text);
      if (file !== null)
        pageManifest.scripts.push({
          name,
          url: stripUrlQuery(script.url),
          script_key: script.scriptKey,
          bytes: script.artifact.bytes,
          sha256: script.artifact.sha256,
        });
    }
    for (const [mapIndex, sourceMap] of page.sourceMaps.entries()) {
      if (typeof sourceMap.artifact?.text !== "string") continue;
      const name = `website-crawl-${stamp}-page-${String(pageIndex + 1).padStart(2, "0")}-sourcemap-${String(mapIndex + 1).padStart(3, "0")}.map.json`;
      const file = await writeArtifact(name, sourceMap.artifact.text);
      if (file !== null)
        pageManifest.source_maps.push({
          name,
          url: stripUrlQuery(sourceMap.url),
          script_key: sourceMap.scriptKey,
          status: sourceMap.status,
          bytes: sourceMap.artifact.bytes,
          sha256: sourceMap.artifact.sha256,
        });
    }
    manifest.pages.push(pageManifest);
  }

  const assetCount = saved.length;
  const manifestName = `website-crawl-${stamp}-manifest.json`;
  const manifestFile = await writeArtifact(
    manifestName,
    JSON.stringify(manifest, null, 2),
  );
  return { saved, skipped, errors, manifestFile, assetCount };
};

const isSameOriginHttpUrl = (value, expectedOrigin) => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.origin === expectedOrigin &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
};

const stripUrlQuery = (value) => {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[unavailable]";
  }
};

const crawlKey = (value) => {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
};

/** Keep only navigable same-origin HTML-style href candidates. */
const normalizeCrawlUrl = (value, base, origin, keepQuery) => {
  let url;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.origin !== origin || url.username !== "" || url.password !== "")
    return null;
  if (!keepQuery) url.search = "";
  url.hash = "";
  if (
    /\.(?:css|js|mjs|map|json|xml|pdf|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|mp[34]|zip|gz|wasm)$/iu.test(
      url.pathname,
    )
  )
    return null;
  return url.toString();
};

const recordResult = (result) => {
  const envelope =
    result.payload?.evidence_id === undefined ? null : result.payload;
  if (envelope?.evidence_id !== undefined)
    recordEvidence({
      tool: result.tool,
      status: result.status,
      payload: result.payload,
      durationMs: result.durationMs,
      subject: envelope?.subject?.name,
      evidenceId: envelope.evidence_id,
    });
};
