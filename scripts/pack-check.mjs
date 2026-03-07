import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "npm.cmd" : "npm";
const args = ["pack", "--dry-run", "--cache", ".npm-pack-cache"];
const env = { ...process.env };

for (const key of Object.keys(env)) {
  if (/^(npm|pnpm)_/i.test(key)) {
    delete env[key];
  }
}

const child = spawn(command, args, {
  stdio: "inherit",
  env,
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exitCode = code ?? 1;
});
