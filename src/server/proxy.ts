/**
 * HTTP Proxy Server — multi-provider, multi-session.
 *
 * Supports:
 * - Multiple LLM providers (Ollama, OpenAI, Anthropic) via ProviderRouter
 * - Multi-session routing via X-Session-Id header
 * - Capture / Replay / Branch modes
 * - Streaming passthrough
 *
 * The proxy accepts requests in OpenAI format (/v1/chat/completions)
 * OR Ollama format (/api/chat). It detects which, routes to the right
 * provider, and records everything.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { EventStore } from '../core/event-store.js';
import { RealClock } from '../core/clock.js';
import { CaptureSession } from '../core/capture.js';
import { ReplaySession } from '../core/replay.js';
import { CircuitBreaker, CircuitOpenError } from '../core/circuit-breaker.js';
import { ProviderRouter, routerConfigFromEnv } from '../providers/index.js';
import type { ChatRequest, RouterConfig } from '../providers/index.js';
import type { ProxyMode, ReplayEvent } from '../types.js';

const SESSION_HEADER = 'x-session-id';

export interface ProxyConfig {
  port: number;
  mode: ProxyMode;
  sessionId: string;
  ollamaBaseUrl: string;
  storeDir?: string;
  strict?: boolean;
  routerConfig?: RouterConfig;
  onEvent?: (sessionId: string, event: ReplayEvent) => void;
  /** Request timeout in ms for the circuit breaker (0 = no timeout). Default: 120000 */
  requestTimeout?: number;
}

export interface ProxyInstance {
  port: number;
  mode: ProxyMode;
  sessionId: string;
  activeSessions: () => string[];
  router: ProviderRouter;
  circuitBreaker: CircuitBreaker;
  close: () => Promise<void>;
}

