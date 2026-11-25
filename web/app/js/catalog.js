/**
 * Tool catalog knowledge: families, artifact-aware presets and argument
 * mapping. Everything here is derived from the tool contracts REA advertises
 * (input schemas) plus artifact extensions, never from a hardcoded list of
 * which tools "should" work.
 */

/** Display order and copy for tool families. */
export const FAMILIES = [
  {
    id: "artifacts",
    label: "Files & artifacts",
    blurb: "Inventory, headers and container facts for any local file.",
    test: (name) =>
      /^inspect_(artifact|binary_layout|byte_entropy|native_exports|elf_notes|pe_|go_binary|rust_binary|model_artifact|gpu_code_objects|erlang_beam|python_pyc|il2cpp_metadata|managed_|apk_signature|sqlite_database|evm_interface|wasm_artifact)/u.test(
        name,
      ) ||
      /^(extract_artifact|compare_managed_members|decode_interface_builder|inspect_keyed_archive|inspect_devicetree|inspect_kernel_module|inspect_apple_ips)$/u.test(
        name,
      ),
  },
  {
    id: "applications",
    label: "Applications",
    blurb: "Reconstruct JavaScript, Electron, .NET, Flutter and Android apps.",
    test: (name) =>
      /^(analyze_javascript_application|inspect_desktop_application|identify_flutter_build|inspect_dart_aot|inspect_electron_fuses|inspect_android_package|inspect_apktool_client|decode_android_resources|analyze_web_bundle|project_.*_graph|trace_application_feature|compare_application_versions|recover_javascript_sources)$/u.test(
        name,
      ),
  },
  {
    id: "native",
    label: "Native analysis",
    blurb: "Pseudocode, assembly, xrefs and call paths through a decompiler.",
    test: (name) =>
      /^(open_binary|close_binary|binary_session|binary_overview|analyze_function|decompile_all|batch_decompile|procedure_|list_procedures|search_procedures|search_strings|list_strings|list_segments|list_documents|read_bytes|read_function|xrefs|get_call_graph|resolve_|address_|trace_feature|trace_call_path|trace_native|inspect_native_(instruction|data_type|load_image|api|dispatch)|annotate_native_function|get_objc|inspect_macho|demangle_swift|search_bytes|current_|goto_address|next_address|prev_address|set_|unset_|list_names|list_bookmarks|comment|inline_comment|address_name|procedure_address|inspect_analysis_view|inspect_analysis_settings|update_analysis_settings|compare_functions|match_native_functions|build_call_path|correlate_static|verify_reconstruction|list_unknowns|record_unknown|update_unknown|verify_unknown|get_navigation_context|inspect_address_context|find_changed_behavior|inspect_with_objdump|execute_rizin_command|compare_bundles)$/u.test(
        name,
      ),
  },
  {
    id: "runtime",
    label: "Runtime & capture",
    blurb: "Observe processes, browser pages, captures and devices.",
    test: (name) =>
      /^(capture_|observe_|list_browser_targets|inspect_web_page|inspect_web_network_capture|inspect_web_event_listeners|observe_web_execution|trace_web_|discover_webmcp_tools|export_web_scripts|compare_web_|compare_process|inspect_pcap|inspect_packet|decode_signal|inspect_signal|inspect_recorded_crash|list_frida|start_frida|load_frida|resume_frida|unload_frida|frida_session|close_frida|instrument_with_frida|list_adb|pull_adb|push_adb|read_adb|inspect_adb|install_adb|uninstall_adb|start_adb|stop_adb|collect_adb|resolve_adb|list_cutter|cutter_command|.*_gdb.*|.*_rizin_debug.*|inspect_dart_aot)/u.test(
        name,
      ),
  },
  {
    id: "evidence",
    label: "Evidence & sessions",
    blurb: "Export, import and compare the records behind each result.",
    test: (name) =>
      /^(get_evidence_bundle|export_evidence_bundle|import_evidence_bundle|evidence_|compare|environment_|build_reconstruction|evaluate_reconstruction|import_managed|import_reference|open_bundle|list_documents|binary_session)$/u.test(
        name,
      ),
  },
  {
    id: "guidance",
    label: "Guidance",
    blurb: "REA's own workflow instructions for a given investigation.",
    test: (name) =>
      /^(search_guidance|read_guidance_section|guided_workflows)$/u.test(name),
  },
  {
    id: "firmware",
    label: "Firmware & embedded",
    blurb: "Regions, extraction and handoffs for device images.",
    test: (name) => /^(inspect_firmware_regions|extract_firmware)$/u.test(name),
  },
];

