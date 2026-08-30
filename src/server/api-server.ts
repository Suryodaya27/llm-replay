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
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { EventStore } from '../core/event-store.js';
import { startProxy, type ProxyInstance } from './proxy.js';
import { routerConfigFromEnv } from '../providers/index.js';
import { parseConversation } from '../analysis/conversation-parser.js';
import { detectIssues } from '../analysis/issue-detector.js';
import { getSessionStats } from '../analysis/stats.js';
import { runBranch } from '../core/branch.js';
import { LiveBroadcast } from './live-broadcast.js';
import type { ReplayEvent } from '../types.js';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

export interface ApiServerOptions {
  port?: number;
  storeDir?: string;
  /** Path to built playground directory (serves static UI when set) */
  playgroundDir?: string;
}

export async function startApiServer(opts?: ApiServerOptions): Promise<{ port: number; broadcast: LiveBroadcast; close: () => Promise<void> }> {
  const port = opts?.port ?? 3001;
  const store = new EventStore({ storeDir: opts?.storeDir });
  await store.init();

  let activeProxy: ProxyInstance | null = null;
  let broadcast: LiveBroadcast | null = null;
  let hookBroadcastEnabled = false; // off by default — enable via API

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

      // Get parsed conversation (readable timeline)
      const convMatch = path.match(/^\/api\/sessions\/([^/]+)\/conversation$/);
      if (convMatch && req.method === 'GET') {
        const id = decodeURIComponent(convMatch[1]);
        if (!(await store.exists(id))) {
          json(res, { error: 'Session not found' }, 404);
          return;
        }
        const events = await store.readAll(id);
        const parsed = parseConversation(id, events);
        const issues = detectIssues(parsed);
        json(res, { ...parsed, issues: issues.issues, healthScore: issues.score });
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

      // Compare two sessions (summary-level)
      const compareMatch = path.match(/^\/api\/compare\/([^/]+)\/([^/]+)$/);
      if (compareMatch && req.method === 'GET') {
        const id1 = decodeURIComponent(compareMatch[1]);
        const id2 = decodeURIComponent(compareMatch[2]);

        if (!(await store.exists(id1)) || !(await store.exists(id2))) {
          json(res, { error: 'One or both sessions not found' }, 404);
          return;
        }

        const [events1, events2] = await Promise.all([store.readAll(id1), store.readAll(id2)]);
        const [parsed1, parsed2] = [parseConversation(id1, events1), parseConversation(id2, events2)];
        const [issues1, issues2] = [detectIssues(parsed1), detectIssues(parsed2)];
        const [stats1, stats2] = await Promise.all([getSessionStats(id1, store), getSessionStats(id2, store)]);

        const buildSummary = (
          id: string,
          parsed: typeof parsed1,
          issues: typeof issues1,
          statsData: typeof stats1,
        ) => ({
          sessionId: id,
          model: parsed.model || 'unknown',
          outcome: parsed.summary.outcome,
          finalAnswer: parsed.steps.filter(s => s.type === 'answer').map(s => s.content).pop() ?? null,
          totalTokens: statsData.total_tokens.total_tokens,
          promptTokens: statsData.total_tokens.prompt_tokens,
          completionTokens: statsData.total_tokens.completion_tokens,
          totalTurns: statsData.total_turns,
          avgLatencyMs: statsData.avg_latency_ms,
          totalDurationMs: statsData.total_duration_ms,
          toolCalls: parsed.summary.tool_calls,
          toolsUsed: parsed.summary.tools_used,
          healthScore: issues.score,
          issueCount: issues.issues.length,
          issues: issues.issues.map(i => ({ severity: i.severity, type: i.type, message: i.message })),
          totalSteps: parsed.summary.total_steps,
        });

        json(res, {
          session1: buildSummary(id1, parsed1, issues1, stats1),
          session2: buildSummary(id2, parsed2, issues2, stats2),
        });
        return;
      }

      // Hook status check (used by Kiro hook to decide whether to broadcast)
      if (path === '/api/hook/status' && req.method === 'GET') {
        json(res, { active: hookBroadcastEnabled });
        return;
      }

      // Toggle hook broadcasting on/off
      if (path === '/api/hook/toggle' && req.method === 'POST') {
        hookBroadcastEnabled = !hookBroadcastEnabled;
        json(res, { active: hookBroadcastEnabled });
        return;
      }

      // Enable hook broadcasting
      if (path === '/api/hook/enable' && req.method === 'POST') {
        hookBroadcastEnabled = true;
        json(res, { active: true });
        return;
      }

      // Disable hook broadcasting
      if (path === '/api/hook/disable' && req.method === 'POST') {
        hookBroadcastEnabled = false;
        json(res, { active: false });
        return;
      }

      // Receive hook events (from Kiro hooks, MCP, etc.)
      if (path === '/api/hook/event' && req.method === 'POST') {
        if (!hookBroadcastEnabled) {
          json(res, { received: false, reason: 'broadcasting disabled' });
          return;
        }
        const body = await readBody(req);
        try {
          const hookData = JSON.parse(body);
          if (broadcast) {
            // Determine event type from hook data
            let eventType = 'user';
            let content = '';

            if (hookData.toolName) {
              eventType = 'tool_call';
              content = hookData.toolName;
            } else if (hookData.hook_event_name === 'Stop') {
              eventType = 'session';
              content = 'Agent finished';
            } else if (hookData.hook_event_name === 'UserPromptSubmit') {
              eventType = 'user';
              content = hookData.userPrompt ?? hookData.prompt ?? hookData.content ?? '';
            } else if (hookData.userPrompt || hookData.prompt) {
              eventType = 'user';
              content = hookData.userPrompt ?? hookData.prompt ?? '';
            } else {
              eventType = 'session';
              content = hookData.hook_event_name ?? JSON.stringify(hookData).slice(0, 200);
            }

            broadcast.emit({
              session_id: 'kiro-live',
              event: {
                seq: Date.now(),
                t: 0, // will be normalized by LiveView
                type: eventType,
                data: { content, raw: hookData },
              },
            });
          }
          json(res, { received: true });
        } catch {
          json(res, { error: 'Invalid JSON' }, 400);
        }
        return;
      }

      // Branch: edit a step and re-run from that point with the real LLM
      if (path === '/api/branch' && req.method === 'POST') {
        const body = await readBody(req);
        const { sessionId: branchFrom, stepIndex, editedContent, newSessionId } = JSON.parse(body) as {
          sessionId: string;
          stepIndex: number;
          editedContent: string;
          newSessionId?: string;
        };

        if (!branchFrom || stepIndex === undefined || !editedContent) {
          json(res, { error: 'Missing sessionId, stepIndex, or editedContent' }, 400);
          return;
        }

        if (!(await store.exists(branchFrom))) {
          json(res, { error: 'Session not found' }, 404);
          return;
        }

        try {
          const { routerConfigFromEnv } = await import('../providers/index.js');
          const { ProviderRouter } = await import('../providers/router.js');
          const routerCfg = routerConfigFromEnv();
          const router = new ProviderRouter(routerCfg);

          const result = await runBranch({
            sessionId: branchFrom,
            stepIndex,
            editedContent,
            newSessionId,
            store,
            router,
            ollamaBaseUrl: OLLAMA_URL,
          });

          json(res, result);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Branch failed';
          json(res, { error: message }, 500);
        }
        return;
      }

      // Serve playground static files (if configured)
      if (opts?.playgroundDir) {
        const served = await serveStatic(opts.playgroundDir, path, res);
        if (served) return;
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
      broadcast = new LiveBroadcast(server);
      resolve({
        port,
        broadcast,
        close: () => new Promise<void>((r) => {
          if (activeProxy) activeProxy.close().then(() => server.close(() => r()));
          else server.close(() => r());
        }),
      });
    });
  });
}

// --- Helpers ---

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(dir: string, urlPath: string, res: ServerResponse): Promise<boolean> {
  // Map / to /index.html
  const filePath = join(dir, urlPath === '/' ? 'index.html' : urlPath);

  // Prevent path traversal
  if (!filePath.startsWith(dir)) return false;

  try {
    const s = await stat(filePath);
    if (!s.isFile()) {
      // SPA fallback: serve index.html for non-file paths
      const indexPath = join(dir, 'index.html');
      if (existsSync(indexPath)) {
        res.writeHead(200, { 'content-type': 'text/html' });
        createReadStream(indexPath).pipe(res);
        return true;
      }
      return false;
    }
    const mime = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime });
    createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
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
