/**
 * Host-restricted features: ten integrations REA gates on the *host*, not config.
 *
 * REA's `HOST_RESTRICTED_FEATURES` gates 13 advertised tools on ten features:
 * a feature is either supported by this platform/arch or it is not, and on an
 * unsupported host **no environment variable makes it pass** (`createServer`
 * sets `hostUnsupported` from pure `platform`/`arch` predicates). That is a
 * different failure from "you have not configured it", and the two need
 * different fixes: one cannot be fixed here at all, the other needs a path.
 *
 * The workspace reported neither. All 13 tools sat in the catalog as
 * unverified, so a Linux user and a Windows user saw the same thing, and
 * neither learned whether the missing piece was configuration or the machine.
 * Verified live: on this `linux x64` host every gated tool answers with a
 * *configuration* error (`capability_unavailable`, `provider_unavailable`),
 * never `unsupported_host` — so `supported: true` here is not a guess.
 *
 * What this module will not do is claim a supported feature is *available*.
 * Host support is one of several gates; the rest (a configured path, a
 * reachable device, a loaded provider) are not decidable from `platform` and
 * `arch` alone. `supported` therefore means "host does not block it", and the
 * projection says so in those words.
 */

/**
 * @typedef {"packetCapture" | "pcapCapture" | "signalRecording" | "evmInterface"
 *   | "binaryLayout" | "recordedCrash" | "firmwareInspection"
 *   | "firmwareExtraction" | "javascriptRecovery" | "persistentDebugger"} FeatureId
 */

/**
 * A host predicate is a pure function of platform and arch — the same shape as
 * REA's own `*HostSupported` helpers, which take `process.platform`/`arch` and
 * nothing else. Keeping them pure is what makes them testable and honest.
 *
 * @typedef {(platform: string, arch: string) => boolean} HostPredicate
 */

/** Linux only. Mirrors `tsharkHostSupported` and `sigrokHostSupported`. */
const linuxOnly = /** @type {HostPredicate} */ (
  (platform) => platform === "linux"
);

/** Linux x64 only. Mirrors `pwntoolsHostSupported`, `wakaruHostSupported`, `evmHostSupported`. */
const linuxX64 = /** @type {HostPredicate} */ (
  (platform, arch) => platform === "linux" && arch === "x64"
);

/** Linux or Windows. Mirrors `pcapCaptureHostSupported`. */
const linuxOrWindows = /** @type {HostPredicate} */ (
  (platform) => platform === "linux" || platform === "win32"
);

/**
 * The ten features, the tools REA gates on each, and where in the source the
 * rule comes from. `reason` is REA's own explanation, used when the host does
 * not support the feature so the user is not told to configure something that
 * can never work here.
 *
 * @type {ReadonlyArray<{
 *   id: FeatureId,
 *   label: string,
 *   tools: readonly string[],
 *   supported: HostPredicate,
 *   supportedWhen: string,
 *   reason: string,
 *   remediation: string,
 * }>}
 */
