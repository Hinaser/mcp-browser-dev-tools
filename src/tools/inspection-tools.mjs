import {
  screenshotFileExtensions,
  takeScreenshot,
} from "../screenshot-output.mjs";
import {
  screenshotFormatsFor,
  screenshotTarget,
} from "../screenshot-output.mjs";
import {
  asImageToolResult,
  asToolResult,
  moveScreenshotImage,
} from "../tool-results.mjs";
import { selectorProperty, sessionWithLimitSchema } from "../tool-schemas.mjs";

const DEFAULT_READ_CHARS = 8000;
const DEFAULT_SNAPSHOT_NODES = 100;
const MAX_SNAPSHOT_NODES = 500;

// The snapshot's nodes are lines already; send them as plain text rather than
// a JSON array, which costs quotes and escapes on every line.
export function formatSnapshotResult(result) {
  if (!Array.isArray(result?.nodes)) {
    return asToolResult(result);
  }
  const { nodes, ...rest } = result;
  const lines = [
    `${rest.url ?? ""} ${JSON.stringify(rest.title ?? "")}`.trim(),
    ...nodes,
  ];
  if (rest.more > 0) {
    lines.push(`(${rest.more} more nodes; raise limit or pass a selector)`);
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: result,
  };
}
const MAX_READ_CHARS = 100_000;
const DEFAULT_READ_LINKS = 50;
const MAX_READ_LINKS = 200;

