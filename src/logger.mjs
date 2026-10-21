import { appendFileSync, renameSync, statSync } from "node:fs";
import process from "node:process";

import { PACKAGE_NAME } from "./package-info.mjs";

export const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

// When the log file would grow past this, it is renamed to `<file>.1`
// (replacing any older one) and a new file is started.
export const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;

function fileSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

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
  maxFileBytes = LOG_FILE_MAX_BYTES,
} = {}) {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.error;
  let outputEnabled = true;

  function appendToFile(line) {
    try {
      const size = fileSize(filePath);
      if (size > 0 && size + Buffer.byteLength(line) > maxFileBytes) {
        renameSync(filePath, `${filePath}.1`);
      }
      appendFileSync(filePath, line);
    } catch {
      // ignore file write errors to avoid crashing the server
    }
  }

  return {
    level,
    // Stops writing to `output`, for example once its reader is gone; the
    // log file still gets every line.
    disableOutput() {
      outputEnabled = false;
    },
    enabled(messageLevel) {
      return (LOG_LEVELS[messageLevel] ?? -1) <= threshold;
    },
    log(messageLevel, message, options = {}) {
      if (!options.force && !this.enabled(messageLevel)) {
        return false;
      }

      const line = `[${name}] ${messageLevel}: ${normalizeMessage(message)}\n`;
      if (outputEnabled) {
        try {
          output.write(line);
        } catch {
          outputEnabled = false;
        }
      }
      if (filePath != null) {
        appendToFile(line);
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
