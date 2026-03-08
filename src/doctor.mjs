import os from "node:os";

import { createBrowserAdapter } from "./browser-adapter.mjs";
import { loadConfig } from "./config.mjs";
import { detectInstalledBrowsers } from "./browser-launcher.mjs";

function reportEndpoints(config) {
  if (config.browserFamily === "firefox") {
    return config.firefoxBidiWsUrl;
  }

  if (config.browserFamily === "auto") {
    return {
      chromium: config.cdpBaseUrl,
      firefox: config.firefoxBidiWsUrl,
    };
  }

  return config.cdpBaseUrl;
}

async function probeUrl(url) {
  try {
    const response = await fetch(url);
    return {
      reachable: true,
      status: response.status,
      url,
    };
  } catch (error) {
    return {
      reachable: false,
      url,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function collectDoctorReport({
  env = process.env,
  url = null,
} = {}) {
  const config = loadConfig(env);
  const installedBrowsers = await detectInstalledBrowsers(env);
  const adapter = createBrowserAdapter(config);

  try {
    const browserStatus = await adapter.getBrowserStatus();
    const targetUrl = url ? await probeUrl(url) : null;

    return {
      platform: process.platform,
      release: os.release(),
      browserFamily: config.browserFamily,
      endpoint: reportEndpoints(config),
      display: {
        DISPLAY: env.DISPLAY || null,
        WAYLAND_DISPLAY: env.WAYLAND_DISPLAY || null,
        XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR || null,
      },
      installedBrowsers,
      browserStatus,
      targetUrl,
    };
  } finally {
    await adapter.closeAll();
  }
}

export function renderDoctorReport(report) {
  const endpointLines =
    typeof report.endpoint === "string"
      ? [`browser endpoint: ${report.endpoint}`]
      : Object.entries(report.endpoint).map(
          ([browserFamily, endpoint]) =>
            `${browserFamily} endpoint: ${endpoint}`,
        );
  const lines = [
    `platform: ${report.platform}`,
    `release: ${report.release}`,
    `browser family: ${report.browserFamily}`,
    ...endpointLines,
    `DISPLAY: ${report.display.DISPLAY ?? "-"}`,
    `WAYLAND_DISPLAY: ${report.display.WAYLAND_DISPLAY ?? "-"}`,
    `chromium executable: ${report.installedBrowsers.chromium ?? "not found"}`,
    `edge executable: ${report.installedBrowsers.edge ?? "not found"}`,
    `firefox executable: ${report.installedBrowsers.firefox ?? "not found"}`,
    `adapter available: ${report.browserStatus.available}`,
  ];

  if (report.browserStatus.error) {
    lines.push(`adapter error: ${report.browserStatus.error}`);
  }

  if (report.targetUrl) {
    lines.push(`target url: ${report.targetUrl.url}`);
    lines.push(
      `target reachable: ${report.targetUrl.reachable}${
        report.targetUrl.status ? ` (${report.targetUrl.status})` : ""
      }`,
    );
    if (report.targetUrl.error) {
      lines.push(`target error: ${report.targetUrl.error}`);
    }
  }

  return lines.join("\n");
}