export function inspectionTools(server) {
  const tools = [
    [
      "get_console_messages",
      {
        definition: {
          name: "get_console_messages",
          description: "Buffered console messages and exceptions.",
          inputSchema: sessionWithLimitSchema(),
        },
        handler: async (args) => ({
          messages: server.browserAdapter.getConsoleMessages(
            args.sessionId,
            args.limit ?? 50,
          ),
        }),
      },
    ],
    [
      "get_network_requests",
      {
        definition: {
          name: "get_network_requests",
          description: "Buffered network requests.",
          inputSchema: sessionWithLimitSchema(),
        },
        handler: async (args) => ({
          requests: server.browserAdapter.getNetworkRequests(
            args.sessionId,
            args.limit ?? 50,
          ),
        }),
      },
    ],
    [
      "get_snapshot",
      {
        definition: {
          name: "get_snapshot",
          description:
            'List visible headings and controls, one line each with a ref, role, name, and state, e.g. e3 textbox "Email" value="ada@example.com". ref=e3 works as any tool\'s selector until the page navigates; controls inside iframes get refs like f1e3. Far cheaper than get_document or a screenshot.',
          inputSchema: {
            type: "object",
            properties: {
              sessionId: { type: "string" },
              selector: {
                type: "string",
                description: "Only inside this element.",
              },
              limit: {
                type: "integer",
                minimum: 1,
                maximum: MAX_SNAPSHOT_NODES,
                description: `Default ${DEFAULT_SNAPSHOT_NODES}.`,
              },
              headings: {
                type: "boolean",
                description: "Default true.",
              },
            },
            required: ["sessionId"],
            additionalProperties: false,
          },
        },
        handler: async (args) =>
          server.browserAdapter.snapshotPage(args.sessionId, {
            selector: args.selector,
            limit: args.limit ?? DEFAULT_SNAPSHOT_NODES,
            headings: args.headings ?? true,
          }),
        formatResult: formatSnapshotResult,
      },
    ],
    [
      "get_document",
      {
        definition: {
          name: "get_document",
          description: "The DOM tree (Firefox: the full HTML).",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: { type: "string" },
              depth: {
                type: "integer",
                minimum: 1,
                description: "Default 2.",
              },
            },
            required: ["sessionId"],
            additionalProperties: false,
          },
        },
        handler: async (args) =>
          server.browserAdapter.getDocument(args.sessionId, args.depth ?? 2),
      },
    ],
    [
      "inspect_element",
      {
        definition: {
          name: "inspect_element",
          description:
            "One element's box, visibility, role, name, state, and styles, after scrolling it into view.",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: { type: "string" },
              selector: selectorProperty(),
            },
            required: ["sessionId", "selector"],
            additionalProperties: false,
          },
        },
        handler: async (args) =>
          server.browserAdapter.inspectElement(args.sessionId, args.selector),
      },
    ],
    [
      "read_text",
      {
        definition: {
          name: "read_text",
          description: `Visible text of the main content, or of selector, as lines up to maxChars; with links, also its links.`,
          inputSchema: {
            type: "object",
            properties: {
              sessionId: { type: "string" },
              selector: selectorProperty(),
              maxChars: {
                type: "integer",
                minimum: 1,
                maximum: MAX_READ_CHARS,
                description: `Default ${DEFAULT_READ_CHARS}.`,
              },
              links: {
                type: "boolean",
                description: `Also list http(s) links (default false).`,
              },
              maxLinks: {
                type: "integer",
                minimum: 1,
                maximum: MAX_READ_LINKS,
                description: `Default ${DEFAULT_READ_LINKS}.`,
              },
            },
            required: ["sessionId"],
            additionalProperties: false,
          },
        },
        handler: async (args) =>
          server.browserAdapter.readText(args.sessionId, {
            selector: args.selector,
            maxChars: args.maxChars ?? DEFAULT_READ_CHARS,
            links: args.links === true,
            maxLinks: args.maxLinks ?? DEFAULT_READ_LINKS,
          }),
      },
    ],
    [
      "take_screenshot",
      {
        definition: {
          name: "take_screenshot",
          description:
            "Screenshot the page or selector: base64 in the JSON (output data, default), image content (image), or a file (file, or path). cssRect and scale convert image pixels to x, y.",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: { type: "string" },
              format: {
                type: "string",
                enum: screenshotFormatsFor(server.config.browserFamily),
                description: "Default png; must match path's extension.",
              },
              selector: selectorProperty(),
              output: {
                type: "string",
                enum: ["data", "image", "file"],
                description: "Default data; file when path is given.",
              },
              path: {
                type: "string",
                description: `Absolute, ending in ${screenshotFileExtensions(server.config.browserFamily).join(", ")}; default a temp file.`,
              },
              overwrite: {
                type: "boolean",
                description: "Replace an existing file.",
              },
            },
            required: ["sessionId"],
            additionalProperties: false,
          },
        },
        validate: (args) => {
          screenshotTarget(args, server.config.browserFamily);
        },
        handler: async (args) => takeScreenshot(server, args),
        formatResult: (result, args) => {
          if (args.output !== "image") {
            return asToolResult(result);
          }
          const images = [];
          const value = moveScreenshotImage(result, images);
          return asImageToolResult({ value, images });
        },
      },
    ],
    [
      "get_events",
      {
        definition: {
          name: "get_events",
          description: "Buffered console, network, page, and dialog events.",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: { type: "string" },
              limit: {
                type: "integer",
                minimum: 1,
                description: "Most recent N (default 50).",
              },
            },
            required: ["sessionId"],
            additionalProperties: false,
          },
        },
        handler: async (args) => ({
          events: server.browserAdapter.getEvents(
            args.sessionId,
            args.limit ?? 50,
          ),
        }),
      },
    ],
  ];

  if (server.config.enableEvaluate) {
    tools.push([
      "evaluate_js",
      {
        definition: {
          name: "evaluate_js",
          description:
            "Run JavaScript in the page; top-level await works, and the last expression's value is returned.",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: { type: "string" },
              expression: {
                type: "string",
                description: "JavaScript.",
              },
              awaitPromise: {
                type: "boolean",
                description: "Default true.",
              },
              returnByValue: {
                type: "boolean",
                description:
                  "JSON value (default true); false gives a short description (Chromium only).",
              },
            },
            required: ["sessionId", "expression"],
            additionalProperties: false,
          },
        },
        handler: async (args) =>
          server.browserAdapter.evaluate(args.sessionId, args.expression, {
            awaitPromise: args.awaitPromise,
            returnByValue: args.returnByValue,
          }),
      },
    ]);
  }

  return tools;
}
