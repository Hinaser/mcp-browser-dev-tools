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
            "Inspect a single DOM element located by CSS, text=..., role=..., or name=... syntax and return normalized element details. Scrolls the element into view first, so the returned box reflects the scrolled position.",
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
          description: `Read the visible text of the page's main content (main or role=main, else a single article, else the body), or of one element with selector, as plain lines up to maxChars. With links, also list the links in it with their text and absolute URL, for example to collect search results. Use it to read articles and results pages; inspect_element clips text to 400 characters.`,
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
            "Capture a screenshot from an attached page or a single element when selector is provided. By default the image comes back as base64 data in the JSON result; output image returns it as image content instead, and output file (or path) writes it to a file and returns the path.",
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
                  "How to return the image: data puts base64 data in the JSON result, image returns an image content block with only metadata in the JSON, file writes the decoded image to a file and returns its path (default data, or file when path is given).",
              },
              path: {
                type: "string",
                description: `Absolute file path for output file, ending in ${screenshotFileExtensions(server.config.browserFamily).join(", ")}; the extension sets the format. Missing parent directories are created. Default: a new file in a private directory under the system temp directory.`,
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
                  "Return the result as a JSON value (default true). When false, only a short description of the resulting object is returned. Chromium and Edge only; Firefox always returns a serialized value.",
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
