/**
 * Response Format Adapter — unified extraction from raw provider response bodies.
 *
 * The event store records raw response bodies as-is (full fidelity).
 * Every consumer (stats, conversation-parser, test-runner, api-server, capture)
 * needs to pull content, tokens, and tool calls from those bodies.
 *
 * Instead of each consumer writing its own Ollama-biased if/else chain,
 * this module detects the provider format by shape and extracts uniformly.
 *
 * Format detection (by response body shape, not config):
 *   - choices[]                         → OpenAI
 *   - content[] with type fields        → Anthropic
 *   - message.content (no choices)      → Ollama /api/chat
 *   - response (string, no choices)     → Ollama /api/generate
 */

import type { TokenUsage } from '../types.js';

// --- Parsed output types ---

export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface ParsedResponse {
  content: string;
  tokens: TokenUsage | undefined;
  toolCalls: ParsedToolCall[];
  model: string | undefined;
}

export interface ParsedChunk {
  content: string;
  done: boolean;
  tokens: TokenUsage | undefined;
}

// --- Factory: detect format from body shape, extract uniformly ---

/** Parse a full (non-streaming) response body from any provider. */
export function parseResponseBody(body: unknown): ParsedResponse {
  if (!body || typeof body !== 'object') {
    return { content: '', tokens: undefined, toolCalls: [], model: undefined };
  }

  const obj = body as Record<string, unknown>;

  // OpenAI: has choices[]
  if (Array.isArray(obj.choices)) {
    return parseOpenAI(obj);
  }

  // Anthropic: has content[] with typed blocks and a top-level "type" or "role"
  if (Array.isArray(obj.content) && obj.content.length > 0 &&
      typeof (obj.content as Array<Record<string, unknown>>)[0]?.type === 'string') {
    return parseAnthropic(obj);
  }

  // Ollama /api/chat: has message object (but not choices)
  if (obj.message && typeof obj.message === 'object') {
    return parseOllamaChat(obj);
  }

  // Ollama /api/generate: has response string
  if (typeof obj.response === 'string') {
    return parseOllamaGenerate(obj);
  }

  return { content: JSON.stringify(body), tokens: undefined, toolCalls: [], model: undefined };
}

/** Parse a single streaming chunk from any provider. */
export function parseStreamChunk(chunk: unknown): ParsedChunk {
  if (!chunk || typeof chunk !== 'object') {
    return { content: '', done: false, tokens: undefined };
  }

  const obj = chunk as Record<string, unknown>;

  // OpenAI SSE: choices[].delta.content
  if (Array.isArray(obj.choices)) {
    const choices = obj.choices as Array<Record<string, unknown>>;
    const delta = choices[0]?.delta as Record<string, unknown> | undefined;
    const content = (delta?.content as string) ?? '';
    const finishReason = choices[0]?.finish_reason;
    return { content, done: finishReason === 'stop' || finishReason === 'end_turn', tokens: undefined };
  }

  // Anthropic SSE: content_block_delta
  if (obj.type === 'content_block_delta') {
    const delta = obj.delta as Record<string, unknown> | undefined;
    return { content: (delta?.text as string) ?? '', done: false, tokens: undefined };
  }
  if (obj.type === 'message_stop') {
    return { content: '', done: true, tokens: undefined };
  }
  if (obj.type === 'message_delta') {
    // Anthropic sends usage in message_delta at end
    const usage = obj.usage as Record<string, number> | undefined;
    const tokens = usage ? {
      prompt_tokens: 0, // input tokens come in message_start, not here
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: usage.output_tokens ?? 0,
    } : undefined;
    return { content: '', done: false, tokens };
  }

  // Ollama NDJSON: message.content or response string
  const msg = obj.message as Record<string, unknown> | undefined;
  const content = (msg?.content as string) ?? (typeof obj.response === 'string' ? obj.response : '');
  const done = obj.done === true;
  const tokens = done ? extractOllamaTokens(obj) : undefined;

  return { content, done, tokens };
}

/** Extract tokens from a raw response body (any provider). */
export function extractTokensFromBody(body: unknown): TokenUsage | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;

  // OpenAI: usage.prompt_tokens / usage.completion_tokens
  const usage = obj.usage as Record<string, number> | undefined;
  if (usage && typeof usage.prompt_tokens === 'number') {
    return {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? (usage.prompt_tokens + (usage.completion_tokens ?? 0)),
    };
  }

  // Anthropic: usage.input_tokens / usage.output_tokens
  if (usage && typeof usage.input_tokens === 'number') {
    return {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: (usage.input_tokens) + (usage.output_tokens ?? 0),
    };
  }

  // Ollama: prompt_eval_count / eval_count at top level
  return extractOllamaTokens(obj);
}