export const familyOf = (toolName) =>
  FAMILIES.find((family) => family.test(toolName))?.id ?? "other";

/** Artifact kinds the workspace can recognise from an extension. */
export const ARTIFACT_KINDS = [
  {
    id: "elf",
    label: "ELF binary",
    extensions: [".elf", ".so", ".o", ".ko", ".bin"],
    icon: "elf",
  },
  {
    id: "dotnet",
    label: ".NET assembly",
    extensions: [".dll", ".exe"],
    icon: "dotnet",
  },
  {
    id: "pe",
    label: "PE binary",
    extensions: [".exe", ".dll", ".sys", ".mui"],
    icon: "pe",
  },
  {
    id: "apk",
    label: "Android app",
    extensions: [".apk", ".apks", ".aab", ".xapk"],
    icon: "android",
  },
  {
    id: "js",
    label: "JavaScript / Electron",
    extensions: [".asar", ".js"],
    icon: "js",
  },
  {
    id: "wasm",
    label: "WebAssembly",
    extensions: [".wasm", ".wat"],
    icon: "wasm",
  },
  {
    id: "sqlite",
    label: "SQLite database",
    extensions: [".db", ".sqlite", ".sqlite3"],
    icon: "db",
  },
  {
    id: "archive",
    label: "Archive / package",
    extensions: [
      ".zip",
      ".tar",
      ".gz",
      ".7z",
      ".pkg",
      ".dmg",
      ".deb",
      ".whl",
      ".nupkg",
      ".ipa",
    ],
    icon: "archive",
  },
  {
    id: "model",
    label: "Model artifact",
    extensions: [".gguf", ".safetensors", ".onnx", ".pt", ".bin"],
    icon: "model",
  },
  {
    id: "gpu",
    label: "GPU code object",
    extensions: [".cubin", ".ptx", ".fatbin"],
    icon: "gpu",
  },
  {
    id: "evm",
    label: "EVM bytecode",
    extensions: [".evm", ".hex"],
    icon: "evm",
  },
  {
    id: "pcap",
    label: "Packet capture",
    extensions: [".pcap", ".pcapng", ".saz", ".har"],
    icon: "network",
  },
  {
    id: "firmware",
    label: "Firmware image",
    extensions: [".img", ".fw", ".itb", ".dtb", ".dtbo"],
    icon: "chip",
  },
];

const FILE_KIND = { id: "file", label: "File", icon: "file", extensions: [] };

/**
 * Every artifact kind an extension could denote, most specific first. ".dll"
 * is a PE container that may or may not carry .NET metadata, so both apply.
 */
/** @returns {typeof ARTIFACT_KINDS} */
export const kindsForPath = (path) => {
  const lower = String(path ?? "").toLowerCase();
  const matches = ARTIFACT_KINDS.filter((kind) =>
    kind.extensions.some((extension) => lower.endsWith(extension)),
  );
  return matches.length === 0 ? [FILE_KIND] : matches;
};

/** @returns {(typeof ARTIFACT_KINDS)[number]} */
export const kindForPath = (path) => {
  const [first] = kindsForPath(path);
  return first ?? FILE_KIND;
};

/**
 * Tools that accept a filesystem path plus the JSON key that carries it,
 * discovered from each tool's advertised input schema.
 */
export const pathKeyOf = (tool) => {
  const properties = tool.inputSchema?.properties ?? {};
  for (const key of ["path", "input_path", "inputPath"]) {
    if (properties[key] !== undefined && properties[key].type === "string")
      return key;
  }
  return null;
};

