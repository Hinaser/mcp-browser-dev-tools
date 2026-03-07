import net from "node:net";
import os from "node:os";
import process from "node:process";

import { isLoopbackHost, isTruthyFlag } from "./config.mjs";

export const DEFAULT_RELAY_LISTEN_HOST = "127.0.0.1";
export const DEFAULT_RELAY_LISTEN_PORT = 9223;
export const DEFAULT_RELAY_TARGET_HOST = "127.0.0.1";
export const DEFAULT_RELAY_TARGET_PORT = 9222;

function allowsRemoteEndpoints(env = process.env) {
  return (
    isTruthyFlag(env.MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS) ||
    isTruthyFlag(env.MCP_BROWSER_ALLOW_REMOTE_CDP)
  );
}

function normalizeHost(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function parseRelayPort(value, fallback, optionName) {
  const normalized =
    typeof value === "number"
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";

  if (!normalized) {
    return fallback;
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${optionName} must be an integer between 1 and 65535`);
  }

  const parsed = Number.parseInt(normalized, 10);
  if (parsed < 1 || parsed > 65535) {
    throw new Error(`${optionName} must be an integer between 1 and 65535`);
  }

  return parsed;
}

export function getWindowsWslHostCandidates(
  networkInterfaces = os.networkInterfaces(),
) {
  const candidates = [];

  for (const [name, addresses] of Object.entries(networkInterfaces)) {
    if (!/wsl/i.test(name)) {
      continue;
    }

    for (const addressInfo of addresses ?? []) {
      if (addressInfo.internal || addressInfo.family !== "IPv4") {
        continue;
      }

      candidates.push(addressInfo.address);
    }
  }

  return [...new Set(candidates)];
}

export function resolveRelayOptions(
  options = {},
  {
    env = process.env,
    platform = process.platform,
    networkInterfaces = null,
  } = {},
) {
  const useWslBridge = options.wsl === true;
  let listenHost;

  if (useWslBridge) {
    if (platform !== "win32") {
      throw new Error("--wsl is only supported on Windows");
    }

    const candidates = getWindowsWslHostCandidates(
      networkInterfaces ?? os.networkInterfaces(),
    );
    if (candidates.length === 0) {
      throw new Error("Could not detect a Windows WSL host address");
    }

    [listenHost] = candidates;
  } else {
    listenHost = normalizeHost(
      options["listen-host"],
      DEFAULT_RELAY_LISTEN_HOST,
    );

    if (!isLoopbackHost(listenHost) && !allowsRemoteEndpoints(env)) {
      throw new Error(
        "--listen-host must be loopback unless MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1",
      );
    }
  }

  return {
    listenHost,
    listenPort: parseRelayPort(
      options["listen-port"],
      DEFAULT_RELAY_LISTEN_PORT,
      "--listen-port",
    ),
    targetHost: normalizeHost(
      options["target-host"],
      DEFAULT_RELAY_TARGET_HOST,
    ),
    targetPort: parseRelayPort(
      options["target-port"],
      DEFAULT_RELAY_TARGET_PORT,
      "--target-port",
    ),
    useWslBridge,
  };
}

export async function startTcpRelay({
  listenHost,
  listenPort,
  targetHost,
  targetPort,
  errorOutput = process.stderr,
} = {}) {
  const openSockets = new Set();

  const server = net.createServer((clientSocket) => {
    const upstreamSocket = net.connect({
      host: targetHost,
      port: targetPort,
    });

    openSockets.add(clientSocket);
    openSockets.add(upstreamSocket);

    const cleanup = () => {
      openSockets.delete(clientSocket);
      openSockets.delete(upstreamSocket);
    };

    clientSocket.on("close", cleanup);
    upstreamSocket.on("close", cleanup);

    clientSocket.on("error", () => {
      upstreamSocket.destroy();
    });

    upstreamSocket.on("error", (error) => {
      errorOutput.write(`[relay] target connection failed: ${error.message}\n`);
      clientSocket.destroy();
    });

    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  async function close() {
    for (const socket of openSockets) {
      socket.destroy();
    }

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  return {
    server,
    close,
  };
}
