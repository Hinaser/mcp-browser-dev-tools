import { validateValue } from "../json-schema.mjs";
import { asToolResult } from "../tool-results.mjs";
import { TOOL_GROUPS } from "../tool-sets.mjs";

function groupOf(name) {
  return (
    Object.entries(TOOL_GROUPS).find(([, names]) =>
      names.includes(name),
    )?.[0] ?? null
  );
}

// The first sentence, ending at a period: descriptions use "?" inside
// glob syntax.
function firstSentence(text) {
  const match = text.match(/^.*?\.(\s|$)/s);
  return (match ? match[0] : text).trim();
}

// The tools MCP_BROWSER_TOOLS leaves out of the list are still there: this
// lists them, describes one, or calls one, so an agent can find and use a
// tool without every turn paying for its definition. run_steps and
// run_tabs steps can use them too.
export function moreToolsTool(hidden, advertise) {
  const lookup = (name) => {
    const tool = hidden.get(name);
    if (!tool) {
      throw new Error(
        `${name} is not one of the tools more_tools offers: ${Array.from(hidden.keys()).join(", ")}`,
      );
    }
    return tool;
  };
  return [
    "more_tools",
    {
      definition: {
        name: "more_tools",
        description:
          "Tools not listed here to keep each turn small: drag, cookies and storage, request mocking, HAR, performance, and more. No arguments lists them; name describes one; name with arguments calls it. They also work as run_steps steps.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            arguments: {
              type: "object",
              description: "Call the tool with these arguments.",
            },
          },
          additionalProperties: false,
        },
      },
      handler: async (args, options) => {
        if (args.name === undefined) {
          if (args.arguments !== undefined) {
            throw new Error("more_tools needs name to call a tool");
          }
          return {
            tools: Array.from(hidden, ([name, tool]) => ({
              name,
              group: groupOf(name),
              description: firstSentence(tool.definition.description),
            })),
            usage:
              'more_tools {"name":"set_network"} shows a tool\'s arguments; {"name":"set_network","arguments":{...}} calls it, as does a run_steps step.',
          };
        }
        const tool = lookup(args.name);
        if (args.arguments === undefined) {
          return {
            ...advertise(tool.definition),
            group: groupOf(args.name),
          };
        }
        validateValue(
          "arguments.arguments",
          args.arguments,
          tool.definition.inputSchema,
        );
        tool.validate?.(args.arguments);
        return tool.handler(args.arguments, options);
      },
      // A call's result is formatted as the tool itself would format it;
      // the list goes as one line per tool, which costs less than JSON.
      formatResult: (result, args) => {
        if (args.name !== undefined && args.arguments !== undefined) {
          return (lookup(args.name).formatResult ?? asToolResult)(
            result,
            args.arguments,
          );
        }
        if (args.name !== undefined) {
          return asToolResult(result);
        }
        const lines = result.tools.map(
          ({ name, group, description }) =>
            `${name} (${group}): ${description}`,
        );
        return {
          content: [
            { type: "text", text: [...lines, result.usage].join("\n") },
          ],
          structuredContent: result,
        };
      },
    },
  ];
}
