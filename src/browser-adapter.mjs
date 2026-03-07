import { CdpSessionManager } from "./cdp-client.mjs";
import { FirefoxBidiSessionManager } from "./firefox-bidi-client.mjs";

export function createBrowserAdapter(config) {
  if (config.browserFamily === "firefox") {
    return new FirefoxBidiSessionManager(config);
  }

  return new CdpSessionManager(config);
}
