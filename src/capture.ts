/**
 * Capture Module — intercepts HTTP traffic and records events.
 *
 * Handles both buffered (stream:false) and streaming (stream:true) responses.
 * For streaming: records each NDJSON chunk as a stream_chunk event, then
 * emits a stream_end event with the assembled full content + token stats.
 */

import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { Clock } from './clock.js';
import { EventStore } from './event-store.js';
import type {
  RequestEvent, ResponseEvent, StreamChunkEvent, StreamEndEvent,
  ReplayEvent, SessionMeta, TokenUsage,
} from './types.js';

export interface CaptureOptions {
  sessionId: string;
  ollamaBaseUrl: string;
  clock: Clock;
  store: EventStore;
  model?: string;
  tags?: string[];
}

export class CaptureSession {
  private seq = 0;
  private initialized = false;
  private readonly sessionId: string;
  private readonly ollamaUrl: URL;
  private readonly clock: Clock;
  private readonly store: EventStore;
  private model?: string;
  private readonly tags?: string[];

  constructor(opts: CaptureOptions) {
    this.sessionId = opts.sessionId;
    this.ollamaUrl = new URL(opts.ollamaBaseUrl);
    this.clock = opts.clock;
    this.store = opts.store;
    this.model = opts.model;
    this.tags = opts.tags;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    const meta: SessionMeta = {
      session_id: this.sessionId,
      started_at: new Date(this.clock.now()).toISOString(),
      mode: 'capture',
      ollama_base_url: this.ollamaUrl.toString(),
      model: this.model,
      tags: this.tags,
    };
    await this.emit({ seq: this.seq++, t: 0, type: 'meta', data: meta });
    this.clock.reset();
    this.initialized = true;
  }

  /**
   * Proxy a request: detect if streaming, handle accordingly.
   * For non-streaming: returns { status, headers, body }.
   * For streaming: returns a streamHandler with pipe() to stream to the client.
   */
  async proxy(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Buffer
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    if (!this.initialized) {
      try {
        const parsed = JSON.parse(body.toString('utf-8'));
        if (parsed.model && !this.model) {
          this.model = parsed.model;
        }
      } catch { /* ignore */ }
    }
    await this.init();

    // Detect if request wants streaming
    let isStream = false;
    try {
      const parsed = JSON.parse(body.toString('utf-8'));
      isStream = parsed.stream === true;
    } catch { /* not JSON, treat as non-stream */ }

    if (isStream) {
      return this.proxyStreaming(method, path, headers, body);
    }
    return this.proxyBuffered(method, path, headers, body);
  }

  /**
   * Streaming proxy — captures chunks in real-time, returns the full
   * concatenated response as a buffer (non-streaming to the agent).
   *
   * NOTE: For true streaming passthrough to the agent, use proxyStreamRaw().
   */
  private async proxyStreaming(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Buffer
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const parsedBody = safeParse(body);

    const reqEvent: RequestEvent = {
      seq: this.seq++,
      t: this.clock.elapsed(),
      type: 'request',
      data: { method, path, headers, body: parsedBody },
    };
    await this.emit(reqEvent);

    const startTime = this.clock.now();
    const { status, headers: resHeaders, chunks } = await this.forwardStream(method, path, headers, body);
    const durationMs = this.clock.now() - startTime;

    // Record each chunk as a stream_chunk event
    let assembledContent = '';
    let tokens: TokenUsage | undefined;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkEvent: StreamChunkEvent = {
        seq: this.seq++,
        t: this.clock.elapsed(),
        type: 'stream_chunk',
        data: { index: i, chunk },
      };
      await this.emit(chunkEvent);

      // Assemble content from Ollama NDJSON chunks
      if (chunk && typeof chunk === 'object') {
        const c = chunk as Record<string, unknown>;
        // /api/chat streaming
        if (c.message && typeof c.message === 'object') {
          const msg = c.message as { content?: string };
          assembledContent += msg.content ?? '';
        }
        // /api/generate streaming
        if (typeof c.response === 'string') {
          assembledContent += c.response;
        }
        // Last chunk has token stats
        if (c.done === true) {
          tokens = extractTokens(c);
        }
      }
    }

