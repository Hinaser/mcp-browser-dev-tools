// Every model turn pays for the definitions of every tool the server
// offers, so by default it offers the core set, the tools page work needs.
// MCP_BROWSER_TOOLS adds groups or single tools (comma-separated), or all.
export const TOOL_GROUPS = {
  core: [
    "ensure_browser",
    "list_tabs",
    "new_tab",
    "close_tab",
    "attach_tab",
    "navigate",
    "reload",
    "click",
    "hover",
    "type",
    "select",
    "press_key",
    "scroll",
    "upload_file",
    "wait_for",
    "run_steps",
    "run_tabs",
    "get_snapshot",
    "read_text",
    "inspect_element",
    "take_screenshot",
    "evaluate_js",
    "get_console_messages",
    "get_network_requests",
  ],
  input: ["drag", "set_viewport"],
  network: ["set_network", "get_har", "get_events"],
  state: [
    "get_cookies",
    "get_storage",
    "capture_session_snapshot",
    "restore_session_snapshot",
    "capture_debug_report",
    "get_page_state",
    "get_document",
  ],
  compare: ["compare_page_state", "compare_selector"],
  browser: ["browser_status", "launch_browser", "list_sessions", "detach_tab"],
};

// The tool names MCP_BROWSER_TOOLS enables, or null for all. The core set
// is always included, so naming a group adds to it. A name that is neither
// a group nor a tool fails at startup rather than leaving a tool missing.
export function parseToolSet(value) {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const known = new Set(Object.values(TOOL_GROUPS).flat());
  const names = new Set(TOOL_GROUPS.core);
  for (const entry of entries) {
    if (entry === "all") {
      Object.values(TOOL_GROUPS)
        .flat()
        .forEach((name) => names.add(name));
    } else if (TOOL_GROUPS[entry]) {
      TOOL_GROUPS[entry].forEach((name) => names.add(name));
    } else if (known.has(entry)) {
      names.add(entry);
    } else {
      throw new Error(
        `MCP_BROWSER_TOOLS has an unknown group or tool: ${entry}. Groups: all, ${Object.keys(TOOL_GROUPS).join(", ")}`,
      );
    }
  }
  return entries.includes("all") ? null : names;
}
