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
            "Report whether the configured browser endpoint is reachable and how many active sessions are attached.",
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
          description:
            "List inspectable page targets exposed by the configured browser adapter.",
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
            "Launch a local debug-enabled browser process that matches the current broker configuration and return launch details plus an optional doctor report. When port, address, userDataDir, and unsafeArgs are all omitted and a browser of this family is already reachable, returns it with reused: true instead of launching, opening url in a new tab if given. On macOS and Linux it never starts a second browser on a profile that is already open. Prefer ensure_browser.",
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
            "Ensure a compatible browser is reachable through the current broker, reusing a running one when possible. If none answers after three status checks, launch one locally, using the MCP_BROWSER_USER_DATA_DIR profile when set, and optionally open a tab for the requested URL. Will not launch again for 30 seconds while a browser it launched is still starting, and on macOS and Linux never starts a second browser on a profile that is already open.",
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
          description:
            "List active attached debugging sessions held by this broker.",
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
          description:
            "Create a new browser tab and return the resulting target metadata.",
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
          description:
            "Close a browser tab by target id. Any attached session for that tab will disconnect.",
          inputSchema: {
            type: "object",
            properties: {
              targetId: {
                type: "string",
                description: "Target id returned by list_tabs or new_tab.",
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
            "Attach to a page target and start buffering console, log, and network events.",
          inputSchema: {
            type: "object",
            properties: {
              targetId: {
                type: "string",
                description: "The target id returned by list_tabs.",
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
          description: "Close an attached debugging session.",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: {
                type: "string",
                description: "The session id returned by attach_tab.",
              },
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
