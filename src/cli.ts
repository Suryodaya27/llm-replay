#!/usr/bin/env node
/**
 * CLI — user-facing interface to the replay engine.
 *
 * Design pattern: Command pattern (via Commander.js)
 * Each subcommand is a self-contained action with its own options.
 * The CLI is a thin shell — all logic lives in the modules.
 */

import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { startProxy } from './proxy.js';
import { startApiServer } from './api-server.js';
import { EventStore } from './event-store.js';
import { getSessionStats } from './stats.js';
import { reExecuteSession } from './re-execute.js';
import { runTest, parseAssertionString } from './test-runner.js';
import { judgeSessions } from './judge.js';
import type { Assertion, BranchPatch } from './types.js';

const DEFAULT_PORT = 11435;
const DEFAULT_OLLAMA = 'http://localhost:11434';

const program = new Command();

program
  .name('llm-replay')
  .description('Deterministic replay engine for AI agents')
  .version('0.1.0');

// --- CAPTURE ---
program
  .command('capture')
  .description('Start proxy in capture mode — records all traffic to a session file')
  .option('-p, --port <port>', 'Proxy listen port', String(DEFAULT_PORT))
  .option('-s, --session <id>', 'Session ID (default: auto-generated)')
  .option('-o, --ollama <url>', 'Ollama base URL', DEFAULT_OLLAMA)
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .option('-t, --tag <tags...>', 'Tags for the session')
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
    console.log(`[capture] Forwarding to: ${opts.ollama}`);
    console.log(`[capture] Providers: ${proxy.router.list().join(', ')}`);
    console.log(`[capture] Point your agent at http://localhost:${proxy.port}`);
    console.log(`[capture] Accepts: /api/chat (Ollama) and /v1/chat/completions (OpenAI format)`);
    console.log(`[capture] Press Ctrl+C to stop`);

    process.on('SIGINT', async () => {
      console.log(`\n[capture] Stopping...`);
      await proxy.close();
      process.exit(0);
    });
  });

// --- REPLAY ---
program
  .command('replay')
  .description('Start proxy in replay mode — serves recorded responses from a session')
  .option('-p, --port <port>', 'Proxy listen port', String(DEFAULT_PORT))
  .requiredOption('-s, --session <id>', 'Session ID to replay')
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .option('--strict', 'Reject requests that drift from recording', false)
  .action(async (opts) => {
    const store = new EventStore({ storeDir: opts.storeDir });
    if (!(await store.exists(opts.session))) {
      console.error(`[replay] Session "${opts.session}" not found`);
      process.exit(1);
    }

    const proxy = await startProxy({
      port: Number(opts.port),
      mode: 'replay',
      sessionId: opts.session,
      ollamaBaseUrl: DEFAULT_OLLAMA, // unused in replay but required by type
      storeDir: opts.storeDir,
      strict: opts.strict,
    });
    console.log(`[replay] Proxy listening on :${proxy.port}`);
    console.log(`[replay] Replaying session: ${proxy.sessionId}`);
    console.log(`[replay] Point your agent at http://localhost:${proxy.port}`);
    console.log(`[replay] Press Ctrl+C to stop`);

    process.on('SIGINT', async () => {
      console.log(`\n[replay] Stopping...`);
      await proxy.close();
      process.exit(0);
    });
  });

