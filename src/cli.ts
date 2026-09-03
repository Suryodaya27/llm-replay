#!/usr/bin/env node
/**
 * CLI — llm-replay agent session inspector.
 */

import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startProxy } from './server/proxy.js';
import { startApiServer } from './server/api-server.js';
import { EventStore } from './core/event-store.js';
import { getSessionStats } from './analysis/stats.js';
import { runTest, parseAssertionString } from './analysis/test-runner.js';
import type { Assertion } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_PORT = 11435;
const DEFAULT_OLLAMA = 'http://localhost:11434';

const program = new Command();

program
  .name('llm-replay')
  .description('Agent Session Inspector — capture and visualize AI agent sessions')
  .version('0.2.0');

// --- UI (start everything) ---
program
  .command('ui')
  .description('Start the dashboard (API server + capture proxy + live WebSocket)')
  .option('-p, --port <port>', 'API server port', '3001')
  .option('-s, --session <id>', 'Session name (default: auto-generated)')
  .option('-o, --ollama <url>', 'Ollama base URL', DEFAULT_OLLAMA)
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .option('-t, --timeout <ms>', 'Request timeout in ms (0 = no timeout)', '0')
  .action(async (opts) => {
    // Resolve playground build dir (relative to package root, not cwd)
    const playgroundDir = resolve(__dirname, '..', 'playground', 'dist');
    const hasPlayground = existsSync(playgroundDir);

    const server = await startApiServer({
      port: Number(opts.port),
      storeDir: opts.storeDir,
      playgroundDir: hasPlayground ? playgroundDir : undefined,
    });
    console.log(`[ui] API server running at http://localhost:${server.port}`);
    console.log(`[ui] WebSocket at ws://localhost:${server.port}/ws`);

    const proxyPort = DEFAULT_PORT;
    const sessionId = opts.session ?? `live-${Date.now()}`;
    const captureProxy = await startProxy({
      port: proxyPort,
      mode: 'capture',
      sessionId,
      ollamaBaseUrl: opts.ollama,
      storeDir: opts.storeDir,
      requestTimeout: Number(opts.timeout),
      onEvent: (sessionId: string, event: { seq: number; t: number; type: string; data: unknown }) => {
        server.broadcast.emit({ session_id: sessionId, event });
      },
    });

    console.log(`[ui] Capture proxy on :${proxyPort} → session "${sessionId}"`);
    if (hasPlayground) {
      console.log(`[ui] Dashboard at http://localhost:${server.port}`);
    } else {
      console.log(`[ui] No playground build found. Run: cd playground && npm run build`);
      console.log(`[ui] Or use Vite dev server: cd playground && npm run dev`);
    }
    console.log(`[ui] Press Ctrl+C to stop`);

    process.on('SIGINT', () => {
      console.log(`\n[ui] Stopping...`);
      captureProxy.close().then(() => server.close()).then(() => process.exit(0)).catch(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000);
    });
  });

// --- CAPTURE ---
program
  .command('capture')
  .description('Start proxy in capture mode — records all LLM traffic')
  .option('-p, --port <port>', 'Proxy listen port', String(DEFAULT_PORT))
  .option('-s, --session <id>', 'Session ID (default: auto-generated)')
  .option('-o, --ollama <url>', 'Ollama base URL', DEFAULT_OLLAMA)
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .option('-t, --timeout <ms>', 'Request timeout in ms (0 = no timeout)', '0')
  .action(async (opts) => {
    const sessionId = opts.session ?? `capture-${Date.now()}`;
    const proxy = await startProxy({
      port: Number(opts.port),
      mode: 'capture',
      sessionId,
      ollamaBaseUrl: opts.ollama,
      storeDir: opts.storeDir,
      requestTimeout: Number(opts.timeout),
    });
    console.log(`[capture] Proxy listening on :${proxy.port}`);
    console.log(`[capture] Session: ${proxy.sessionId}`);
    console.log(`[capture] Providers: ${proxy.router.list().join(', ')}`);
    console.log(`[capture] Point your agent at http://localhost:${proxy.port}`);
    console.log(`[capture] Press Ctrl+C to stop`);

    process.on('SIGINT', () => {
      console.log(`\n[capture] Stopping...`);
      proxy.close().then(() => process.exit(0)).catch(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000);
    });
  });

// --- REPLAY ---
program
  .command('replay')
  .description('Serve recorded responses (for testing agent code without LLM)')
  .option('-p, --port <port>', 'Proxy listen port', String(DEFAULT_PORT))
  .requiredOption('-s, --session <id>', 'Session ID to replay')
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .option('--strict', 'Reject requests that drift from recording', false)
  .action(async (opts) => {
    const store = new EventStore({ storeDir: opts.storeDir });
    if (!(await store.exists(opts.session))) {
      console.error(`Session "${opts.session}" not found`);
      process.exit(1);
    }
    const proxy = await startProxy({
      port: Number(opts.port),
      mode: 'replay',
      sessionId: opts.session,
      ollamaBaseUrl: DEFAULT_OLLAMA,
      storeDir: opts.storeDir,
      strict: opts.strict,
    });
    console.log(`[replay] Serving session: ${proxy.sessionId} on :${proxy.port}`);
    console.log(`[replay] Press Ctrl+C to stop`);

    process.on('SIGINT', () => {
      proxy.close().then(() => process.exit(0)).catch(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000);
    });
  });

