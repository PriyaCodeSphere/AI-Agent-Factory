/**
 * The agent runner.
 *
 * One tool-calling loop that every agent shares. Each run gets two synthetic
 * terminal tools:
 *   - a submit tool, whose Zod schema is the agent's structured output
 *   - `escalate_to_controller`, the NFR-39..NFR-54 escape hatch
 *
 * Making escalation a first-class tool is what lets an agent decline. That is
 * the behaviour the governance story depends on, so it is wired in once here
 * rather than left to each agent's prose.
 */

import { z } from "zod";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { setCurrentAgent } from "../erp/tools.ts";
import { azureClient, effortParams } from "../llm/client.ts";
import { defineTool, executeTool, toOpenAiTool, type AgentTool } from "../llm/tool.ts";
import { emit } from "../trace.ts";
import { systemPromptFor, type AgentSpec } from "./registry.ts";

const MAX_ITERATIONS = 12;

export type AgentOutcome<T> =
  | { status: "submitted"; result: T }
  | { status: "escalated"; nfr: string; reason: string };

export async function runAgent<S extends z.ZodType>(opts: {
  spec: AgentSpec;
  task: string;
  submitToolName: string;
  submitToolDescription: string;
  resultSchema: S;
}): Promise<AgentOutcome<z.output<S>>> {
  const { spec } = opts;
  const { client, config } = azureClient();
  const started = Date.now();

  let submitted: z.output<S> | undefined;
  let escalated: { reason: string } | undefined;

  const submitTool = defineTool({
    name: opts.submitToolName,
    description: `${opts.submitToolDescription} Call this exactly once, when you have the evidence to support it.`,
    inputSchema: opts.resultSchema,
    run: (input) => {
      submitted = input;
      return "Result recorded. Stop now - do not call any further tools.";
    },
  });

  const escalateTool = defineTool({
    name: "escalate_to_controller",
    description:
      `Hand the case to the MRP controller without acting. Use this when a mandatory constraint ` +
      `prevents the action, or when the available data is contradictory, missing, or not current ` +
      `enough. Escalation policy for this agent: ${spec.escalation.id} - ${spec.escalation.text}`,
    inputSchema: z.object({
      reason: z.string().describe("What blocked you, in one or two sentences, naming the constraint id."),
      constraintId: z.string().describe("The NFR id that prevented the action, e.g. NFR-14."),
      whatWouldUnblock: z.string().describe("What the controller needs to supply or fix."),
    }),
    run: (input) => {
      escalated = { reason: `${input.reason} Needed: ${input.whatWouldUnblock}` };
      emit({ kind: "escalation", agent: spec.name, nfr: input.constraintId, reason: escalated.reason });
      return "Escalation recorded. Stop now - do not call any further tools.";
    },
  });

  const tools: AgentTool[] = [...spec.tools, submitTool, escalateTool];

  emit({ kind: "agent_start", agent: spec.name, fr: spec.fr });
  setCurrentAgent(spec.name);

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPromptFor(spec) },
    { role: "user", content: opts.task },
  ];

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let nudged = false;

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
      const response = await client.chat.completions.create({
        model: config.deployment,
        messages,
        tools: tools.map(toOpenAiTool),
        tool_choice: "auto",
        ...effortParams(spec.effort, config),
      });

      inputTokens += response.usage?.prompt_tokens ?? 0;
      outputTokens += response.usage?.completion_tokens ?? 0;
      cachedTokens += response.usage?.prompt_tokens_details?.cached_tokens ?? 0;

      const choice = response.choices[0];
      if (!choice) break;
      messages.push(choice.message);

      const toolCalls = choice.message.tool_calls ?? [];

      if (toolCalls.length === 0) {
        // The agent answered in prose instead of finishing properly. Nudge once,
        // then stop - never synthesise a result from free text.
        if (nudged) break;
        nudged = true;
        messages.push({
          role: "user",
          content:
            `Finish properly: call \`${opts.submitToolName}\` with your result, or ` +
            `\`escalate_to_controller\` if a constraint prevents you from acting.`,
        });
        continue;
      }

      for (const call of toolCalls) {
        if (call.type !== "function") continue;
        const output = await executeTool(tools, call.function.name, call.function.arguments);
        messages.push({ role: "tool", tool_call_id: call.id, content: output });
      }

      if (submitted !== undefined || escalated !== undefined) break;
    }
  } finally {
    emit({
      kind: "agent_end",
      agent: spec.name,
      fr: spec.fr,
      ms: Date.now() - started,
      inputTokens,
      outputTokens,
      cachedTokens,
    });
    setCurrentAgent("orchestrator");
  }

  if (escalated) return { status: "escalated", nfr: spec.escalation.id, reason: escalated.reason };
  if (submitted !== undefined) return { status: "submitted", result: submitted };

  // Neither terminal tool fired - treat as an escalation rather than inventing a result.
  const reason = `${spec.name} ended without submitting a result or escalating (iteration cap reached).`;
  emit({ kind: "escalation", agent: spec.name, nfr: spec.escalation.id, reason });
  return { status: "escalated", nfr: spec.escalation.id, reason };
}
