/**
 * Azure OpenAI client and per-request parameter shaping.
 *
 * Azure deployments differ in which parameters they accept: reasoning
 * deployments (o-series, gpt-5) take `reasoning_effort` and
 * `max_completion_tokens` and reject `temperature`, while standard chat
 * deployments take `temperature` and `max_tokens`. Set
 * AZURE_OPENAI_REASONING=true for the former.
 */

import { AzureOpenAI } from "openai";

import type { Effort } from "../agents/registry.ts";

export interface AzureConfig {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
  deployment: string;
  isReasoningModel: boolean;
}

export function loadAzureConfig(): AzureConfig {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  // Both names are in circulation; accept either.
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? process.env.AZURE_OPENAI_CHAT_DEPLOYMENT;

  const missing = [
    !endpoint && "AZURE_OPENAI_ENDPOINT",
    !apiKey && "AZURE_OPENAI_API_KEY",
    !deployment && "AZURE_OPENAI_DEPLOYMENT (or AZURE_OPENAI_CHAT_DEPLOYMENT)",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Copy .env.example and set them, or export them in your shell.`,
    );
  }

  return {
    endpoint: endpoint!,
    apiKey: apiKey!,
    deployment: deployment!,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2024-10-21",
    isReasoningModel: process.env.AZURE_OPENAI_REASONING === "true",
  };
}

let cached: { client: AzureOpenAI; config: AzureConfig } | undefined;

export function azureClient(): { client: AzureOpenAI; config: AzureConfig } {
  if (!cached) {
    const config = loadAzureConfig();
    cached = {
      config,
      client: new AzureOpenAI({
        endpoint: config.endpoint,
        apiKey: config.apiKey,
        apiVersion: config.apiVersion,
        deployment: config.deployment,
      }),
    };
  }
  return cached;
}

/**
 * Maps an agent's effort level onto whatever the deployment supports.
 *
 * Azure's `reasoning_effort` has three levels against the BRD design's five,
 * so xhigh and max both land on "high" - the demo's per-agent cost tuning is
 * coarser here than it would be on a model with a five-level scale.
 */
export function effortParams(
  effort: Effort,
  config: AzureConfig,
): Record<string, unknown> {
  if (!config.isReasoningModel) {
    return { max_tokens: 4096, temperature: 0 };
  }

  const reasoningEffort = effort === "low" ? "low" : effort === "medium" ? "medium" : "high";
  return { max_completion_tokens: 16000, reasoning_effort: reasoningEffort };
}
