import { encodeMessage, MessageBuffer } from "./json-rpc-stdio.mjs";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info.mjs";

const SERVER_NAME = PACKAGE_NAME;
const SERVER_VERSION = PACKAGE_VERSION;

function success(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function failure(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

function asToolResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value,
  };
}

function emptyObjectSchema() {
  return {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
}

function validateValue(path, value, schema) {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path} must be an object`);
    }

    const properties = schema.properties ?? {};
    const required = schema.required ?? [];
    for (const key of required) {
      if (value[key] === undefined) {
        throw new Error(`${path}.${key} is required`);
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          throw new Error(`${path}.${key} is not allowed`);
        }
      }
    }

    for (const [key, propertySchema] of Object.entries(properties)) {
      if (value[key] !== undefined) {
        validateValue(`${path}.${key}`, value[key], propertySchema);
      }
    }

    return;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") {
      throw new Error(`${path} must be a string`);
    }

    if (schema.enum && !schema.enum.includes(value)) {
      throw new Error(`${path} must be one of: ${schema.enum.join(", ")}`);
    }

    return;
  }

  if (schema.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new Error(`${path} must be a boolean`);
    }

    return;
  }

  if (schema.type === "integer") {
    if (!Number.isInteger(value)) {
      throw new Error(`${path} must be an integer`);
    }

    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new Error(`${path} must be >= ${schema.minimum}`);
    }
  }
}

function screenshotFormatsFor(browserFamily) {
  return browserFamily === "firefox"
    ? ["png", "jpeg"]
    : ["png", "jpeg", "webp"];
}

function sessionWithLimitSchema(description) {
  return {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
      },
      limit: {
        type: "integer",
        minimum: 1,
      },
    },
    required: ["sessionId"],
    additionalProperties: false,
    description,
  };
}

export class McpBrowserDevToolsServer {
  constructor({
    config,
    browserAdapter,
    input = process.stdin,
    output = process.stdout,
    errorOutput = process.stderr,
  }) {
    this.config = config;
    this.browserAdapter = browserAdapter;
    this.input = input;
    this.output = output;
    this.errorOutput = errorOutput;
    this.messageBuffer = new MessageBuffer();
    this.tools = this.createTools();
  }

  createTools() {
    const tools = [
      [
        "browser_status",
        {
          definition: {
            name: "browser_status",
            description:
              "Report whether the configured browser endpoint is reachable and how many active sessions are attached.",
            inputSchema: emptyObjectSchema(),
          },
          handler: async () => this.browserAdapter.getBrowserStatus(),
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
            tabs: await this.browserAdapter.listTargets(),
          }),
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
            sessions: this.browserAdapter.listSessions(),
          }),
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
            this.browserAdapter.attachToTarget(args.targetId),
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
            this.browserAdapter.detachSession(args.sessionId),
        },
      ],
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
            messages: this.browserAdapter.getConsoleMessages(
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
            requests: this.browserAdapter.getNetworkRequests(
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
                },
                depth: {
                  type: "integer",
                  minimum: 1,
                },
              },
              required: ["sessionId"],
              additionalProperties: false,
            },
          },
          handler: async (args) =>
            this.browserAdapter.getDocument(args.sessionId, args.depth ?? 2),
        },
      ],
      [
        "inspect_element",
        {
          definition: {
            name: "inspect_element",
            description:
              "Inspect a single DOM element with a CSS selector and return normalized element details.",
            inputSchema: {
              type: "object",
              properties: {
                sessionId: {
                  type: "string",
                },
                selector: {
                  type: "string",
                },
              },
              required: ["sessionId", "selector"],
              additionalProperties: false,
            },
          },
          handler: async (args) =>
            this.browserAdapter.inspectElement(args.sessionId, args.selector),
        },
      ],
      [
        "take_screenshot",
        {
          definition: {
            name: "take_screenshot",
            description: "Capture a screenshot from an attached page.",
            inputSchema: {
              type: "object",
              properties: {
                sessionId: {
                  type: "string",
                },
                format: {
                  type: "string",
                  enum: screenshotFormatsFor(this.config.browserFamily),
                },
              },
              required: ["sessionId"],
              additionalProperties: false,
            },
          },
          handler: async (args) =>
            this.browserAdapter.takeScreenshot(
              args.sessionId,
              args.format ?? "png",
            ),
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
                },
                limit: {
                  type: "integer",
                  minimum: 1,
                },
              },
              required: ["sessionId"],
              additionalProperties: false,
            },
          },
          handler: async (args) => ({
            events: this.browserAdapter.getEvents(
              args.sessionId,
              args.limit ?? 50,
            ),
          }),
        },
      ],
    ];

    if (this.config.enableEvaluate) {
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
                },
                expression: {
                  type: "string",
                },
                awaitPromise: {
                  type: "boolean",
                },
                returnByValue: {
                  type: "boolean",
                },
              },
              required: ["sessionId", "expression"],
              additionalProperties: false,
            },
          },
          handler: async (args) =>
            this.browserAdapter.evaluate(args.sessionId, args.expression, {
              awaitPromise: args.awaitPromise,
              returnByValue: args.returnByValue,
            }),
        },
      ]);
    }

    return new Map(tools);
  }

  start() {
    this.input.on("data", (chunk) => {
      let messages;
      try {
        messages = this.messageBuffer.push(chunk);
      } catch (error) {
        this.log(`failed to parse incoming message: ${error.message}`);
        return;
      }

      for (const message of messages) {
        void this.dispatch(message);
      }
    });

    this.log(
      `listening on stdio for MCP messages; browser=${this.config.browserFamily}`,
    );
  }

  log(message) {
    this.errorOutput.write(`[${SERVER_NAME}] ${message}\n`);
  }

  async dispatch(message) {
    const response = await this.handleRequest(message);
    if (!response) {
      return;
    }

    this.output.write(encodeMessage(response));
  }

  async handleRequest(message) {
    const id = message?.id ?? null;

    if (message?.jsonrpc !== "2.0") {
      return failure(id, -32600, "Invalid Request");
    }

    try {
      switch (message.method) {
        case "initialize":
          return success(id, {
            protocolVersion: this.config.protocolVersion,
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: SERVER_NAME,
              version: SERVER_VERSION,
            },
            instructions:
              "Use the browser tools to inspect tabs, console output, network activity, DOM structure, and specific elements across Chromium CDP or Firefox BiDi.",
          });
        case "notifications/initialized":
          return null;
        case "ping":
          return success(id, {});
        case "tools/list":
          return success(id, {
            tools: Array.from(this.tools.values(), (tool) => tool.definition),
          });
        case "tools/call":
          return success(id, await this.callTool(message.params));
        default:
          if (message.id === undefined) {
            return null;
          }
          return failure(id, -32601, `Method not found: ${message.method}`);
      }
    } catch (error) {
      return failure(id, -32000, error.message);
    }
  }

  async callTool(params = {}) {
    const tool = this.tools.get(params.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${params.name}`);
    }

    const args = params.arguments ?? {};
    validateValue("arguments", args, tool.definition.inputSchema);
    const result = await tool.handler(args);
    return asToolResult(result);
  }
}