export const HOST_RESTRICTED_FEATURES = [
  {
    id: "persistentDebugger",
    label: "Persistent debugger sessions",
    tools: ["start_gdb_session", "start_rizin_debug_session"],
    supported: linuxOnly,
    supportedWhen: "Linux with /proc descriptor readback",
    reason:
      "Persistent debugger sessions need Linux with /proc descriptor readback.",
    remediation:
      "Run persistent debugger sessions on Linux with /proc descriptor readback.",
  },
  {
    id: "javascriptRecovery",
    label: "JavaScript source recovery",
    tools: ["recover_javascript_sources"],
    supported: linuxX64,
    supportedWhen: "Linux x64",
    reason: "Wakaru source recovery is verified on Linux x64 only.",
    remediation:
      "On Linux x64, provide an absolute REA_WAKARU_COMMAND for Wakaru ^1.13.0 and util-linux prlimit.",
  },
  {
    id: "binaryLayout",
    label: "Binary layout decoding",
    tools: ["inspect_binary_layout"],
    supported: linuxX64,
    supportedWhen: "Linux x64",
    reason: "pwntools-backed binary layout is verified on Linux x64 only.",
    remediation:
      "On Linux x64, set absolute REA_PWNTOOLS_PYTHON to caller-supplied Python with pwntools 4.15.0.",
  },
  {
    id: "packetCapture",
    label: "Packet capture inspection",
    tools: ["inspect_packet_capture", "inspect_packet_fields"],
    supported: linuxOnly,
    supportedWhen: "Linux",
    reason:
      "Packet inspection needs enforceable resource bounds, which this host lacks.",
    remediation:
      "On Linux, supply TShark 4.x on PATH or through absolute REA_TSHARK_COMMAND, and util-linux prlimit.",
  },
  {
    id: "signalRecording",
    label: "Signal recording decoding",
    tools: ["decode_signal_recording", "inspect_signal_decoders"],
    supported: linuxOnly,
    supportedWhen: "Linux",
    reason: "Signal decoding is verified on Linux only.",
    remediation:
      "On Linux, supply sigrok-cli 0.7.2 via absolute REA_SIGROK_COMMAND and util-linux prlimit.",
  },
  {
    id: "evmInterface",
    label: "EVM interface inspection",
    tools: ["inspect_evm_interface"],
    supported: linuxX64,
    supportedWhen: "Linux x64",
    reason: "The bundled EVM interface profile is verified on Linux x64 only.",
    remediation:
      "The bundled offline EVM interface profile is currently real-verified on Linux x64.",
  },
  {
    id: "recordedCrash",
    label: "Recorded crash inspection",
    tools: ["inspect_recorded_crash"],
    supported: linuxX64,
    supportedWhen: "Linux x64",
    reason: "pwntools-backed crash inspection is verified on Linux x64 only.",
    remediation:
      "On Linux x64, set absolute REA_PWNTOOLS_PYTHON to caller-supplied Python with pwntools 4.15.0.",
  },
  {
    id: "firmwareInspection",
    label: "Firmware region inspection",
    tools: ["inspect_firmware_regions"],
    supported: linuxOnly,
    supportedWhen: "Linux",
    reason: "Firmware inspection is verified on Linux only.",
    remediation:
      "On Linux, provide an absolute REA_BINWALK_COMMAND or REA_UNBLOB_COMMAND path and util-linux prlimit.",
  },
  {
    id: "firmwareExtraction",
    label: "Firmware extraction",
    tools: ["extract_firmware"],
    supported: linuxOnly,
    supportedWhen: "Linux",
    reason: "Firmware extraction is verified on Linux only.",
    remediation:
      "On Linux, provide an absolute REA_BINWALK_COMMAND or REA_UNBLOB_COMMAND path, util-linux prlimit, and the selected format's extractor.",
  },
  {
    id: "pcapCapture",
    label: "PCAP capture inspection",
    tools: ["inspect_pcap_capture"],
    supported: linuxOrWindows,
    supportedWhen: "Linux with prlimit, or Windows with Job Objects",
    reason:
      "PCAP inspection needs an enforceable native memory bound: Linux with util-linux prlimit, or Windows with owned Job Objects.",
    remediation:
      "Run PCAP inspection on Linux with util-linux prlimit, or on Windows with owned Job Objects.",
  },
];

/** Shown anywhere the projection is rendered. Host support is not availability. */
export const HOST_SUPPORT_IS_NOT_AVAILABILITY =
  "Host support is not availability: it only means this operating system and architecture do not block the integration. A supported feature can still need a configured path or a connected device.";

/**
 * Which tool maps to which feature. Built once so a lookup never scans.
 *
 * @type {ReadonlyMap<string, FeatureId>}
 */
export const FEATURE_FOR_TOOL = new Map(
  HOST_RESTRICTED_FEATURES.flatMap((feature) =>
    feature.tools.map(
      (tool) => /** @type {[string, FeatureId]} */ ([tool, feature.id]),
    ),
  ),
);

