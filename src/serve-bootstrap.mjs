import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DEFAULT_CDP_BASE_URL } from "./config.mjs";

const RELAY_READY_PREFIX = "relay listening on ";
const WSL_LOCALHOST_PREFIX = "\\\\wsl.localhost\\";

function isWslRuntime({
  platform = process.platform,
  release = os.release(),
  env = process.env,
} = {}) {
  return (
    platform === "linux" &&
    (release.toLowerCase().includes("microsoft") || Boolean(env.WSL_INTEROP))
  );
}

function toWslUncPath(filePath, distroName) {
  if (!distroName) {
    throw new Error("WSL_DISTRO_NAME is required to launch the Windows relay");
  }

  const resolvedPath = path.resolve(filePath);
  const windowsPath = resolvedPath.replace(/\//g, "\\");
  return `${WSL_LOCALHOST_PREFIX}${distroName}${windowsPath}`;
}

function parseRelayListeningLine(line) {
  const normalized = typeof line === "string" ? line.trim() : "";
  if (!normalized.startsWith(RELAY_READY_PREFIX)) {
    return null;
  }

  const [binding, target] = normalized
    .slice(RELAY_READY_PREFIX.length)
    .split(" -> ", 2);
  if (!binding || !target) {
    return null;
  }

  const separatorIndex = binding.lastIndexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }

  return {
    listenHost: binding.slice(0, separatorIndex),
    listenPort: Number.parseInt(binding.slice(separatorIndex + 1), 10),
    target,
  };
}

function collectLinesFromStream(stream, onLine) {
  if (!stream) {
    return () => {};
  }

  let buffer = "";
  const handleData = (chunk) => {
    buffer += String(chunk);
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      onLine(line.replace(/\r$/, ""));
    }
  };

  stream.on("data", handleData);
  return () => {
    stream.off("data", handleData);
  };
}

function normalizeRelayPort(value, fallback, optionName) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${optionName} must be an integer between 1 and 65535`);
  }

  return parsed;
}

function powershellRelayCommand({
  cliScriptPath,
  listenPort,
  targetPort,
  nodeCommand = "node",
}) {
  const quotedNodeCommand = nodeCommand.replace(/'/g, "''");
  const quotedScriptPath = cliScriptPath.replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `& '${quotedNodeCommand}' '${quotedScriptPath}' relay --wsl --listen-port ${listenPort} --target-port ${targetPort}`,
  ].join("; ");
}

function defaultCliScriptPath() {
  return fileURLToPath(new URL("./cli.mjs", import.meta.url));
}

function defaultCdpTargetPort(config) {
  return Number.parseInt(
    new URL(config.cdpBaseUrl ?? DEFAULT_CDP_BASE_URL).port || "9222",
    10,
  );
}

export async function bootstrapWslRelay(
  {
    config,
    relayListenPort,
    relayTargetPort,
    startupTimeoutMs = 10_000,
    env = process.env,
  },
  {
    platform = process.platform,
    release = os.release(),
    cliScriptPath = defaultCliScriptPath(),
    spawnProcess = spawn,
    errorOutput = process.stderr,
  } = {},
) {
  if (!isWslRuntime({ platform, release, env })) {
    throw new Error("--bootstrap-wsl-relay is only supported inside WSL");
  }

  if (config.browserFamily === "firefox") {
    throw new Error(
      "--bootstrap-wsl-relay requires a CDP-backed browser family (chromium, edge, or auto)",
    );
  }

  const targetPort = normalizeRelayPort(
    relayTargetPort,
    defaultCdpTargetPort(config),
    "--target-port",
  );
  const listenPort = normalizeRelayPort(
    relayListenPort,
    targetPort,
    "--bridge-port",
  );
  const relayCliPath = toWslUncPath(cliScriptPath, env.WSL_DISTRO_NAME);
  const relayProcess = spawnProcess(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      powershellRelayCommand({
        cliScriptPath: relayCliPath,
        listenPort,
        targetPort,
        nodeCommand:
          typeof env.MCP_BROWSER_WINDOWS_NODE === "string" &&
          env.MCP_BROWSER_WINDOWS_NODE.trim()
            ? env.MCP_BROWSER_WINDOWS_NODE.trim()
            : "node",
      }),
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const stderrLines = [];

  try {
    const relayInfo = await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settle(() => {
          reject(
            new Error(
              `Timed out starting the Windows WSL relay after ${startupTimeoutMs}ms`,
            ),
          );
        });
      }, startupTimeoutMs);
      timer.unref?.();

      const settle = (callback) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        stopStdout();
        stopStderr();
        relayProcess.off("error", handleError);
        relayProcess.off("exit", handleExit);
        callback();
      };

      const handleError = (error) => {
        settle(() => reject(error));
      };

      const handleExit = (code, signal) => {
        const stderrText =
          stderrLines.length > 0 ? `\n${stderrLines.join("\n")}` : "";
        settle(() => {
          reject(
            new Error(
              `Windows WSL relay exited before startup completed (code=${code}, signal=${signal})${stderrText}`,
            ),
          );
        });
      };

      const stopStdout = collectLinesFromStream(relayProcess.stdout, (line) => {
        const relayInfo = parseRelayListeningLine(line);
        if (relayInfo) {
          settle(() => resolve(relayInfo));
        }
      });
      const stopStderr = collectLinesFromStream(relayProcess.stderr, (line) => {
        stderrLines.push(line);
      });

      relayProcess.on("error", handleError);
      relayProcess.on("exit", handleExit);
    });

    const relayBaseUrl = `http://${relayInfo.listenHost}:${relayInfo.listenPort}`;
    relayProcess.stderr?.on("data", (chunk) => {
      errorOutput.write(String(chunk));
    });

    return {
      env: {
        ...env,
        MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS: "1",
        CDP_BASE_URL: relayBaseUrl,
      },
      bridge: {
        listenHost: relayInfo.listenHost,
        listenPort: relayInfo.listenPort,
        targetPort,
        cdpBaseUrl: relayBaseUrl,
        processId: relayProcess.pid ?? null,
      },
      async close() {
        if (relayProcess.exitCode !== null || relayProcess.killed) {
          return;
        }

        relayProcess.kill();
        await new Promise((resolve) => {
          relayProcess.once("exit", () => resolve());
          const timer = setTimeout(resolve, 1_000);
          timer.unref?.();
        });
      },
    };
  } catch (error) {
    relayProcess.kill();
    await new Promise((resolve) => {
      relayProcess.once("exit", () => resolve());
      const timer = setTimeout(resolve, 250);
      timer.unref?.();
    });
    throw error;
  }
}

export const _internal = {
  isWslRuntime,
  parseRelayListeningLine,
  powershellRelayCommand,
  toWslUncPath,
};
