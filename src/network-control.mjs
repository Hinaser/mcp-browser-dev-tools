// set_network: block or mock requests by URL glob, add request headers,
// and emulate offline or slow networks. The state lives on the session; a
// call replaces the fields it gives and keeps the rest.

// The glob syntax of CDP's Fetch patterns, so a rule matches the same URLs
// on both browsers: * is any run of characters, ? exactly one, and a
// backslash escapes the next character.
export function globToRegExp(glob) {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "\\" && index + 1 < glob.length) {
      index += 1;
      source += glob[index].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "s");
}

// Runs fn after the session's earlier network calls, so overlapping calls
// (and a detach) apply one at a time in the order they came.
export async function inNetworkTurn(session, fn) {
  const previous = session.networkTurn ?? Promise.resolve();
  let finished;
  session.networkTurn = new Promise((resolve) => {
    finished = resolve;
  });
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    finished();
  }
}

export function emptyNetworkState() {
  return {
    rules: [],
    headers: {},
    offline: false,
    latencyMs: 0,
    downloadKbps: null,
    uploadKbps: null,
  };
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// Browsers reject a request or response with a malformed header, which
// would leave a paused request unanswered, so headers are checked first.
function checkHeaders(headers, where) {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!HEADER_NAME.test(name)) {
      throw new Error(`${where} has an invalid header name: ${name}`);
    }
    if (/[\r\n\0]/.test(String(value))) {
      throw new Error(`${where} header ${name} has a line break in its value`);
    }
  }
}

// The state after a set_network call: reset starts from nothing, and each
// field given replaces the one before. Rule hit counts start at zero.
export function applyNetworkOptions(current, options) {
  checkHeaders(options.headers, "headers");
  for (const [index, rule] of (options.rules ?? []).entries()) {
    checkHeaders(rule.headers, `rules[${index}]`);
    if (rule.contentType !== undefined) {
      checkHeaders({ "content-type": rule.contentType }, `rules[${index}]`);
    }
  }
  const state = options.reset
    ? emptyNetworkState()
    : { ...(current ?? emptyNetworkState()) };
  if (options.rules !== undefined) {
    state.rules = options.rules.map((rule) => ({
      url: rule.url,
      action: rule.action,
      status: rule.status ?? 200,
      contentType: rule.contentType ?? null,
      body: rule.body ?? "",
      headers: rule.headers ?? {},
      pattern: globToRegExp(rule.url),
      hits: 0,
    }));
  }
  for (const key of [
    "headers",
    "offline",
    "latencyMs",
    "downloadKbps",
    "uploadKbps",
  ]) {
    if (options[key] !== undefined) {
      state[key] = options[key];
    }
  }
  return state;
}

export function throttled(state) {
  return Boolean(state.latencyMs || state.downloadKbps || state.uploadKbps);
}

// The first rule whose pattern matches url, with its hit counted.
export function takeMatchingRule(state, url) {
  const rule = state?.rules.find((candidate) => candidate.pattern.test(url));
  if (rule) {
    rule.hits += 1;
  }
  return rule ?? null;
}

// A mock's response headers as name/value pairs. Mocks usually stand in
// for an API the page fetches across origins, so CORS is allowed unless
// the rule says otherwise.
export function mockHeaders(rule) {
  const headers = { ...rule.headers };
  const names = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  if (rule.contentType && !names.has("content-type")) {
    headers["content-type"] = rule.contentType;
  }
  if (!names.has("access-control-allow-origin")) {
    headers["access-control-allow-origin"] = "*";
  }
  return Object.entries(headers).map(([name, value]) => ({
    name,
    value: String(value),
  }));
}

export function describeNetworkState(state) {
  return {
    rules: state.rules.map(({ url, action, status, hits }) => ({
      url,
      action,
      ...(action === "mock" ? { status } : {}),
      hits,
    })),
    headers: Object.keys(state.headers),
    offline: state.offline,
    ...(throttled(state)
      ? {
          latencyMs: state.latencyMs,
          downloadKbps: state.downloadKbps,
          uploadKbps: state.uploadKbps,
        }
      : {}),
  };
}
