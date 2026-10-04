import {
  requestedBrowserFamily,
  shouldCreateBrowserTab,
} from "../browser-requests.mjs";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../package-info.mjs";
import {
  emptyObjectSchema,
  ensureBrowserInputSchema,
  launchBrowserInputSchema,
  newTabInputSchema,
} from "../tool-schemas.mjs";

const SERVER_NAME = PACKAGE_NAME;
const SERVER_VERSION = PACKAGE_VERSION;

export function browserTools(server) {
  return [
    [
      "browser_status",
      {
        definition: {
          name: "browser_status",
          description:
            "Whether the browser endpoint answers, and the attached sessions.",
          inputSchema: emptyObjectSchema(),
        },
        handler: async () => ({
          serverName: SERVER_NAME,
          serverVersion: SERVER_VERSION,
          ...(await server.browserAdapter.getBrowserStatus()),
        }),
      },
    ],
    [
      "list_tabs",
      {
        definition: {
          name: "list_tabs",
          description: "List the browser's tabs.",
          inputSchema: emptyObjectSchema(),
        },
        handler: async () => ({
          tabs: await server.browserAdapter.listTargets(),
        }),
      },
    ],
    [
      "launch_browser",
      {
        definition: {
          name: "launch_browser",
          description:
            "Launch a debug-enabled browser, or reuse a reachable one unless port, address, userDataDir, or unsafeArgs is given; on macOS and Linux, never a second browser on a profile in use. Prefer ensure_browser.",
          inputSchema: launchBrowserInputSchema(
            server.config.browserFamily,
            server.config.enableUnsafeLaunchArgs,
          ),
        },
        handler: async (args) =>
          server.runExclusiveLaunch(async () => {
            const browserFamily = requestedBrowserFamily(
              server.config.browserFamily,
              args.browserFamily,
            );
            // A requested port, address, profile, or flags ask for a
            // specific browser, so only a plain launch may reuse the
            // running one.
            if (
              args.port === undefined &&
              args.address === undefined &&
              args.userDataDir === undefined &&
              args.unsafeArgs === undefined
            ) {
              const { status, available } =
                await server.probeBrowser(browserFamily);
              if (available) {
                const tab = shouldCreateBrowserTab(args)
                  ? await server.browserAdapter.createTab(args.url, {
                      browserFamily,
                    })
                  : null;
                return {
                  browserFamily,
                  launched: false,
                  reused: true,
                  status,
                  tab,
                };
              }
            }

            return server.launchUnlessPending(browserFamily, {
              config: server.config,
              browserFamily: args.browserFamily,
              url: args.url,
              port: args.port,
              address: args.address,
              userDataDir: args.userDataDir,
              unsafeArgs: args.unsafeArgs,
              waitMs: args.waitMs,
              skipDoctor: args.skipDoctor,
            });
          }),
      },
    ],
    [
      "ensure_browser",
      {
        definition: {
          name: "ensure_browser",
          description:
            "Reuse a reachable browser or launch one (with the MCP_BROWSER_USER_DATA_DIR profile when set), optionally opening url in a new tab. On macOS and Linux it never launches twice on one profile.",
          inputSchema: ensureBrowserInputSchema(
            server.config.browserFamily,
            server.config.enableUnsafeLaunchArgs,
          ),
        },
        handler: async (args) =>
          server.runExclusiveLaunch(() => server.ensureBrowser(args)),
      },
    ],
    [
      "list_sessions",
      {
        definition: {
          name: "list_sessions",
          description: "List attached sessions.",
          inputSchema: emptyObjectSchema(),
        },
        handler: async () => ({
          sessions: server.browserAdapter.listSessions(),
        }),
      },
    ],
    [
      "new_tab",
      {
        definition: {
          name: "new_tab",
          description: "Open a tab; returns its target id.",
          inputSchema: newTabInputSchema(server.config.browserFamily),
        },
        handler: async (args) =>
          server.browserAdapter.createTab(args.url, {
            browserFamily: args.browserFamily,
          }),
      },
    ],
    [
      "close_tab",
      {
        definition: {
          name: "close_tab",
          description: "Close a tab and its session.",
          inputSchema: {
            type: "object",
            properties: {
              targetId: {
                type: "string",
                description: "From list_tabs or new_tab.",
              },
            },
            required: ["targetId"],
            additionalProperties: false,
          },
        },
        handler: async (args) =>
          server.browserAdapter.closeTarget(args.targetId),
      },
    ],
    [
      "attach_tab",
      {
        definition: {
          name: "attach_tab",
          description:
            "Attach to a tab: returns the sessionId other tools take, and buffers its console and network events from now on.",
          inputSchema: {
            type: "object",
            properties: {
              targetId: {
                type: "string",
                description: "From list_tabs or new_tab.",
              },
            },
            required: ["targetId"],
            additionalProperties: false,
          },
        },
        handler: async (args) =>
          server.browserAdapter.attachToTarget(args.targetId),
      },
    ],
    [
      "detach_tab",
      {
        definition: {
          name: "detach_tab",
          description: "Detach a session; the tab stays open.",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: { type: "string" },
            },
            required: ["sessionId"],
            additionalProperties: false,
          },
        },
        handler: async (args) =>
          server.browserAdapter.detachSession(args.sessionId),
      },
    ],
  ];
}