// --- STATS ---
program
  .command('stats')
  .description('Show token usage, latency, and per-turn breakdown')
  .requiredOption('-s, --session <id>', 'Session ID')
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .action(async (opts) => {
    const store = new EventStore({ storeDir: opts.storeDir });
    if (!(await store.exists(opts.session))) {
      console.error(`Session "${opts.session}" not found`);
      process.exit(1);
    }
    const stats = await getSessionStats(opts.session, store);
    console.log(`\nSession: ${stats.session_id}`);
    console.log(`Model:   ${stats.model ?? 'unknown'}`);
    console.log(`Turns:   ${stats.total_turns}`);
    console.log(`\n--- Tokens ---`);
    console.log(`  Prompt:     ${stats.total_tokens.prompt_tokens}`);
    console.log(`  Completion: ${stats.total_tokens.completion_tokens}`);
    console.log(`  Total:      ${stats.total_tokens.total_tokens}`);
    console.log(`\n--- Latency ---`);
    console.log(`  Total:   ${(stats.total_duration_ms / 1000).toFixed(1)}s`);
    console.log(`  Average: ${(stats.avg_latency_ms / 1000).toFixed(1)}s per turn`);
    if (stats.turns.length > 0) {
      console.log(`\n--- Per Turn ---`);
      for (const turn of stats.turns) {
        const tokens = turn.prompt_tokens + turn.completion_tokens;
        const stream = turn.streamed ? ' [streamed]' : '';
        console.log(`  Turn ${turn.index + 1}: ${tokens} tokens, ${(turn.latency_ms / 1000).toFixed(1)}s${stream}`);
      }
    }
    console.log('');
  });

// --- TEST ---
program
  .command('test')
  .description('Run assertions against a session (CI-friendly, exit 0/1)')
  .requiredOption('-s, --session <id>', 'Session ID to test')
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .option('-a, --assert <assertions...>', 'Assertions in "type:value" format')
  .option('--assert-file <file>', 'JSON file with assertion array')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    const store = new EventStore({ storeDir: opts.storeDir });
    if (!(await store.exists(opts.session))) {
      console.error(`Session "${opts.session}" not found`);
      process.exit(1);
    }
    let assertions: Assertion[] = [];
    if (opts.assert) assertions = (opts.assert as string[]).map(parseAssertionString);
    if (opts.assertFile) {
      const content = await readFile(opts.assertFile, 'utf-8');
      assertions = [...assertions, ...JSON.parse(content)];
    }
    if (assertions.length === 0) {
      console.error('No assertions. Use --assert or --assert-file.');
      process.exit(1);
    }
    const result = await runTest({ sessionId: opts.session, store, assertions });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\nTest: ${result.session_id}`);
      console.log(`Status: ${result.passed ? '✓ PASSED' : '✗ FAILED'}\n`);
      for (const r of result.assertions) {
        const icon = r.passed ? '  ✓' : '  ✗';
        console.log(`${icon} ${r.assertion.type}:${r.assertion.value}`);
        if (!r.passed && r.message) console.log(`    ${r.message}`);
      }
    }
    process.exit(result.passed ? 0 : 1);
  });

// --- LS ---
program
  .command('ls')
  .description('List all sessions')
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .action(async (opts) => {
    const store = new EventStore({ storeDir: opts.storeDir });
    const sessions = await store.list();
    if (sessions.length === 0) { console.log('No sessions.'); return; }
    console.log(`\nSessions (${sessions.length}):\n`);
    for (const id of sessions) {
      const meta = await store.getMeta(id);
      const count = await store.count(id);
      const model = meta?.model ?? 'unknown';
      console.log(`  ${id}  [${meta?.mode ?? '?'}] ${count} events, model: ${model}`);
    }
  });

// --- INSPECT ---
program
  .command('inspect')
  .description('Show raw events from a session')
  .requiredOption('-s, --session <id>', 'Session ID')
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .option('-n, --limit <n>', 'Max events', '50')
  .option('--type <type>', 'Filter by event type')
  .action(async (opts) => {
    const store = new EventStore({ storeDir: opts.storeDir });
    if (!(await store.exists(opts.session))) { console.error(`Not found`); process.exit(1); }
    let count = 0;
    const limit = Number(opts.limit);
    for await (const event of store.read(opts.session)) {
      if (opts.type && event.type !== opts.type) continue;
      if (count >= limit) { console.log(`\n... (${limit} shown, use --limit for more)`); break; }
      const time = `+${event.t}ms`.padEnd(12);
      console.log(`#${String(event.seq).padEnd(5)} ${time} [${event.type}]`);
      count++;
    }
  });

// --- RM ---
program
  .command('rm')
  .description('Delete a session')
  .requiredOption('-s, --session <id>', 'Session ID')
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .action(async (opts) => {
    const store = new EventStore({ storeDir: opts.storeDir });
    if (!(await store.exists(opts.session))) { console.error(`Not found`); process.exit(1); }
    await store.delete(opts.session);
    console.log(`Deleted: ${opts.session}`);
  });

program.parse();