/** Suggested tools per artifact kind, ordered by usefulness. */
export const PRESETS = {
  elf: [
    "inspect_artifact",
    "inspect_go_binary",
    "inspect_native_exports",
    "inspect_elf_notes",
    "inspect_rust_binary",
    "inspect_byte_entropy",
    "inspect_kernel_module",
    "inspect_pe_imports",
  ],
  pe: [
    "inspect_artifact",
    "inspect_native_exports",
    "inspect_pe_imports",
    "inspect_pe_resources",
    "inspect_pe_certificates",
    "inspect_pe_load_config",
    "inspect_byte_entropy",
  ],
  dotnet: [
    "inspect_managed_artifact",
    "inspect_managed_members",
    "inspect_managed_native_boundaries",
    "inspect_artifact",
  ],
  apk: [
    "inspect_android_package",
    "inspect_apk_signature",
    "identify_flutter_build",
    "inspect_artifact",
    "inspect_managed_artifact",
  ],
  js: [
    "analyze_javascript_application",
    "inspect_electron_fuses",
    "inspect_artifact",
  ],
  wasm: [
    "inspect_wasm_artifact",
    "compare_wasm_interfaces",
    "inspect_artifact",
  ],
  sqlite: ["inspect_sqlite_database", "inspect_artifact"],
  archive: ["extract_artifact", "inspect_artifact", "compare_artifacts"],
  model: ["inspect_model_artifact", "inspect_artifact"],
  gpu: ["inspect_gpu_code_objects", "inspect_artifact"],
  evm: ["inspect_evm_interface", "inspect_artifact"],
  pcap: [
    "inspect_pcap_capture",
    "inspect_pcap_client",
    "inspect_web_network_capture",
  ],
  firmware: [
    "inspect_firmware_regions",
    "extract_firmware",
    "inspect_devicetree",
  ],
  file: ["inspect_artifact", "inspect_byte_entropy"],
};

/** Human explanation of what a preset run answers. */
export const PRESET_COPY = {
  inspect_artifact: "Inventory identity, digest and container structure",
  inspect_go_binary: "Read embedded Go build info, modules and settings",
  inspect_native_exports: "List exported symbols and versions",
  inspect_elf_notes: "Read ELF note owners and GNU build ids",
  inspect_rust_binary: "Read cargo-auditable crates and dependency edges",
  inspect_byte_entropy:
    "Chart block entropy to find packed or encrypted regions",
  inspect_kernel_module: "Read module info, CRCs and signature trailer",
  inspect_pe_imports: "List imported DLLs, ordinals and imphash",
  inspect_pe_resources: "Inventory PE resources",
  inspect_pe_certificates: "Read Authenticode signers and certificate fields",
  inspect_pe_load_config: "Read PE load-config security fields",
  inspect_managed_artifact:
    "Read .NET metadata, assembly identity and references",
  inspect_managed_members: "Inventory managed types, methods and signatures",
  inspect_managed_native_boundaries: "Map managed-to-native transitions",
  inspect_android_package: "Read manifest, components and permissions",
  inspect_apk_signature: "Verify v1/v2/v3 signers and certificate fingerprints",
  identify_flutter_build: "Identify the Dart snapshot and engine build",
  analyze_javascript_application: "Reconstruct the JS/Electron module graph",
  inspect_electron_fuses: "Read Electron fuse states",
  inspect_wasm_artifact: "Validate WASM sections and decode imports/exports",
  compare_wasm_interfaces: "Compare two WASM interfaces",
  inspect_sqlite_database: "Read tables, indexes, views and sample rows",
  extract_artifact: "Extract supported container contents",
  compare_artifacts: "Compare two artifact inventories",
  inspect_model_artifact: "Read GGUF / safetensors tensor declarations",
  inspect_gpu_code_objects: "Read CUDA/HIP targets and retained PTX",
  inspect_evm_interface: "Decode EVM dispatch selectors and mutability",
  inspect_pcap_capture: "Summarise endpoints, DNS, TLS and HTTP",
  inspect_pcap_client: "Inspect the pcap client and its requirements",
  inspect_firmware_regions: "Find regions and extraction handoffs",
  extract_firmware: "Extract selected firmware bytes with provenance",
  inspect_devicetree: "Decode a device tree blob",
  inspect_web_network_capture: "Inspect a saved HAR or SAZ capture",
};
