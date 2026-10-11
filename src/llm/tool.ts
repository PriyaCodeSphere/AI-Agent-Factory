/**
 * Provider-neutral tool definition.
 *
 * Tools are declared once with a Zod schema and converted to the provider's
 * function-calling format at the edge. Keeping this boundary thin is what lets
 * the 15 ERP integrations stay untouched if the model provider changes again.
 */

import { z } from "zod";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * A tool with its input type erased, so tools with different schemas can live
 * in the same array. `defineTool` is where the input type is actually checked:
 * its `run` callback is validated against the schema at the definition site,
 * which is the only place that knowledge is needed.
 */
export interface AgentTool {
  name: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- erased existential
  inputSchema: z.ZodType<any>;
  run: (input: any) => string | Promise<string>;
}

export function defineTool<S extends z.ZodType>(spec: {
  name: string;
  description: string;
  inputSchema: S;
  run: (input: z.output<S>) => string | Promise<string>;
}): AgentTool {
  return spec;
}

/** Converts a tool to the OpenAI function-tool shape. */
export function toOpenAiTool(tool: AgentTool): ChatCompletionTool {
  // `~standard` is Zod's own metadata and is not part of the JSON Schema.
  const { "~standard": _standard, ...parameters } = z.toJSONSchema(tool.inputSchema, {
    target: "draft-07",
    io: "input",
  });

  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: parameters as Record<string, unknown>,
    },
  };
}

/** Validates and executes a tool call, returning a string for the tool message. */
export async function executeTool(
  tools: AgentTool[],
  name: string,
  rawArguments: string,
): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return JSON.stringify({ error: `Unknown tool "${name}".` });

  let parsedJson: unknown;
  try {
    parsedJson = rawArguments.trim().length === 0 ? {} : JSON.parse(rawArguments);
  } catch {
    return JSON.stringify({ error: `Arguments for "${name}" were not valid JSON.` });
  }

  const validated = tool.inputSchema.safeParse(parsedJson);
  if (!validated.success) {
    // Hand the model the validation error so it can correct itself rather than stall.
    return JSON.stringify({
      error: `Arguments for "${name}" failed schema validation.`,
      issues: validated.error.issues.map(
        (issue: z.core.$ZodIssue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    });
  }

  return await tool.run(validated.data);
}
