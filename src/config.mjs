export const DEFAULT_CDP_BASE_URL = "http://127.0.0.1:9222";
export const DEFAULT_FIREFOX_BIDI_WS_URL = "ws://127.0.0.1:9222";
export const DEFAULT_EVENT_BUFFER_SIZE = 200;
export const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
export const DEFAULT_BROWSER_FAMILY = "chromium";
export const CDP_BROWSER_FAMILIES = ["chromium", "edge"];

export function isLoopbackHost(value) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(value);
}

function allowsRemoteEndpoints(env = process.env) {
  return (
    isTruthyFlag(env.MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS) ||
    isTruthyFlag(env.MCP_BROWSER_ALLOW_REMOTE_CDP)
  );
}

export function parsePositiveInteger(value, fallback) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(normalized)) {
    return fallback;
  }

  const parsed = Number.parseInt(normalized, 10);
  return parsed > 0 ? parsed : fallback;
}

export function normalizeBaseUrl(value) {
  const baseUrl = (value || DEFAULT_CDP_BASE_URL).trim();
  return baseUrl.replace(/\/+$/, "");
}

export function normalizeWebSocketUrl(value) {
  const websocketUrl = (value || DEFAULT_FIREFOX_BIDI_WS_URL).trim();
  return websocketUrl.replace(/\/+$/, "");
}

export function isTruthyFlag(value) {
  return value === "1" || value === "true";
}

export function isLoopbackOrigin(value) {
  const url = new URL(value);
  return isLoopbackHost(url.hostname);
}

export function parseBrowserFamily(value) {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "firefox" ||
    normalized === "chromium" ||
    normalized === "edge" ||
    normalized === "auto"
  ) {
    return normalized;
  }

  return DEFAULT_BROWSER_FAMILY;
}

export function loadConfig(env = process.env) {
  const browserFamily = parseBrowserFamily(env.MCP_BROWSER_FAMILY);
  const allowRemoteEndpoints = allowsRemoteEndpoints(env);
  const cdpBaseUrl = normalizeBaseUrl(env.CDP_BASE_URL);
  const firefoxBidiWsUrl = normalizeWebSocketUrl(env.FIREFOX_BIDI_WS_URL);
  const endpointsToValidate =
    browserFamily === "firefox"
      ? [["FIREFOX_BIDI_WS_URL", firefoxBidiWsUrl]]
      : browserFamily === "auto"
        ? [
            ["CDP_BASE_URL", cdpBaseUrl],
            ["FIREFOX_BIDI_WS_URL", firefoxBidiWsUrl],
          ]
        : [["CDP_BASE_URL", cdpBaseUrl]];

  if (!allowRemoteEndpoints) {
    for (const [name, endpoint] of endpointsToValidate) {
      if (!isLoopbackOrigin(endpoint)) {
        throw new Error(
          `${name} must point to a loopback host unless MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1`,
        );
      }
    }
  }

  return {
    browserFamily,
    cdpBaseUrl,
    firefoxBidiWsUrl,
    allowRemoteEndpoints,
    allowRemoteCdp: allowRemoteEndpoints,
    enableEvaluate: isTruthyFlag(env.MCP_BROWSER_ENABLE_EVAL),
    eventBufferSize: parsePositiveInteger(
      env.MCP_BROWSER_EVENT_BUFFER_SIZE,
      DEFAULT_EVENT_BUFFER_SIZE,
    ),
    protocolVersion:
      env.MCP_PROTOCOL_VERSION?.trim() || DEFAULT_PROTOCOL_VERSION,
  };
}
