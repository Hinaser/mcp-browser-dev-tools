export function requestedBrowserFamily(configuredFamily, requestedFamily) {
  if (requestedFamily) {
    return requestedFamily;
  }

  return configuredFamily === "auto" ? null : configuredFamily;
}

export function shouldCreateBrowserTab(args) {
  if (args.createTab !== undefined) {
    return args.createTab;
  }

  return typeof args.url === "string" && args.url.trim() !== "";
}
