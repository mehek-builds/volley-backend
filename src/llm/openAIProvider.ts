import OpenAI from 'openai';
import type { ResponseInput } from 'openai/resources/responses/responses';

export const OPENAI_GENERATION_MODEL = process.env.OPENAI_GENERATION_MODEL?.trim() || 'gpt-5.6-terra';

export type LlmUsage = {
  provider: 'openai' | 'anthropic';
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

export type OpenAITextResult = {
  text: string;
  usage: LlmUsage;
};

export type OpenAITextRequest = {
  instructions: string;
  input: string | ResponseInput;
  maxOutputTokens: number;
  timeoutMs?: number;
  jsonSchema?: {
    name: string;
    schema: Record<string, unknown>;
  };
  reasoningEffort?: 'low' | 'medium' | 'high';
};

let client: OpenAI | null = null;

function apiKey(): string | null {
  const value = process.env.OPENAI_API_KEY?.trim();
  return value || null;
}

export function openAIConfigured(): boolean {
  return apiKey() !== null;
}

function openAIClient(): OpenAI {
  const key = apiKey();
  if (!key) throw new Error('OPENAI_API_KEY is not configured');
  if (!client) client = new OpenAI({ apiKey: key, maxRetries: 0 });
  return client;
}

/** Verify that the configured OpenAI credential can access the production generation model. */
export async function probeOpenAIModel(): Promise<void> {
  await openAIClient().models.retrieve(OPENAI_GENERATION_MODEL);
}

/**
 * Generate one server-side text response through OpenAI.
 *
 * Callers own parsing and validation. Any thrown error, including an incomplete or empty response,
 * is the signal to execute the existing Anthropic path. Keeping fallback at the caller preserves
 * each generator's exact Claude request, timeout, caching, and telemetry behavior.
 */
export async function generateOpenAIText(request: OpenAITextRequest): Promise<OpenAITextResult> {
  const response = await openAIClient().responses.create(
    {
      model: OPENAI_GENERATION_MODEL,
      instructions: request.instructions,
      input: request.input,
      max_output_tokens: request.maxOutputTokens,
      reasoning: { effort: request.reasoningEffort ?? 'medium', context: 'current_turn' },
      store: false,
      text: {
        verbosity: 'low',
        ...(request.jsonSchema
          ? {
            format: {
              type: 'json_schema' as const,
              name: request.jsonSchema.name,
              schema: request.jsonSchema.schema,
              strict: true,
            },
          }
          : {}),
      },
    },
    request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : undefined,
  );

  if (response.status !== 'completed') {
    throw new Error(`OpenAI response did not complete (${response.incomplete_details?.reason ?? response.status})`);
  }
  const text = response.output_text.trim();
  if (!text) throw new Error('OpenAI returned an empty response');

  return {
    text,
    usage: {
      provider: 'openai',
      model: OPENAI_GENERATION_MODEL,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cacheCreationInputTokens: response.usage?.input_tokens_details?.cache_write_tokens ?? 0,
      cacheReadInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
    },
  };
}

export function anthropicUsage(model: string, usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): LlmUsage {
  return {
    provider: 'anthropic',
    model,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

export function logOpenAIFallback(workload: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[llm] OpenAI ${workload} failed; using Anthropic fallback: ${message.slice(0, 240)}`);
}