    // Emit stream_end with aggregated data
    const endEvent: StreamEndEvent = {
      seq: this.seq++,
      t: this.clock.elapsed(),
      type: 'stream_end',
      data: {
        chunks_count: chunks.length,
        assembled_content: assembledContent,
        duration_ms: durationMs,
        tokens,
      },
    };
    await this.emit(endEvent);

    // Return the full NDJSON back to the agent as-is (all chunks joined)
    const fullBody = chunks.map((c) => JSON.stringify(c)).join('\n') + '\n';

    return { status, headers: resHeaders, body: Buffer.from(fullBody, 'utf-8') };
  }

  /**
   * Stream directly to a ServerResponse — true streaming passthrough.
   * The agent gets chunks in real time while we record them.
   */
  async proxyStreamToResponse(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Buffer,
    clientRes: { writeHead: (s: number, h: Record<string, string>) => void; write: (d: string) => void; end: () => void },
  ): Promise<void> {
    // Detect model from first request if not already known
    if (!this.initialized) {
      try {
        const parsed = JSON.parse(body.toString('utf-8'));
        if (parsed.model && !this.model) {
          this.model = parsed.model;
        }
      } catch { /* ignore */ }
    }
    await this.init();
    const parsedBody = safeParse(body);

    const reqEvent: RequestEvent = {
      seq: this.seq++,
      t: this.clock.elapsed(),
      type: 'request',
      data: { method, path, headers, body: parsedBody },
    };
    await this.emit(reqEvent);

    const startTime = this.clock.now();
    let assembledContent = '';
    let tokens: TokenUsage | undefined;
    let chunkIndex = 0;
    let status = 200;
    let resHeaders: Record<string, string> = {};

    await new Promise<void>((resolve, reject) => {
      const opts = {
        hostname: this.ollamaUrl.hostname,
        port: this.ollamaUrl.port || 11434,
        path,
        method,
        headers: { ...headers, host: this.ollamaUrl.host, 'content-length': String(body.length) },
      };

      const req = httpRequest(opts, (res: IncomingMessage) => {
        status = res.statusCode ?? 500;
        resHeaders = flattenResHeaders(res);

        // Start streaming to client
        clientRes.writeHead(status, { ...resHeaders, 'transfer-encoding': 'chunked' });

        let buffer = '';
        res.on('data', (raw: Buffer) => {
          const text = raw.toString('utf-8');
          clientRes.write(text); // pass through immediately

          // Parse NDJSON lines
          buffer += text;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? ''; // keep incomplete line

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const chunk = JSON.parse(line);
              // Record chunk event (fire-and-forget to not block streaming)
              const chunkEvent: StreamChunkEvent = {
                seq: this.seq++,
                t: this.clock.elapsed(),
                type: 'stream_chunk',
                data: { index: chunkIndex++, chunk },
              };
              this.emit(chunkEvent); // intentionally not awaited in hot path

              // Assemble
              if (chunk.message?.content) assembledContent += chunk.message.content;
              if (typeof chunk.response === 'string') assembledContent += chunk.response;
              if (chunk.done === true) tokens = extractTokens(chunk);
            } catch { /* skip unparseable lines */ }
          }
        });

        res.on('end', async () => {
          // Handle any remaining buffer
          if (buffer.trim()) {
            try {
              const chunk = JSON.parse(buffer);
              const chunkEvent: StreamChunkEvent = {
                seq: this.seq++,
                t: this.clock.elapsed(),
                type: 'stream_chunk',
                data: { index: chunkIndex++, chunk },
              };
              await this.emit(chunkEvent);
              if (chunk.message?.content) assembledContent += chunk.message.content;
              if (typeof chunk.response === 'string') assembledContent += chunk.response;
              if (chunk.done === true) tokens = extractTokens(chunk);
            } catch { /* ignore */ }
          }

          const durationMs = this.clock.now() - startTime;
          const endEvent: StreamEndEvent = {
            seq: this.seq++,
            t: this.clock.elapsed(),
            type: 'stream_end',
            data: { chunks_count: chunkIndex, assembled_content: assembledContent, duration_ms: durationMs, tokens },
          };
          await this.emit(endEvent);
          clientRes.end();
          resolve();
        });

        res.on('error', reject);
      });

      req.setTimeout(0); // no timeout — LLM calls can take minutes
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /** Buffered proxy — original behavior for stream:false */
  private async proxyBuffered(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Buffer
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const parsedBody = safeParse(body);

    const reqEvent: RequestEvent = {
      seq: this.seq++,
      t: this.clock.elapsed(),
      type: 'request',
      data: { method, path, headers, body: parsedBody },
    };
    await this.emit(reqEvent);

    const startTime = this.clock.now();
    const response = await this.forward(method, path, headers, body);
    const durationMs = this.clock.now() - startTime;

    const parsedResponseBody = safeParse(response.body);

    // Extract tokens from non-streaming response
    let tokens: TokenUsage | undefined;
    if (parsedResponseBody && typeof parsedResponseBody === 'object') {
      tokens = extractTokens(parsedResponseBody as Record<string, unknown>);
    }

    const resEvent: ResponseEvent = {
      seq: this.seq++,
      t: this.clock.elapsed(),
      type: 'response',
      data: {
        status: response.status,
        headers: response.headers,
        body: parsedResponseBody,
        duration_ms: durationMs,
        tokens,
      },
    };
    await this.emit(resEvent);

    return response;
  }

  get currentSeq(): number {
    return this.seq;
  }

  /** Forward and collect entire response (non-streaming) */
  private forward(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Buffer
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: this.ollamaUrl.hostname,
        port: this.ollamaUrl.port || 11434,
        path,
        method,
        headers: { ...headers, host: this.ollamaUrl.host, 'content-length': String(body.length) },
      };

      const req = httpRequest(opts, (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 500,
            headers: flattenResHeaders(res),
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', reject);
      });

      req.setTimeout(0); // no timeout — LLM calls can take minutes
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /** Forward and collect chunks as parsed NDJSON objects */
  private forwardStream(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Buffer
  ): Promise<{ status: number; headers: Record<string, string>; chunks: unknown[] }> {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: this.ollamaUrl.hostname,
        port: this.ollamaUrl.port || 11434,
        path,
        method,
        headers: { ...headers, host: this.ollamaUrl.host, 'content-length': String(body.length) },
      };

      const req = httpRequest(opts, (res: IncomingMessage) => {
        const chunks: unknown[] = [];
        let buffer = '';

        res.on('data', (raw: Buffer) => {
          buffer += raw.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try { chunks.push(JSON.parse(line)); } catch { /* skip */ }
          }
        });

        res.on('end', () => {
          if (buffer.trim()) {
            try { chunks.push(JSON.parse(buffer)); } catch { /* skip */ }
          }
          resolve({
            status: res.statusCode ?? 500,
            headers: flattenResHeaders(res),
            chunks,
          });
        });

        res.on('error', reject);
      });

      req.setTimeout(0); // no timeout — LLM calls can take minutes
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private async emit(event: ReplayEvent): Promise<void> {
    await this.store.append(this.sessionId, event);
  }
}

// --- Helpers ---

function safeParse(buf: Buffer | string): unknown {
  const str = typeof buf === 'string' ? buf : buf.toString('utf-8');
  try { return JSON.parse(str); } catch { return str; }
}

function flattenResHeaders(res: IncomingMessage): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, val] of Object.entries(res.headers)) {
    if (val) flat[key] = Array.isArray(val) ? val.join(', ') : val;
  }
  return flat;
}

/** Extract token usage from Ollama response (final chunk or non-stream response) */
function extractTokens(data: Record<string, unknown>): TokenUsage | undefined {
  const prompt = data.prompt_eval_count as number | undefined;
  const completion = data.eval_count as number | undefined;
  if (prompt === undefined && completion === undefined) return undefined;

  const evalDuration = data.eval_duration as number | undefined; // nanoseconds
  const tokensPerSecond = (completion && evalDuration)
    ? completion / (evalDuration / 1e9)
    : undefined;

  return {
    prompt_tokens: prompt ?? 0,
    completion_tokens: completion ?? 0,
    total_tokens: (prompt ?? 0) + (completion ?? 0),
    tokens_per_second: tokensPerSecond ? Math.round(tokensPerSecond * 10) / 10 : undefined,
  };
}