// --- BRANCH ---
program
  .command('branch')
  .description('Fork a session at a specific event and continue with modifications')
  .option('-p, --port <port>', 'Proxy listen port', String(DEFAULT_PORT))
  .requiredOption('--parent <id>', 'Parent session ID to branch from')
  .requiredOption('--at <seq>', 'Sequence number to branch at')
  .option('-s, --session <id>', 'New session ID (default: auto-generated)')
  .option('-o, --ollama <url>', 'Ollama base URL', DEFAULT_OLLAMA)
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .option('--patch <file>', 'JSON file with branch patches')
  .option('--model <model>', 'Override model name')
  .option('--prompt <text>', 'Override system prompt')
  .action(async (opts) => {
    const store = new EventStore({ storeDir: opts.storeDir });
    if (!(await store.exists(opts.parent))) {
      console.error(`[branch] Parent session "${opts.parent}" not found`);
      process.exit(1);
    }

    // Build patch from CLI args and/or patch file
    let patch: BranchPatch = {};
    if (opts.patch) {
      const content = await readFile(opts.patch, 'utf-8');
      patch = JSON.parse(content);
    }
    if (opts.model) patch.model = opts.model;
    if (opts.prompt) patch.system_prompt = opts.prompt;

    const sessionId = opts.session ?? `branch-${Date.now()}`;
    const proxy = await startProxy({
      port: Number(opts.port),
      mode: 'branch',
      sessionId,
      ollamaBaseUrl: opts.ollama,
      storeDir: opts.storeDir,
      parentSessionId: opts.parent,
      branchAt: Number(opts.at),
      patch,
    });
    console.log(`[branch] Proxy listening on :${proxy.port}`);
    console.log(`[branch] Branched from "${opts.parent}" at seq ${opts.at}`);
    console.log(`[branch] New session: ${proxy.sessionId}`);
    console.log(`[branch] Point your agent at http://localhost:${proxy.port}`);
    console.log(`[branch] Press Ctrl+C to stop`);

    process.on('SIGINT', async () => {
      console.log(`\n[branch] Stopping...`);
      await proxy.close();
      process.exit(0);
    });
  });

// --- LIST ---
program
  .command('ls')
  .description('List all recorded sessions')
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .action(async (opts) => {
    const store = new EventStore({ storeDir: opts.storeDir });
    const sessions = await store.list();

    if (sessions.length === 0) {
      console.log('No sessions found.');
      return;
    }

    console.log(`Sessions (${sessions.length}):\n`);
    for (const id of sessions) {
      const meta = await store.getMeta(id);
      const count = await store.count(id);
      const mode = meta?.mode ?? '?';
      const model = meta?.model ?? 'unknown';
      const parent = meta?.parent_session_id ? ` (branch of ${meta.parent_session_id})` : '';
      console.log(`  ${id}  [${mode}] ${count} events, model: ${model}${parent}`);
    }
  });

// --- INSPECT ---
program
  .command('inspect')
  .description('Show events from a session')
  .requiredOption('-s, --session <id>', 'Session ID')
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .option('-n, --limit <n>', 'Max events to show', '50')
  .option('--type <type>', 'Filter by event type')
  .action(async (opts) => {
    const store = new EventStore({ storeDir: opts.storeDir });
    if (!(await store.exists(opts.session))) {
      console.error(`Session "${opts.session}" not found`);
      process.exit(1);
    }

    let count = 0;
    const limit = Number(opts.limit);

    for await (const event of store.read(opts.session)) {
      if (opts.type && event.type !== opts.type) continue;
      if (count >= limit) {
        console.log(`\n... (showing first ${limit} events, use --limit to see more)`);
        break;
      }
      printEvent(event);
      count++;
    }

    if (count === 0) {
      console.log('No events match the filter.');
    }
  });

// --- DELETE ---
program
  .command('rm')
  .description('Delete a session')
  .requiredOption('-s, --session <id>', 'Session ID to delete')
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .action(async (opts) => {
    const store = new EventStore({ storeDir: opts.storeDir });
    if (!(await store.exists(opts.session))) {
      console.error(`Session "${opts.session}" not found`);
      process.exit(1);
    }
    await store.delete(opts.session);
    console.log(`Deleted session: ${opts.session}`);
  });

// --- STATS ---
program
  .command('stats')
  .description('Show token usage, latency, and cost stats for a session')
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

