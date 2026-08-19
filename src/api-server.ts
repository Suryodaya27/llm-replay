/**
 * API Server — exposes replay engine operations over HTTP for the UI.
 *
 * Endpoints:
 *   GET  /api/sessions          — list all sessions
 *   GET  /api/sessions/:id      — get session events
 *   DELETE /api/sessions/:id    — delete session
 *   GET  /api/models            — list available Ollama models
 *   POST /api/branch            — create a branch from a session
 *   POST /api/capture/start     — start a capture proxy
 *   POST /api/capture/stop      — stop running capture proxy
 *   GET  /api/diff/:id1/:id2    — diff two sessions side by side
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { EventStore } from './event-store.js';
import { createBranch } from './branch.js';
import { reExecuteSession } from './re-execute.js';
import { startProxy, type ProxyInstance } from './proxy.js';
import { routerConfigFromEnv } from './providers/index.js';
import { judgeSessions } from './judge.js';
import type { BranchPatch, ReplayEvent, ResponseEvent } from './types.js';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

export interface ApiServerOptions {
  port?: number;
  storeDir?: string;
}

export async function startApiServer(opts?: ApiServerOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const port = opts?.port ?? 3001;
  const store = new EventStore({ storeDir: opts?.storeDir });
  await store.init();

  let activeProxy: ProxyInstance | null = null;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const path = url.pathname;

      // --- Routes ---

      // List sessions (newest first)
      if (path === '/api/sessions' && req.method === 'GET') {
        const sessions = await store.list();
        const result = await Promise.all(sessions.map(async (id) => {
          const meta = await store.getMeta(id);
          const count = await store.count(id);
          return { id, meta, eventCount: count };
        }));
        result.sort((a, b) => {
          const dateA = a.meta?.started_at ?? '';
          const dateB = b.meta?.started_at ?? '';
          return dateB.localeCompare(dateA);
        });
        json(res, result);
        return;
      }

      // Get session events
      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch && req.method === 'GET') {
        const id = decodeURIComponent(sessionMatch[1]);
        if (!(await store.exists(id))) {
          json(res, { error: 'Session not found' }, 404);
          return;
        }
        const events = await store.readAll(id);
        json(res, { id, events });
        return;
      }

      // Delete session
      if (sessionMatch && req.method === 'DELETE') {
        const id = decodeURIComponent(sessionMatch[1]);
        if (!(await store.exists(id))) {
          json(res, { error: 'Session not found' }, 404);
          return;
        }
        await store.delete(id);
        json(res, { deleted: id });
        return;
      }

      // List Ollama models
      if (path === '/api/models' && req.method === 'GET') {
        try {
          const ollamaRes = await fetch(`${OLLAMA_URL}/api/tags`);
          const data = await ollamaRes.json() as { models: Array<{ name: string; size: number; modified_at: string }> };
          json(res, data.models ?? []);
        } catch {
          json(res, { error: 'Cannot reach Ollama', url: OLLAMA_URL }, 502);
        }
        return;
      }

      // List providers
      if (path === '/api/providers' && req.method === 'GET') {
        const routerCfg = routerConfigFromEnv();
        const providers = Object.entries(routerCfg.providers).map(([name, cfg]) => ({
          name,
          type: cfg.type,
          baseUrl: cfg.baseUrl,
          hasApiKey: !!cfg.apiKey,
          routes: Object.entries(routerCfg.routes)
            .filter(([, p]) => p === name)
            .map(([prefix]) => `${prefix}*`),
        }));
        json(res, providers);
        return;
      }

      // Create branch
      if (path === '/api/branch' && req.method === 'POST') {
        const body = await readBody(req);
        const { parentSessionId, branchAt, patch, newSessionId } = JSON.parse(body) as {
          parentSessionId: string;
          branchAt: number;
          patch: BranchPatch;
          newSessionId?: string;
        };

        if (!parentSessionId || branchAt === undefined || !patch) {
          json(res, { error: 'Missing parentSessionId, branchAt, or patch' }, 400);
          return;
        }

        const sessionId = newSessionId ?? `branch-${Date.now()}`;
        const branch = await createBranch({
          parentSessionId,
          branchAt,
          patch,
          store,
          ollamaBaseUrl: OLLAMA_URL,
          newSessionId: sessionId,
        });

        json(res, {
          sessionId: branch.sessionId,
          eventsKept: branch.eventsKept,
          patchesApplied: branch.patchesApplied,
        });
        return;
      }

      // Re-execute session with different model/prompt (actually calls Ollama)
      if (path === '/api/reexec' && req.method === 'POST') {
        const body = await readBody(req);
        const { parentSessionId, patch, newSessionId } = JSON.parse(body) as {
          parentSessionId: string;
          patch: BranchPatch;
          newSessionId?: string;
        };

        if (!parentSessionId || !patch) {
          json(res, { error: 'Missing parentSessionId or patch' }, 400);
          return;
        }

        if (!(await store.exists(parentSessionId))) {
          json(res, { error: `Session "${parentSessionId}" not found` }, 404);
          return;
        }

        const result = await reExecuteSession({
          parentSessionId,
          patch,
          store,
          ollamaBaseUrl: OLLAMA_URL,
          newSessionId,
        });

        json(res, {
          sessionId: result.sessionId,
          turnsExecuted: result.turnsExecuted,
          totalTokens: result.totalTokens,
          durationMs: result.durationMs,
        });
        return;
      }

      // Start capture proxy
      if (path === '/api/capture/start' && req.method === 'POST') {
        if (activeProxy) {
          json(res, { error: 'Capture proxy already running', sessionId: activeProxy.sessionId }, 409);
          return;
        }
        const body = await readBody(req);
        const { sessionId, proxyPort } = JSON.parse(body) as { sessionId?: string; proxyPort?: number };
        const sid = sessionId ?? `capture-${Date.now()}`;

        activeProxy = await startProxy({
          port: proxyPort ?? 11435,
          mode: 'capture',
          sessionId: sid,
          ollamaBaseUrl: OLLAMA_URL,
          storeDir: opts?.storeDir,
        });
        json(res, { sessionId: sid, port: activeProxy.port, status: 'running' });
        return;
      }

      // Stop capture proxy
      if (path === '/api/capture/stop' && req.method === 'POST') {
        if (!activeProxy) {
          json(res, { error: 'No active proxy' }, 404);
          return;
        }
        const sid = activeProxy.sessionId;
        await activeProxy.close();
        activeProxy = null;
        json(res, { sessionId: sid, status: 'stopped' });
        return;
      }

      // Diff two sessions
      const diffMatch = path.match(/^\/api\/diff\/([^/]+)\/([^/]+)$/);
      if (diffMatch && req.method === 'GET') {
        const id1 = decodeURIComponent(diffMatch[1]);
        const id2 = decodeURIComponent(diffMatch[2]);

        if (!(await store.exists(id1)) || !(await store.exists(id2))) {
          json(res, { error: 'One or both sessions not found' }, 404);
          return;
        }

        const events1 = await store.readAll(id1);
        const events2 = await store.readAll(id2);

        const turns1 = extractTurns(events1);
        const turns2 = extractTurns(events2);

        const diff = buildDiff(turns1, turns2, id1, id2);
        json(res, diff);
        return;
      }

      // Judge two sessions (LLM-as-a-judge scoring)
      if (path === '/api/judge' && req.method === 'POST') {
        const body = await readBody(req);
        const { session1, session2, judgeModel } = JSON.parse(body) as {
          session1: string;
          session2: string;
          judgeModel?: string;
        };

        if (!session1 || !session2) {
          json(res, { error: 'Missing session1 or session2' }, 400);
          return;
        }

        if (!(await store.exists(session1)) || !(await store.exists(session2))) {
          json(res, { error: 'One or both sessions not found' }, 404);
          return;
        }

        const events1 = await store.readAll(session1);
        const events2 = await store.readAll(session2);
        const turns1 = extractTurns(events1);
        const turns2 = extractTurns(events2);

        // Build comparison pairs
        const pairs = [];
        const maxLen = Math.min(turns1.length, turns2.length);
        for (let i = 0; i < maxLen; i++) {
          pairs.push({
            question: turns1[i].request.content,
            responseA: turns1[i].response.content,
            responseB: turns2[i].response.content,
          });
        }

        if (pairs.length === 0) {
          json(res, { error: 'No comparable turns found' }, 400);
          return;
        }

        const result = await judgeSessions(pairs, session1, session2, {
          model: judgeModel,
          ollamaUrl: OLLAMA_URL,
        });

        json(res, result);
        return;
      }

      // 404
      json(res, { error: 'Not found', path }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      json(res, { error: message }, 500);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      resolve({
        port,
        close: () => new Promise<void>((r) => {
          if (activeProxy) activeProxy.close().then(() => server.close(() => r()));
          else server.close(() => r());
        }),
      });
    });
  });
}

// --- Helpers ---

interface Turn {
  index: number;
  request: { role: string; content: string; model?: string };
  response: { content: string; duration_ms: number };
}

function extractTurns(events: ReplayEvent[]): Turn[] {
  const turns: Turn[] = [];
  let turnIndex = 0;

  for (let i = 0; i < events.length - 1; i++) {
    const curr = events[i];
    const next = events[i + 1];
    if (curr.type === 'request' && next.type === 'response') {
      const reqBody = curr.data.body as Record<string, unknown> | undefined;
      const messages = (reqBody?.messages as Array<{ role: string; content: string }>) ?? [];
      const lastUser = messages.filter((m) => m.role === 'user').pop();
      const model = reqBody?.model as string | undefined;

      const resBody = next.data.body as Record<string, unknown> | undefined;
      const assistantMsg = resBody?.message as { content?: string } | undefined;

      turns.push({
        index: turnIndex++,
        request: {
          role: 'user',
          content: lastUser?.content ?? '',
          model,
        },
        response: {
          content: assistantMsg?.content ?? JSON.stringify(resBody),
          duration_ms: next.data.duration_ms,
        },
      });
      i++; // skip response
    }
  }
  return turns;
}

function buildDiff(turns1: Turn[], turns2: Turn[], id1: string, id2: string) {
  const maxLen = Math.max(turns1.length, turns2.length);
  const comparisons = [];

  for (let i = 0; i < maxLen; i++) {
    const t1 = turns1[i] ?? null;
    const t2 = turns2[i] ?? null;
    comparisons.push({
      turnIndex: i,
      session1: t1 ? { session: id1, ...t1 } : null,
      session2: t2 ? { session: id2, ...t2 } : null,
      differs: t1 && t2 ? t1.response.content !== t2.response.content : true,
    });
  }

  return {
    session1: id1,
    session2: id2,
    totalTurns: maxLen,
    comparisons,
  };
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
