#!/usr/bin/env node
import process from "node:process";

import { runCli } from "./src/cli.mjs";

runCli().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
