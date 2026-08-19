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
import { EventStore } from './event-store.js';
import { RealClock } from './clock.js';
import { CaptureSession } from './capture.js';
import { ReplaySession } from './replay.js';
import { createBranch } from './branch.js';
import { ProviderRouter, routerConfigFromEnv, defaultRouterConfig } from './providers/index.js';
import type { Provider, ChatRequest, RouterConfig } from './providers/index.js';
import type { ProxyMode, BranchPatch } from './types.js';

const SESSION_HEADER = 'x-session-id';

export interface ProxyConfig {
  port: number;
  mode: ProxyMode;
  sessionId: string;
  ollamaBaseUrl: string;
  storeDir?: string;
  strict?: boolean;
  branchAt?: number;
  patch?: BranchPatch;
  parentSessionId?: string;
  /** Provider routing config. If omitted, auto-detects from env vars. */
  routerConfig?: RouterConfig;
}

export interface ProxyInstance {
  port: number;
  mode: ProxyMode;
  sessionId: string;
  activeSessions: () => string[];
  router: ProviderRouter;
  close: () => Promise<void>;
}

export async function startProxy(config: ProxyConfig): Promise<ProxyInstance> {
  const store = new EventStore({ storeDir: config.storeDir });
  await store.init();

  // Build provider router
  const routerCfg = config.routerConfig ?? routerConfigFromEnv();
  // Ensure ollama provider uses the configured URL
  if (routerCfg.providers.ollama) {
    routerCfg.providers.ollama.baseUrl = config.ollamaBaseUrl;
  }
  const router = new ProviderRouter(routerCfg);

  // Session pools
  const captureSessions = new Map<string, CaptureSession>();
  const replaySessions = new Map<string, ReplaySession>();

  // Branch setup
  let branchCaptureSession: CaptureSession | null = null;
  if (config.mode === 'branch') {
    if (!config.parentSessionId || config.branchAt === undefined || !config.patch) {
      throw new Error('Branch mode requires parentSessionId, branchAt, and patch');
    }
    const branch = await createBranch({
      parentSessionId: config.parentSessionId,
      branchAt: config.branchAt,
      patch: config.patch,
      store,
      ollamaBaseUrl: config.ollamaBaseUrl,
      newSessionId: config.sessionId,
    });
    branchCaptureSession = branch.captureSession;
  }

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
            await handleProviderCapture(sessionId, model, body, isStream, store, router, res);
          } else {
            // Default: forward to Ollama via CaptureSession (existing behavior)
            const session = getCaptureSession(sessionId);
            if (isStream) {
              await session.proxyStreamToResponse(method, path, headers, body, res);
            } else {
              const result = await session.proxy(method, path, headers, body);
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

        case 'branch': {
          if (!branchCaptureSession) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Branch session not initialized' }));
            return;
          }
          if (isStream) {
            await branchCaptureSession.proxyStreamToResponse(method, path, headers, body, res);
          } else {
            const result = await branchCaptureSession.proxy(method, path, headers, body);
            res.writeHead(result.status, result.headers);
            res.end(result.body);
          }
          break;
        }
      }
    } catch (err) {
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
): Promise<void> {
  const provider = router.resolve(model);
  const chatReq = parseChatRequest(body);
  const clock = new RealClock();

  // Record request
  const reqEvent = {
    seq: 0, // will be set by store order
    t: clock.elapsed(),
    type: 'request' as const,
    data: { method: 'POST', path: '/v1/chat/completions', headers: {}, body: JSON.parse(body.toString('utf-8')) },
  };
  await store.append(sessionId, { ...reqEvent, seq: await nextSeq(store, sessionId) });

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
        seq: await nextSeq(store, sessionId),
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
      seq: await nextSeq(store, sessionId),
      t: clock.elapsed(),
      type: 'stream_end',
      data: { chunks_count: chunkCount, assembled_content: assembled, duration_ms: Date.now() - start },
    });
  } else {
    // Buffered via provider
    const response = await provider.chat(chatReq);

    // Record response
    await store.append(sessionId, {
      seq: await nextSeq(store, sessionId),
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

async function nextSeq(store: EventStore, sessionId: string): Promise<number> {
  return await store.count(sessionId);
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
