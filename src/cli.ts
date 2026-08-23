#!/usr/bin/env node
/**
 * CLI — llm-replay agent session inspector.
 */

import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { startProxy } from './proxy.js';
import { startApiServer } from './api-server.js';
import { EventStore } from './event-store.js';
import { getSessionStats } from './stats.js';
import { runTest, parseAssertionString } from './test-runner.js';
import { judgeSessions } from './judge.js';
import type { Assertion } from './types.js';

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
  .option('-o, --ollama <url>', 'Ollama base URL', DEFAULT_OLLAMA)
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .action(async (opts) => {
    const server = await startApiServer({ port: Number(opts.port), storeDir: opts.storeDir });
    console.log(`[ui] API server running at http://localhost:${server.port}`);
    console.log(`[ui] WebSocket at ws://localhost:${server.port}/ws`);

    const proxyPort = DEFAULT_PORT;
    const captureProxy = await startProxy({
      port: proxyPort,
      mode: 'capture',
      sessionId: `live-${Date.now()}`,
      ollamaBaseUrl: opts.ollama,
      storeDir: opts.storeDir,
      onEvent: (sessionId, event) => {
        server.broadcast.emit({ session_id: sessionId, event });
      },
    });

    console.log(`[ui] Capture proxy on :${proxyPort} (live broadcast enabled)`);
    console.log(`[ui] Playground at http://localhost:5173`);
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
  .action(async (opts) => {
    const sessionId = opts.session ?? `capture-${Date.now()}`;
    const proxy = await startProxy({
      port: Number(opts.port),
      mode: 'capture',
      sessionId,
      ollamaBaseUrl: opts.ollama,
      storeDir: opts.storeDir,
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

// --- JUDGE ---
program
  .command('judge')
  .description('AI-score comparison between two sessions')
  .requiredOption('--a <id>', 'First session ID')
  .requiredOption('--b <id>', 'Second session ID')
  .option('-m, --model <model>', 'Judge model')
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .option('-o, --ollama <url>', 'Ollama base URL', DEFAULT_OLLAMA)
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    const store = new EventStore({ storeDir: opts.storeDir });
    if (!(await store.exists(opts.a))) { console.error(`Session "${opts.a}" not found`); process.exit(1); }
    if (!(await store.exists(opts.b))) { console.error(`Session "${opts.b}" not found`); process.exit(1); }

    const events1 = await store.readAll(opts.a);
    const events2 = await store.readAll(opts.b);
    const turns1 = extractTurns(events1);
    const turns2 = extractTurns(events2);
    const maxLen = Math.min(turns1.length, turns2.length);
    if (maxLen === 0) { console.error('No comparable turns'); process.exit(1); }

    const pairs = [];
    for (let i = 0; i < maxLen; i++) {
      pairs.push({ question: turns1[i].question, responseA: turns1[i].content, responseB: turns2[i].content });
    }

    console.log(`\n[judge] Comparing "${opts.a}" vs "${opts.b}" (${maxLen} turns)`);
    const result = await judgeSessions(pairs, opts.a, opts.b, {
      model: opts.model,
      ollamaUrl: opts.ollama,
      onProgress: (turn, total) => process.stdout.write(`\r[judge] Turn ${turn}/${total}...`),
    });

    if (opts.json) {
      console.log('\n' + JSON.stringify(result, null, 2));
    } else {
      console.log('\n\n' + '═'.repeat(50));
      console.log(`  ${result.overall.summary}`);
      console.log('═'.repeat(50) + '\n');
      for (const t of result.turns) {
        const arrow = t.winner === 'a' ? '◀' : t.winner === 'b' ? '▶' : '=';
        console.log(`  Turn ${t.turnIndex + 1}: ${arrow} ${t.scoreA.total}/10 vs ${t.scoreB.total}/10`);
        if (t.reason) console.log(`    → ${t.reason}`);
      }
    }
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

// --- Helpers ---

interface TurnContent { question: string; content: string; }

function extractTurns(events: { type: string; data: unknown }[]): TurnContent[] {
  const turns: TurnContent[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'request') {
      const reqData = e.data as { body?: { messages?: Array<{ role: string; content: string }> } };
      const lastUser = reqData.body?.messages?.filter(m => m.role === 'user').pop();
      const question = lastUser?.content ?? '';
      for (let j = i + 1; j < events.length; j++) {
        if (events[j].type === 'response') {
          const resData = events[j].data as { body?: { message?: { content?: string } } };
          turns.push({ question, content: resData.body?.message?.content ?? '' });
          break;
        }
        if (events[j].type === 'stream_end') {
          const seData = events[j].data as { assembled_content?: string };
          turns.push({ question, content: seData.assembled_content ?? '' });
          break;
        }
        if (events[j].type === 'request') break;
      }
    }
  }
  return turns;
}