// --- RE-EXECUTE ---
program
  .command('reexec')
  .description('Re-execute a session with a different model/prompt (actually calls Ollama)')
  .requiredOption('--parent <id>', 'Parent session ID')
  .option('-s, --session <id>', 'New session ID')
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .option('-o, --ollama <url>', 'Ollama base URL', DEFAULT_OLLAMA)
  .option('--model <model>', 'Override model')
  .option('--prompt <text>', 'Override system prompt')
  .option('--temperature <n>', 'Override temperature')
  .action(async (opts) => {
    const store = new EventStore({ storeDir: opts.storeDir });
    if (!(await store.exists(opts.parent))) {
      console.error(`Session "${opts.parent}" not found`);
      process.exit(1);
    }

    const patch: BranchPatch = {};
    if (opts.model) patch.model = opts.model;
    if (opts.prompt) patch.system_prompt = opts.prompt;
    if (opts.temperature) patch.temperature = Number(opts.temperature);

    console.log(`[reexec] Re-executing "${opts.parent}" with ${opts.model ?? 'same model'}...`);

    const result = await reExecuteSession({
      parentSessionId: opts.parent,
      patch,
      store,
      ollamaBaseUrl: opts.ollama,
      newSessionId: opts.session,
      onProgress: (turn, total) => {
        process.stdout.write(`\r[reexec] Turn ${turn}/${total}...`);
      },
    });

    console.log(`\n[reexec] Done.`);
    console.log(`  New session: ${result.sessionId}`);
    console.log(`  Turns: ${result.turnsExecuted}`);
    console.log(`  Tokens: ${result.totalTokens.total_tokens}`);
    console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`\n  Compare with: node dist/cli.js inspect --session ${result.sessionId}`);
  });

// --- TEST (CI mode) ---
program
  .command('test')
  .description('Run assertions against a recorded session (CI-friendly, exit code 0/1)')
  .requiredOption('-s, --session <id>', 'Session ID to test')
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .option('-a, --assert <assertions...>', 'Assertions in "type:value" format (e.g. "contains:hello")')
  .option('--assert-file <file>', 'JSON file with assertion array')
  .option('--json', 'Output results as JSON')
  .action(async (opts) => {
    const store = new EventStore({ storeDir: opts.storeDir });
    if (!(await store.exists(opts.session))) {
      console.error(`Session "${opts.session}" not found`);
      process.exit(1);
    }

    // Build assertions from CLI args and/or file
    let assertions: Assertion[] = [];
    if (opts.assert) {
      assertions = (opts.assert as string[]).map(parseAssertionString);
    }
    if (opts.assertFile) {
      const content = await readFile(opts.assertFile, 'utf-8');
      const fileAssertions = JSON.parse(content) as Assertion[];
      assertions = [...assertions, ...fileAssertions];
    }

    if (assertions.length === 0) {
      console.error('No assertions provided. Use --assert or --assert-file.');
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
        const desc = `${r.assertion.type}:${r.assertion.value}`;
        console.log(`${icon} ${desc}`);
        if (!r.passed && r.message) {
          console.log(`    ${r.message}`);
        }
      }

      console.log(`\nStats: ${result.stats.total_turns} turns, ${result.stats.total_tokens.total_tokens} tokens, ${(result.stats.total_duration_ms / 1000).toFixed(1)}s`);
    }

    process.exit(result.passed ? 0 : 1);
  });

