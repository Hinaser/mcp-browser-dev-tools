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

      output.write(`[${name}] ${messageLevel}: ${normalizeMessage(message)}\n`);
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
