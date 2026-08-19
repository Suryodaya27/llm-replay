/**
 * Anthropic Provider Adapter
 *
 * Translates between unified ChatRequest/ChatResponse and Anthropic's Messages API.
 * Key differences from OpenAI:
 * - System prompt is a top-level field, not a message
 * - Uses `max_tokens` as required field
 * - Response structure is different (content blocks)
 * - Streaming uses SSE with different event types
 *
 * Anthropic API: POST /v1/messages
 */

import type { Provider, ChatRequest, ChatResponse, StreamChunk, ProviderConfig } from './types.js';

const DEFAULT_MAX_TOKENS = 4096;

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: ProviderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey ?? '';
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body = this.buildBody(req);
    const start = Date.now();

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error (${res.status}): ${text}`);
    }

    const data = await res.json() as AnthropicResponse;
    const latency = Date.now() - start;

    return {
      content: extractContent(data),
      model: data.model ?? req.model,
      finish_reason: data.stop_reason ?? 'end_turn',
      tokens: data.usage ? {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: data.usage.input_tokens + data.usage.output_tokens,
      } : undefined,
      raw: data,
      latency_ms: latency,
    };
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<StreamChunk> {
    const body = { ...this.buildBody(req), stream: true };

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error (${res.status}): ${text}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let index = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6)) as AnthropicStreamEvent;

          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            yield {
              index: index++,
              content: event.delta.text ?? '',
              done: false,
              raw: event,
            };
          }

          if (event.type === 'message_stop') {
            yield { index: index++, content: '', done: true, raw: event };
            return;
          }
        } catch { /* skip */ }
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    // Anthropic doesn't have a simple health endpoint; try a minimal request
    try {
      const res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      return res.status !== 401; // auth works even if request itself fails
    } catch {
      return false;
    }
  }

  private buildBody(req: ChatRequest): Record<string, unknown> {
    // Anthropic: system prompt is top-level, not in messages
    const systemMsg = req.messages.find((m) => m.role === 'system');
    const messages = req.messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: req.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
    };

    if (systemMsg) body.system = systemMsg.content;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    return body;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
}

// --- Anthropic response types ---

interface AnthropicResponse {
  id: string;
  model: string;
  content: Array<{ type: string; text?: string }>;
  stop_reason: string;
  usage?: { input_tokens: number; output_tokens: number };
}

interface AnthropicStreamEvent {
  type: string;
  delta?: { type: string; text?: string };
}

function extractContent(data: AnthropicResponse): string {
  return data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}
