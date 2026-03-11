import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { loadConfig } from "./config.mjs";
import { bootstrapWslRelay, _internal } from "./serve-bootstrap.mjs";

class FakeStream extends EventEmitter {}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.pid = 4321;
    this.exitCode = null;
    this.killed = false;
  }

  kill() {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

test("parseRelayListeningLine extracts relay binding metadata", () => {
  assert.deepEqual(
    _internal.parseRelayListeningLine(
      "relay listening on 172.20.128.1:9223 -> 127.0.0.1:9222",
    ),
    {
      listenHost: "172.20.128.1",
      listenPort: 9223,
      target: "127.0.0.1:9222",
    },
  );
});

test("toWslUncPath converts a WSL path into a Windows UNC path", () => {
  assert.equal(
    _internal.toWslUncPath("/home/hinaser/project/src/cli.mjs", "Ubuntu"),
    "\\\\wsl.localhost\\Ubuntu\\home\\hinaser\\project\\src\\cli.mjs",
  );
});

test("bootstrapWslRelay starts a Windows relay and returns env overrides", async () => {
  let capturedCommand = null;
  let capturedArgs = null;
  const child = new FakeChild();

  const bootstrapPromise = bootstrapWslRelay(
    {
      config: loadConfig({}),
      env: {
        WSL_INTEROP: "/run/WSL/123_interop",
        WSL_DISTRO_NAME: "Ubuntu",
      },
    },
    {
      platform: "linux",
      release: "6.6.87.2-microsoft-standard-WSL2",
      cliScriptPath: "/home/hinaser/project/src/cli.mjs",
      spawnProcess: (command, args) => {
        capturedCommand = command;
        capturedArgs = args;
        queueMicrotask(() => {
          child.stdout.emit(
            "data",
            "relay listening on 172.20.128.1:9222 -> 127.0.0.1:9222\n",
          );
        });
        return child;
      },
      errorOutput: {
        write() {
          return true;
        },
      },
    },
  );

  const bootstrap = await bootstrapPromise;

  assert.equal(capturedCommand, "powershell.exe");
  assert.match(
    capturedArgs[4],
    /relay --wsl --listen-port 9222 --target-port 9222/,
  );
  assert.equal(bootstrap.env.MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS, "1");
  assert.equal(bootstrap.env.CDP_BASE_URL, "http://172.20.128.1:9222");
  assert.equal(bootstrap.bridge.processId, 4321);

  await bootstrap.close();
  assert.equal(child.killed, true);
});

test("bootstrapWslRelay rejects non-WSL environments", async () => {
  await assert.rejects(
    bootstrapWslRelay(
      {
        config: loadConfig({}),
        env: {},
      },
      {
        platform: "linux",
        release: "6.8.0-generic",
      },
    ),
    /only supported inside WSL/,
  );
});

test("bootstrapWslRelay rejects Firefox-only broker configurations", async () => {
  await assert.rejects(
    bootstrapWslRelay(
      {
        config: loadConfig({ MCP_BROWSER_FAMILY: "firefox" }),
        env: {
          WSL_INTEROP: "/run/WSL/123_interop",
          WSL_DISTRO_NAME: "Ubuntu",
        },
      },
      {
        platform: "linux",
        release: "6.6.87.2-microsoft-standard-WSL2",
      },
    ),
    /requires a CDP-backed browser family/,
  );
});
