/**
 * Re-execution Engine — replays a session through a different model/prompt.
 *
 * Unlike basic branching (which just patches recorded history), this actually
 * calls Ollama with the modified config and records fresh responses.
 *
 * Flow:
 *   1. Load parent session
 *   2. Extract the conversation turns (request bodies)
 *   3. For each turn: modify the request (swap model/prompt), send to Ollama, record response
 *   4. Write all events to a new session
 *
 * This produces a real comparison: same inputs, different model, real outputs.
 */

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { EventStore } from './event-store.js';
import { RealClock } from './clock.js';
import type { BranchPatch, ReplayEvent, RequestEvent, SessionMeta, TokenUsage } from './types.js';

export interface ReExecuteOptions {
  parentSessionId: string;
  patch: BranchPatch;
  store: EventStore;
  ollamaBaseUrl: string;
  newSessionId?: string;
  /** Callback for progress reporting */
  onProgress?: (turn: number, total: number) => void;
}

export interface ReExecuteResult {
  sessionId: string;
  turnsExecuted: number;
  totalTokens: TokenUsage;
  durationMs: number;
}

export async function reExecuteSession(opts: ReExecuteOptions): Promise<ReExecuteResult> {
  const {
    parentSessionId,
    patch,
    store,
    ollamaBaseUrl,
    newSessionId = `reexec-${Date.now()}`,
    onProgress,
  } = opts;

  const clock = new RealClock();
  const ollamaUrl = new URL(ollamaBaseUrl);

  // Load parent session and extract request events
  const parentEvents = await store.readAll(parentSessionId);
  const requests = parentEvents.filter((e): e is RequestEvent => e.type === 'request');

  if (requests.length === 0) {
    throw new Error(`No requests found in session "${parentSessionId}"`);
  }

  // Write meta event
  const meta: SessionMeta = {
    session_id: newSessionId,
    parent_session_id: parentSessionId,
    started_at: new Date().toISOString(),
    mode: 'capture',
    ollama_base_url: ollamaBaseUrl,
    model: patch.model,
  };

  let seq = 0;
  await store.append(newSessionId, { seq: seq++, t: 0, type: 'meta', data: meta });
  clock.reset();

  const totalTokens: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let turnsExecuted = 0;

  for (let i = 0; i < requests.length; i++) {
    onProgress?.(i + 1, requests.length);

    const originalReq = requests[i];
    const modifiedBody = applyPatchToRequest(originalReq.data.body, patch);

    // Force stream:false for re-execution (simpler, we get full response)
    if (typeof modifiedBody === 'object' && modifiedBody !== null) {
      (modifiedBody as Record<string, unknown>).stream = false;
    }

    const bodyBuf = Buffer.from(JSON.stringify(modifiedBody), 'utf-8');

    // Record request
    const reqEvent: ReplayEvent = {
      seq: seq++,
      t: clock.elapsed(),
      type: 'request',
      data: {
        method: originalReq.data.method,
        path: originalReq.data.path,
        headers: { 'content-type': 'application/json' },
        body: modifiedBody,
      },
    };
    await store.append(newSessionId, reqEvent);

    // Call Ollama
    const startTime = clock.now();
    const response = await callOllama(ollamaUrl, originalReq.data.path, bodyBuf);
    const durationMs = clock.now() - startTime;

    // Parse response
    let parsedBody: unknown;
    try { parsedBody = JSON.parse(response.body.toString('utf-8')); } catch { parsedBody = response.body.toString('utf-8'); }

    // Extract tokens
    if (parsedBody && typeof parsedBody === 'object') {
      const data = parsedBody as Record<string, unknown>;
      const prompt = (data.prompt_eval_count as number) ?? 0;
      const completion = (data.eval_count as number) ?? 0;
      totalTokens.prompt_tokens += prompt;
      totalTokens.completion_tokens += completion;
      totalTokens.total_tokens += prompt + completion;
    }

    // Record response
    const resEvent: ReplayEvent = {
      seq: seq++,
      t: clock.elapsed(),
      type: 'response',
      data: {
        status: response.status,
        headers: response.headers,
        body: parsedBody,
        duration_ms: durationMs,
      },
    };
    await store.append(newSessionId, resEvent);
    turnsExecuted++;
  }

  return {
    sessionId: newSessionId,
    turnsExecuted,
    totalTokens,
    durationMs: clock.elapsed(),
  };
}

function applyPatchToRequest(body: unknown, patch: BranchPatch): unknown {
  if (!body || typeof body !== 'object') return body;
  const obj = { ...(body as Record<string, unknown>) };

  if (patch.model) obj.model = patch.model;
  if (patch.temperature !== undefined) {
    obj.options = { ...(obj.options as Record<string, unknown> ?? {}), temperature: patch.temperature };
  }

  if (patch.system_prompt && Array.isArray(obj.messages)) {
    obj.messages = (obj.messages as Array<Record<string, unknown>>).map((msg) =>
      msg.role === 'system' ? { ...msg, content: patch.system_prompt } : msg
    );
  } else if (patch.system_prompt && 'system' in obj) {
    obj.system = patch.system_prompt;
  }

  return obj;
}

function callOllama(
  url: URL,
  path: string,
  body: Buffer
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port || 11434,
      path,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v) headers[k] = Array.isArray(v) ? v.join(', ') : v;
        }
        resolve({ status: res.statusCode ?? 500, headers, body: Buffer.concat(chunks) });
      });
      res.on('error', reject);
    });
    req.setTimeout(0);
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