export async function startProxy(config: ProxyConfig): Promise<ProxyInstance> {
  const store = new EventStore({ storeDir: config.storeDir });
  await store.init();
  if (config.onEvent) store.onEvent = config.onEvent;

  // Build provider router
  const routerCfg = config.routerConfig ?? routerConfigFromEnv();
  // Ensure ollama provider uses the configured URL
  if (routerCfg.providers.ollama) {
    routerCfg.providers.ollama.baseUrl = config.ollamaBaseUrl;
  }
  const router = new ProviderRouter(routerCfg);

  // Resilience layers
  const cbTimeout = config.requestTimeout ?? 120_000;
  const circuitBreaker = new CircuitBreaker(cbTimeout === 0 ? { requestTimeout: Number.MAX_SAFE_INTEGER } : { requestTimeout: cbTimeout });

  // Session pools
  const captureSessions = new Map<string, CaptureSession>();
  const replaySessions = new Map<string, ReplaySession>();
  // In-memory seq counters for provider-routed captures (avoids re-reading JSONL)
  const providerSeqCounters = new Map<string, number>();

  function getCaptureSession(sessionId: string): CaptureSession {
    let session = captureSessions.get(sessionId);
    if (!session) {
      session = new CaptureSession({
        sessionId,
        ollamaBaseUrl: config.ollamaBaseUrl,
        clock: new RealClock(),
        store,
      });
      captureSessions.set(sessionId, session);
    }
    return session;
  }

  function getReplaySession(sessionId: string): ReplaySession {
    let session = replaySessions.get(sessionId);
    if (!session) {
      session = new ReplaySession({ sessionId, store, strict: config.strict });
      replaySessions.set(sessionId, session);
    }
    return session;
  }

  function resolveSessionId(headers: Record<string, string>): string {
    return headers[SESSION_HEADER] ?? config.sessionId;
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
      const headers = flattenHeaders(req.headers);
      const method = req.method ?? 'GET';
      const path = req.url ?? '/';
      const sessionId = resolveSessionId(headers);
      const isStream = isStreamingRequest(body);

      // Detect request format and extract model for routing
      const format = detectFormat(path, body);
      const model = extractModel(body);

      switch (config.mode) {
        case 'capture': {
          // If request is in OpenAI format and target isn't Ollama, use provider directly
          if (format === 'openai' && model && !isOllamaModel(model, router)) {
            await circuitBreaker.execute(() =>
              handleProviderCapture(sessionId, model!, body, isStream, store, router, res, providerSeqCounters)
            );
          } else {
            // Default: forward to Ollama via CaptureSession
            const session = getCaptureSession(sessionId);
            if (isStream) {
              await circuitBreaker.execute(() =>
                session.proxyStreamToResponse(method, path, headers, body, res)
              );
            } else {
              const result = await circuitBreaker.execute(() =>
                session.proxy(method, path, headers, body)
              );
              res.writeHead(result.status, result.headers);
              res.end(result.body);
            }
          }
          break;
        }

        case 'replay': {
          const session = getReplaySession(sessionId);
          const result = await session.serve(method, path, headers, body);

          if (session.driftWarnings.length > 0) {
            const latest = session.driftWarnings[session.driftWarnings.length - 1];
            process.stderr.write(`[replay:${sessionId}] drift at seq ${latest.seq}: ${latest.field} mismatch\n`);
          }

          if (isStream) {
            res.writeHead(result.status, { ...result.headers, 'transfer-encoding': 'chunked' });
          } else {
            res.writeHead(result.status, result.headers);
          }
          res.end(result.body);
          break;
        }
      }
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) });
        res.end(JSON.stringify({ error: 'circuit_open', message: err.message, retry_after_ms: err.retryAfterMs }));
        return;
      }
      const message = err instanceof Error ? err.message : 'Internal proxy error';
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy_error', message }));
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(config.port, () => {
      resolve({
        port: config.port,
        mode: config.mode,
        sessionId: config.sessionId,
        activeSessions: () => [...captureSessions.keys(), ...replaySessions.keys()],
        router,
        circuitBreaker,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// --- Provider-routed capture (for non-Ollama models) ---

async function handleProviderCapture(
  sessionId: string,
  model: string,
  body: Buffer,
  isStream: boolean,
  store: EventStore,
  router: ProviderRouter,
  res: ServerResponse,
  seqCounters: Map<string, number>,
): Promise<void> {
  const provider = router.resolve(model);
  const chatReq = parseChatRequest(body);
  const clock = new RealClock();

  // Use in-memory counter — no JSONL scan
  let seq = seqCounters.get(sessionId) ?? 0;

  // Record request
  await store.append(sessionId, {
    seq: seq++,
    t: clock.elapsed(),
    type: 'request' as const,
    data: { method: 'POST', path: '/v1/chat/completions', headers: {}, body: JSON.parse(body.toString('utf-8')) },
  });

  if (isStream) {
    // Streaming via provider
    res.writeHead(200, { 'content-type': 'text/event-stream', 'transfer-encoding': 'chunked' });
    let assembled = '';
    let chunkCount = 0;
    const start = Date.now();

    for await (const chunk of provider.chatStream(chatReq)) {
      assembled += chunk.content;
      chunkCount++;

      // Forward SSE to client
      const sseData = JSON.stringify(chunk.raw);
      res.write(`data: ${sseData}\n\n`);

      // Record chunk
      await store.append(sessionId, {
        seq: seq++,
        t: clock.elapsed(),
        type: 'stream_chunk',
        data: { index: chunk.index, chunk: chunk.raw },
      });

      if (chunk.done) break;
    }

    res.write('data: [DONE]\n\n');
    res.end();

    // Record stream_end
    await store.append(sessionId, {
      seq: seq++,
      t: clock.elapsed(),
      type: 'stream_end',
      data: { chunks_count: chunkCount, assembled_content: assembled, duration_ms: Date.now() - start },
    });
  } else {
    // Buffered via provider
    const response = await provider.chat(chatReq);

    // Record response
    await store.append(sessionId, {
      seq: seq++,
      t: clock.elapsed(),
      type: 'response',
      data: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: response.raw,
        duration_ms: response.latency_ms,
        tokens: response.tokens,
      },
    });

    // Send to client in OpenAI format
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response.raw));
  }

  // Persist counter for next call
  seqCounters.set(sessionId, seq);
}

// --- Utilities ---

function isStreamingRequest(body: Buffer): boolean {
  try {
    return JSON.parse(body.toString('utf-8')).stream === true;
  } catch {
    return false;
  }
}

type RequestFormat = 'ollama' | 'openai' | 'unknown';

function detectFormat(path: string, _body: Buffer): RequestFormat {
  if (path.startsWith('/v1/')) return 'openai';
  if (path.startsWith('/api/')) return 'ollama';
  return 'unknown';
}

function extractModel(body: Buffer): string | null {
  try {
    const parsed = JSON.parse(body.toString('utf-8'));
    return parsed.model ?? null;
  } catch {
    return null;
  }
}

function isOllamaModel(model: string, router: ProviderRouter): boolean {
  const provider = router.resolve(model);
  return provider.name === 'ollama';
}

function parseChatRequest(body: Buffer): ChatRequest {
  const parsed = JSON.parse(body.toString('utf-8'));
  return {
    model: parsed.model ?? '',
    messages: parsed.messages ?? [],
    stream: parsed.stream ?? false,
    temperature: parsed.temperature,
    max_tokens: parsed.max_tokens,
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function flattenHeaders(raw: IncomingMessage['headers']): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (val) flat[key] = Array.isArray(val) ? val.join(', ') : val;
  }
  return flat;
}
