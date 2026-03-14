import { appendFileSync } from "node:fs";
import process from "node:process";

import { PACKAGE_NAME } from "./package-info.mjs";

export const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function normalizeMessage(message) {
  if (message instanceof Error) {
    return message.message;
  }

  return String(message);
}

export function createLogger({
  level = "error",
  output = process.stderr,
  name = PACKAGE_NAME,
  filePath = null,
} = {}) {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.error;

  return {
    level,
    enabled(messageLevel) {
      return (LOG_LEVELS[messageLevel] ?? -1) <= threshold;
    },
    log(messageLevel, message, options = {}) {
      if (!options.force && !this.enabled(messageLevel)) {
        return false;
      }

      const line = `[${name}] ${messageLevel}: ${normalizeMessage(message)}\n`;
      output.write(line);
      if (filePath != null) {
        try {
          appendFileSync(filePath, line);
        } catch {
          // ignore file write errors to avoid crashing the server
        }
      }
      return true;
    },
    error(message, options) {
      return this.log("error", message, options);
    },
    warn(message, options) {
      return this.log("warn", message, options);
    },
    info(message, options) {
      return this.log("info", message, options);
    },
    debug(message, options) {
      return this.log("debug", message, options);
    },
  };
}
