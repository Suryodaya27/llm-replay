/**
 * Ollama Provider Adapter
 *
 * Translates between unified ChatRequest/ChatResponse and Ollama's native API.
 * Ollama API: POST /api/chat with { model, messages, stream, options }
 */

import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { Provider, ChatRequest, ChatResponse, StreamChunk, ProviderConfig } from './types.js';

export class OllamaProvider implements Provider {
  readonly name = 'ollama';
  private readonly url: URL;

  constructor(config: ProviderConfig) {
    this.url = new URL(config.baseUrl);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body = this.buildBody(req, false);
    const start = Date.now();
    const raw = await this.post('/api/chat', body);
    const latency = Date.now() - start;

    const data = JSON.parse(raw.toString('utf-8'));
    return {
      content: data.message?.content ?? '',
      model: data.model ?? req.model,
      finish_reason: data.done_reason ?? 'stop',
      tokens: extractTokens(data),
      raw: data,
      latency_ms: latency,
    };
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<StreamChunk> {
    const body = this.buildBody(req, true);
    let index = 0;

    for await (const line of this.postStream('/api/chat', body)) {
      if (!line.trim()) continue;
      try {
        const chunk = JSON.parse(line);
        yield {
          index: index++,
          content: chunk.message?.content ?? '',
          done: chunk.done === true,
          raw: chunk,
        };
      } catch { /* skip unparseable */ }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.get('/api/tags');
      return res.length > 0;
    } catch {
      return false;
    }
  }

  private buildBody(req: ChatRequest, stream: boolean): Buffer {
    const payload: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream,
    };
    if (req.temperature !== undefined || req.raw_options) {
      payload.options = {
        ...(req.raw_options ?? {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      };
    }
    return Buffer.from(JSON.stringify(payload), 'utf-8');
  }

  private post(path: string, body: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: this.url.hostname,
        port: this.url.port || 11434,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
      }, (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private async *postStream(path: string, body: Buffer): AsyncGenerator<string> {
    const lines = await new Promise<string[]>((resolve, reject) => {
      const req = httpRequest({
        hostname: this.url.hostname,
        port: this.url.port || 11434,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
      }, (res: IncomingMessage) => {
        let buffer = '';
        const result: string[] = [];
        res.on('data', (raw: Buffer) => {
          buffer += raw.toString('utf-8');
          const parts = buffer.split('\n');
          buffer = parts.pop() ?? '';
          result.push(...parts);
        });
        res.on('end', () => {
          if (buffer.trim()) result.push(buffer);
          resolve(result);
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    for (const line of lines) yield line;
  }

  private get(path: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: this.url.hostname,
        port: this.url.port || 11434,
        path,
        method: 'GET',
      }, (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }
}

function extractTokens(data: Record<string, unknown>) {
  const prompt = (data.prompt_eval_count as number) ?? 0;
  const completion = (data.eval_count as number) ?? 0;
  if (!prompt && !completion) return undefined;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}