// --- JUDGE ---
program
  .command('judge')
  .description('Use AI to score and compare two sessions (LLM-as-a-judge)')
  .requiredOption('--a <id>', 'First session ID')
  .requiredOption('--b <id>', 'Second session ID')
  .option('-m, --model <model>', 'Judge model (default: minicpm-v4.6:latest)')
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .option('-o, --ollama <url>', 'Ollama base URL', DEFAULT_OLLAMA)
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    const store = new EventStore({ storeDir: opts.storeDir });
    if (!(await store.exists(opts.a))) { console.error(`Session "${opts.a}" not found`); process.exit(1); }
    if (!(await store.exists(opts.b))) { console.error(`Session "${opts.b}" not found`); process.exit(1); }

    // Extract turns from both sessions
    const events1 = await store.readAll(opts.a);
    const events2 = await store.readAll(opts.b);
    const turns1 = extractResponseContents(events1);
    const turns2 = extractResponseContents(events2);

    const maxLen = Math.min(turns1.length, turns2.length);
    if (maxLen === 0) { console.error('No comparable turns found'); process.exit(1); }

    const pairs = [];
    for (let i = 0; i < maxLen; i++) {
      pairs.push({
        question: turns1[i].question,
        responseA: turns1[i].content,
        responseB: turns2[i].content,
      });
    }

    console.log(`\n[judge] Comparing "${opts.a}" vs "${opts.b}" (${maxLen} turns)`);
    console.log(`[judge] Using model: ${opts.model ?? 'minicpm-v4.6:latest'}\n`);

    const result = await judgeSessions(pairs, opts.a, opts.b, {
      model: opts.model,
      ollamaUrl: opts.ollama,
      onProgress: (turn, total) => {
        process.stdout.write(`\r[judge] Evaluating turn ${turn}/${total}...`);
      },
    });

    if (opts.json) {
      console.log('\n' + JSON.stringify(result, null, 2));
    } else {
      console.log('\n');
      console.log('═'.repeat(50));
      console.log(`  ${result.overall.summary}`);
      console.log('═'.repeat(50));
      console.log('');

      for (const t of result.turns) {
        const arrow = t.winner === 'a' ? '◀' : t.winner === 'b' ? '▶' : '=';
        console.log(`  Turn ${t.turnIndex + 1}: ${arrow} ${t.scoreA.total}/10 vs ${t.scoreB.total}/10`);
        console.log(`    "${t.question.slice(0, 70)}..."`);
        if (t.reason) console.log(`    → ${t.reason}`);
        console.log('');
      }
    }
  });

// --- UI / API SERVER ---
program
  .command('ui')
  .description('Start the playground API server for the web UI')
  .option('-p, --port <port>', 'API server port', '3001')
  .option('-d, --store-dir <dir>', 'Session storage directory')
  .action(async (opts) => {
    const server = await startApiServer({ port: Number(opts.port), storeDir: opts.storeDir });
    console.log(`[ui] API server running at http://localhost:${server.port}`);
    console.log(`[ui] Playground at http://localhost:5173 (start with: cd playground && npm run dev)`);
    console.log(`[ui] Press Ctrl+C to stop`);

    process.on('SIGINT', async () => {
      console.log(`\n[ui] Stopping...`);
      await server.close();
      process.exit(0);
    });
  });

program.parse();

// --- Helpers ---

interface TurnContent {
  question: string;
  content: string;
}

function extractResponseContents(events: { type: string; data: unknown }[]): TurnContent[] {
  const turns: TurnContent[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'request') {
      const reqData = e.data as { body?: { messages?: Array<{ role: string; content: string }> } };
      const lastUser = reqData.body?.messages?.filter(m => m.role === 'user').pop();
      const question = lastUser?.content ?? '';

      // Find matching response or stream_end
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
        if (events[j].type === 'request') break; // next request without response
      }
    }
  }
  return turns;
}

function printEvent(event: { seq: number; t: number; type: string; data: unknown }): void {
  const time = `+${event.t}ms`.padEnd(10);
  const seq = `#${event.seq}`.padEnd(5);

  switch (event.type) {
    case 'meta':
      console.log(`${seq} ${time} [meta] Session started`);
      break;
    case 'request': {
      const d = event.data as { method: string; path: string };
      console.log(`${seq} ${time} [req]  ${d.method} ${d.path}`);
      break;
    }
    case 'response': {
      const d = event.data as { status: number; duration_ms: number };
      console.log(`${seq} ${time} [res]  ${d.status} (${d.duration_ms}ms)`);
      break;
    }
    case 'tool_call': {
      const d = event.data as { name: string };
      console.log(`${seq} ${time} [tool] → ${d.name}`);
      break;
    }
    case 'tool_result': {
      const d = event.data as { name: string; duration_ms: number; error?: string };
      const status = d.error ? `✗ ${d.error}` : '✓';
      console.log(`${seq} ${time} [tool] ← ${d.name} ${status} (${d.duration_ms}ms)`);
      break;
    }
    case 'error': {
      const d = event.data as { message: string };
      console.log(`${seq} ${time} [err]  ${d.message}`);
      break;
    }
    default:
      console.log(`${seq} ${time} [${event.type}]`);
  }
}
