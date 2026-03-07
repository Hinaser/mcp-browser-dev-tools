import test from "node:test";
import assert from "node:assert/strict";

import * as api from "./index.mjs";
import { PACKAGE_VERSION } from "./package-info.mjs";

test("index exports the public package surface", () => {
  assert.equal(typeof api.createBrowserDevToolsApp, "function");
  assert.equal(typeof api.collectDoctorReport, "function");
  assert.equal(typeof api.runCli, "function");
  assert.equal(typeof api.loadConfig, "function");
  assert.equal(api.PACKAGE_NAME, "mcp-browser-dev-tools");
  assert.equal(api.PACKAGE_VERSION, PACKAGE_VERSION);
});