/** Extract text content from an assistant message (any provider format). */
export function extractAssistantContent(msg: Record<string, unknown>): string {
  // String content (OpenAI/Ollama)
  if (typeof msg.content === 'string') return msg.content;

  // Array content (Anthropic: [{type:"text", text:"..."}, ...])
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<Record<string, unknown>>)
      .filter(block => block.type === 'text')
      .map(block => (block.text as string) ?? '')
      .join('\n');
  }

  return '';
}

/** Extract tool calls from an assistant message (any provider format). */
export function extractToolCalls(msg: Record<string, unknown>): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];

  // OpenAI/Ollama: tool_calls[].function.{name, arguments}
  const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const fn = tc.function as Record<string, unknown> | undefined;
      const name = (fn?.name as string) ?? 'unknown';
      let args: Record<string, unknown> = {};
      try {
        const raw = fn?.arguments;
        if (typeof raw === 'string') args = JSON.parse(raw);
        else if (typeof raw === 'object' && raw !== null) args = raw as Record<string, unknown>;
      } catch { /* ignore */ }
      calls.push({ name, args, id: (tc.id as string) ?? undefined });
    }
    return calls;
  }

  // Anthropic: content[].{type:"tool_use", name, input}
  if (Array.isArray(msg.content)) {
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use') {
        calls.push({
          name: (block.name as string) ?? 'unknown',
          args: (block.input as Record<string, unknown>) ?? {},
          id: (block.id as string) ?? undefined,
        });
      }
    }
  }

  return calls;
}

/** Extract the assistant message object from a response body (any provider). */
export function extractAssistantMessage(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;

  // OpenAI: choices[0].message
  if (Array.isArray(obj.choices)) {
    const choices = obj.choices as Array<Record<string, unknown>>;
    return (choices[0]?.message as Record<string, unknown>) ?? null;
  }

  // Ollama: message
  if (obj.message && typeof obj.message === 'object' && !Array.isArray(obj.choices)) {
    return obj.message as Record<string, unknown>;
  }

  // Anthropic: the body itself acts as the message (content[] at top level)
  if (Array.isArray(obj.content)) {
    return obj;
  }

  return null;
}

// --- Private parsers ---

function parseOpenAI(obj: Record<string, unknown>): ParsedResponse {
  const choices = obj.choices as Array<Record<string, unknown>>;
  const msg = choices[0]?.message as Record<string, unknown> | undefined;
  const content = msg ? extractAssistantContent(msg) : '';
  const toolCalls = msg ? extractToolCalls(msg) : [];

  return {
    content,
    tokens: extractTokensFromBody(obj),
    toolCalls,
    model: (obj.model as string) ?? undefined,
  };
}

function parseAnthropic(obj: Record<string, unknown>): ParsedResponse {
  const blocks = obj.content as Array<Record<string, unknown>>;
  const textParts = blocks
    .filter(b => b.type === 'text')
    .map(b => (b.text as string) ?? '');
  const content = textParts.join('\n');

  const toolCalls: ParsedToolCall[] = blocks
    .filter(b => b.type === 'tool_use')
    .map(b => ({
      name: (b.name as string) ?? 'unknown',
      args: (b.input as Record<string, unknown>) ?? {},
      id: (b.id as string) ?? undefined,
    }));

  return {
    content,
    tokens: extractTokensFromBody(obj),
    toolCalls,
    model: (obj.model as string) ?? undefined,
  };
}

function parseOllamaChat(obj: Record<string, unknown>): ParsedResponse {
  const msg = obj.message as Record<string, unknown>;
  const content = extractAssistantContent(msg);
  const toolCalls = extractToolCalls(msg);

  return {
    content,
    tokens: extractOllamaTokens(obj),
    toolCalls,
    model: (obj.model as string) ?? undefined,
  };
}

function parseOllamaGenerate(obj: Record<string, unknown>): ParsedResponse {
  return {
    content: (obj.response as string) ?? '',
    tokens: extractOllamaTokens(obj),
    toolCalls: [],
    model: (obj.model as string) ?? undefined,
  };
}

function extractOllamaTokens(data: Record<string, unknown>): TokenUsage | undefined {
  const prompt = data.prompt_eval_count as number | undefined;
  const completion = data.eval_count as number | undefined;
  if (prompt === undefined && completion === undefined) return undefined;

  const evalDuration = data.eval_duration as number | undefined;
  const tokensPerSecond = (completion && evalDuration)
    ? Math.round(completion / (evalDuration / 1e9) * 10) / 10
    : undefined;

  return {
    prompt_tokens: prompt ?? 0,
    completion_tokens: completion ?? 0,
    total_tokens: (prompt ?? 0) + (completion ?? 0),
    tokens_per_second: tokensPerSecond,
  };
}
