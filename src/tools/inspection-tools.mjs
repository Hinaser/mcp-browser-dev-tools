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
import {
  LOCATOR_DESCRIPTION,
  selectorProperty,
  sessionWithLimitSchema,
} from "../tool-schemas.mjs";

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
          description:
            "Read buffered console, log, and exception messages for an attached session.",
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
          description:
            "Summarize buffered network requests for an attached session in a DevTools-network-tab style view.",
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
            'List the page\'s visible headings and controls in document order, one line each: a ref, the role, the accessible name, and value, checked, or disabled state, for example e3 textbox "Email" value="ada@example.com". Pass ref=e3 as the selector of any tool. Refs last until the page navigates. Use this before get_document or a screenshot to decide what to do next.',
          inputSchema: {
            type: "object",
            properties: {
              sessionId: {
                type: "string",
                description: "Session id returned by attach_tab.",
              },
              selector: {
                type: "string",
                description: `Only list nodes inside this element. ${LOCATOR_DESCRIPTION}`,
              },
              limit: {
                type: "integer",
                minimum: 1,
                maximum: MAX_SNAPSHOT_NODES,
                description: `Most nodes to return (default ${DEFAULT_SNAPSHOT_NODES}); more tells how many were left out.`,
              },
              headings: {
                type: "boolean",
                description: "Include headings (default true).",
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
          description: "Fetch the DOM document tree for an attached page.",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: {
                type: "string",
                description: "Session id returned by attach_tab.",
              },
              depth: {
                type: "integer",
                minimum: 1,
                description:
                  "How many levels of child nodes to include (default 2). Chromium and Edge only; Firefox returns the full document HTML regardless.",
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
            "Describe one element: its box, visibility, role, accessible name, state, and styles. Scrolls it into view first, so the box reflects the scrolled position.",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: {
                type: "string",
                description: "Session id returned by attach_tab.",
              },
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
          description: `Read the visible text of the main content (main or role=main, else a single article, else the body), or of selector, as plain lines up to maxChars. With links, also list its links with text and absolute URL, for example search results. inspect_element clips text to 400 characters.`,
          inputSchema: {
            type: "object",
            properties: {
              sessionId: {
                type: "string",
                description: "Session id returned by attach_tab.",
              },
              selector: selectorProperty(),
              maxChars: {
                type: "integer",
                minimum: 1,
                maximum: MAX_READ_CHARS,
                description: `Most characters of text to return (default ${DEFAULT_READ_CHARS}, at most ${MAX_READ_CHARS}); totalChars and truncated tell whether there was more.`,
              },
              links: {
                type: "boolean",
                description: `Also return the http(s) links inside, deduplicated, at most maxLinks (default false).`,
              },
              maxLinks: {
                type: "integer",
                minimum: 1,
                maximum: MAX_READ_LINKS,
                description: `Most links to return (default ${DEFAULT_READ_LINKS}, at most ${MAX_READ_LINKS}); moreLinks counts the rest.`,
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
            "Screenshot the page, or one element with selector. Returns base64 data in the JSON by default; output image returns image content instead, and output file (or path) writes a file and returns its path.",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: {
                type: "string",
                description: "Session id returned by attach_tab.",
              },
              format: {
                type: "string",
                enum: screenshotFormatsFor(server.config.browserFamily),
                description:
                  "Image format (default png). With path, it must match the extension.",
              },
              selector: selectorProperty(),
              output: {
                type: "string",
                enum: ["data", "image", "file"],
                description:
                  "data (default) puts base64 in the JSON, image returns image content with metadata in the JSON, file writes a file and returns its path (the default when path is given).",
              },
              path: {
                type: "string",
                description: `Absolute path for output file, ending in ${screenshotFileExtensions(server.config.browserFamily).join(", ")} (the extension sets the format); parent directories are created. Default: a new file in a private temp directory.`,
              },
              overwrite: {
                type: "boolean",
                description:
                  "For output file: replace path if it already exists (default false: fail instead).",
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
          description:
            "Read buffered console, log, exception, and network events for an attached session.",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: {
                type: "string",
                description: "Session id returned by attach_tab.",
              },
              limit: {
                type: "integer",
                minimum: 1,
                description:
                  "Return the most recent N events from the session buffer (default 50).",
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
          description: "Evaluate JavaScript in the attached page context.",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: {
                type: "string",
                description: "Session id returned by attach_tab.",
              },
              expression: {
                type: "string",
                description:
                  "JavaScript to evaluate in the page's main world. Top-level await works, and the value of the last expression statement is returned.",
              },
              awaitPromise: {
                type: "boolean",
                description:
                  "Wait for a returned promise to settle and return its result (default true).",
              },
              returnByValue: {
                type: "boolean",
                description:
                  "Return a JSON value (default true); false returns a short description of the object. Chromium and Edge only; Firefox always returns a serialized value.",
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