/**
 * @typedef {object} FeatureSupport
 * @property {FeatureId} id
 * @property {string} label
 * @property {boolean} supported
 * @property {string} supportedWhen
 * @property {string} reason
 * @property {string} remediation
 * @property {readonly string[]} tools
 */

/**
 * Evaluate every feature against one host.
 *
 * @param {string} platform e.g. `process.platform`
 * @param {string} arch e.g. `process.arch`
 * @returns {FeatureSupport[]}
 */
export const featureSupportFor = (platform, arch) =>
  HOST_RESTRICTED_FEATURES.map((feature) => ({
    id: feature.id,
    label: feature.label,
    supported: feature.supported(platform, arch),
    supportedWhen: feature.supportedWhen,
    reason: feature.reason,
    remediation: feature.remediation,
    tools: feature.tools,
  }));

/**
 * Project host support onto the tools it gates, for the Tools view.
 *
 * A tool whose host is unsupported cannot run, whatever the environment says —
 * that is the strongest claim available from `platform`/`arch` alone, so it is
 * the only one made. Everything else is left to the capability report.
 *
 * @param {FeatureSupport[]} features
 * @returns {Map<string, { supported: boolean, feature: FeatureId, reason: string, remediation: string }>}
 */
export const toolHostSupport = (features) => {
  const byFeature = new Map(features.map((feature) => [feature.id, feature]));
  /** @type {Map<string, { supported: boolean, feature: FeatureId, reason: string, remediation: string }>} */
  const projection = new Map();
  for (const feature of HOST_RESTRICTED_FEATURES) {
    const status = byFeature.get(feature.id);
    if (status === undefined) continue;
    for (const tool of feature.tools)
      projection.set(tool, {
        supported: status.supported,
        feature: feature.id,
        reason: status.reason,
        remediation: status.remediation,
      });
  }
  return projection;
};

/**
 * The sentence above the feature list. Counts both ways so neither is hidden.
 *
 * @param {FeatureSupport[]} features
 * @param {{ platform: string, arch: string }} host
 */
export const hostRestrictionSummary = (features, host) => {
  const blocked = features.filter((feature) => !feature.supported);
  const tools = blocked.reduce((sum, feature) => sum + feature.tools.length, 0);
  const where = `${host.platform} ${host.arch}`;
  if (blocked.length === 0)
    return `All ${features.length} host-restricted integrations are supported on ${where}. Supported here does not mean configured or reachable.`;
  return `${blocked.length} of ${features.length} host-restricted integrations cannot run on ${where}. They gate ${tools} tool${tools === 1 ? "" : "s"}, and no setting changes that — the fix is a different host.`;
};

/**
 * Read a `GET /api/host-restrictions` payload without trusting its shape.
 *
 * @param {unknown} payload
 * @returns {{ host: { platform: string, arch: string } | null, features: FeatureSupport[] }}
 */
export const restrictionsFromPayload = (payload) => {
  if (payload === null || typeof payload !== "object")
    return { host: null, features: [] };
  const value = /** @type {Record<string, any>} */ (payload);
  const host =
    typeof value.host?.platform === "string" &&
    typeof value.host?.arch === "string"
      ? { platform: value.host.platform, arch: value.host.arch }
      : null;
  const features = Array.isArray(value.features)
    ? value.features
        .filter(
          (feature) =>
            typeof feature?.id === "string" &&
            Array.isArray(feature?.tools) &&
            typeof feature?.supported === "boolean",
        )
        .map((feature) => ({
          id: /** @type {FeatureId} */ (feature.id),
          label: typeof feature.label === "string" ? feature.label : feature.id,
          supported: feature.supported,
          supportedWhen:
            typeof feature.supportedWhen === "string"
              ? feature.supportedWhen
              : "",
          reason: typeof feature.reason === "string" ? feature.reason : "",
          remediation:
            typeof feature.remediation === "string" ? feature.remediation : "",
          tools: feature.tools.filter((tool) => typeof tool === "string"),
        }))
    : [];
  return { host, features };
};
