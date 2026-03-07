import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";

import {
  getWindowsWslHostCandidates,
  resolveRelayOptions,
  startTcpRelay,
} from "./tcp-relay.mjs";

test("getWindowsWslHostCandidates returns IPv4 addresses from WSL interfaces", () => {
  const candidates = getWindowsWslHostCandidates({
    Ethernet: [
      {
        address: "192.168.1.10",
        family: "IPv4",
        internal: false,
      },
    ],
    "vEthernet (WSL (Hyper-V firewall))": [
      {
        address: "172.26.0.1",
        family: "IPv4",
        internal: false,
      },
      {
        address: "::1",
        family: "IPv6",
        internal: false,
      },
    ],
  });

  assert.deepEqual(candidates, ["172.26.0.1"]);
});

test("resolveRelayOptions uses the WSL host address on Windows", () => {
  const relayOptions = resolveRelayOptions(
    { wsl: true, "listen-port": "9333" },
    {
      platform: "win32",
      networkInterfaces: {
        "vEthernet (WSL)": [
          {
            address: "172.26.0.1",
            family: "IPv4",
            internal: false,
          },
        ],
      },
    },
  );

  assert.deepEqual(relayOptions, {
    listenHost: "172.26.0.1",
    listenPort: 9333,
    targetHost: "127.0.0.1",
    targetPort: 9222,
    useWslBridge: true,
  });
});

test("resolveRelayOptions rejects non-loopback listen hosts by default", () => {
  assert.throws(
    () =>
      resolveRelayOptions(
        {
          "listen-host": "0.0.0.0",
        },
        {
          env: {},
        },
      ),
    /MCP_BROWSER_ALLOW_REMOTE_ENDPOINTS=1/,
  );
});

test("startTcpRelay wires the client and target sockets together", async () => {
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.pipedTo = [];
      this.destroyed = false;
    }

    pipe(target) {
      this.pipedTo.push(target);
      return target;
    }

    destroy() {
      this.destroyed = true;
      this.emit("close");
    }
  }

  const originalCreateServer = net.createServer;
  const originalConnect = net.connect;

  let connectionHandler = null;
  let listenedOn = null;
  let connectedTo = null;

  net.createServer = (handler) => {
    connectionHandler = handler;

    return {
      listen(port, host, callback) {
        listenedOn = { port, host };
        callback();
      },
      once() {},
      off() {},
      close(callback) {
        callback();
      },
    };
  };

  net.connect = (options) => {
    connectedTo = options;
    return new FakeSocket();
  };

  try {
    const relay = await startTcpRelay({
      listenHost: "127.0.0.1",
      listenPort: 9334,
      targetHost: "127.0.0.1",
      targetPort: 9222,
    });

    assert.deepEqual(listenedOn, {
      port: 9334,
      host: "127.0.0.1",
    });
    assert.equal(typeof connectionHandler, "function");

    const clientSocket = new FakeSocket();
    connectionHandler(clientSocket);

    assert.deepEqual(connectedTo, {
      host: "127.0.0.1",
      port: 9222,
    });
    assert.equal(clientSocket.pipedTo.length, 1);
    assert.equal(clientSocket.pipedTo[0].constructor.name, "FakeSocket");

    await relay.close();
    assert.equal(clientSocket.destroyed, true);
  } finally {
    net.createServer = originalCreateServer;
    net.connect = originalConnect;
  }
});
