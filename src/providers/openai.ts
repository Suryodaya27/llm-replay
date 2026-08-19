/**
 * OpenAI Provider Adapter
 *
 * Translates between unified ChatRequest/ChatResponse and OpenAI's API.
 * Also works with any OpenAI-compatible API (Groq, Together, Mistral, etc.)
 *
 * OpenAI API: POST /v1/chat/completions
 */

import type { Provider, ChatRequest, ChatResponse, StreamChunk, ProviderConfig } from './types.js';

export class OpenAIProvider implements Provider {
  readonly name = 'openai';
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: ProviderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey ?? '';
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body = this.buildBody(req);
    const start = Date.now();

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API error (${res.status}): ${text}`);
    }

    const data = await res.json() as OpenAIResponse;
    const latency = Date.now() - start;

    return {
      content: data.choices?.[0]?.message?.content ?? '',
      model: data.model ?? req.model,
      finish_reason: data.choices?.[0]?.finish_reason ?? 'stop',
      tokens: data.usage ? {
        prompt_tokens: data.usage.prompt_tokens,
        completion_tokens: data.usage.completion_tokens,
        total_tokens: data.usage.total_tokens,
      } : undefined,
      raw: data,
      latency_ms: latency,
    };
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<StreamChunk> {
    const body = this.buildBody(req, true);

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API error (${res.status}): ${text}`);
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
        const data = line.slice(6);
        if (data === '[DONE]') {
          yield { index: index++, content: '', done: true, raw: { done: true } };
          return;
        }
        try {
          const chunk = JSON.parse(data) as OpenAIStreamChunk;
          const content = chunk.choices?.[0]?.delta?.content ?? '';
          yield {
            index: index++,
            content,
            done: false,
            raw: chunk,
          };
        } catch { /* skip */ }
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { 'authorization': `Bearer ${this.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private buildBody(req: ChatRequest, stream = false): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;
    return body;
  }
}

// --- OpenAI response types ---

interface OpenAIResponse {
  id: string;
  model: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIStreamChunk {
  choices: Array<{
    delta: { content?: string };
    finish_reason?: string;
  }>;
}
