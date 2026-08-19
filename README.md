# llm-replay

Deterministic replay engine for AI agents. Capture, replay, branch, test, and judge any LLM agent session across Ollama, OpenAI, and Anthropic.

## What it does

A transparent HTTP proxy between your AI agent and the LLM provider. Five core capabilities:

- **Capture** — records every request, response, and stream chunk to a JSONL session file
- **Replay** — serves cached responses instantly. The agent relives the same conversation without hitting the LLM.
- **Re-execute** — replay the same inputs through a different model and get real new responses
- **Test** — run assertions against recorded sessions in CI. Exit code 0/1. No LLM needed.
- **Judge** — AI evaluates which model's outputs are better across accuracy, safety, relevance, completeness, conciseness, and coherence

Plus a **web playground** for visual timeline inspection, one-click model comparison, and AI-powered scoring.

## Why

| Without llm-replay | With llm-replay |
|---|---|
| "Why did the agent do that?" → 4 hours of log archaeology | Replay the session in 0.5s, see exact inputs/outputs |
| "Would a different model be better?" → manually re-run everything | `reexec --model mistral` and compare side-by-side |
| "Did my prompt change break anything?" → vibes-based testing | `test --assert "contains:async"` in CI, exit code 1 on regression |
| "Which model is actually better for my use case?" → subjective opinions | `judge --a session1 --b session2` — AI scores on 6 criteria |
| Streaming agents can't be recorded | Full NDJSON chunk capture and replay |
| Multiple parallel agents need multiple ports | One proxy, `X-Session-Id` header routes to separate sessions |
| Switching between OpenAI/Claude/Ollama needs code changes | One proxy, routes by model name automatically |

## Requirements

- Node.js >= 20
- [Ollama](https://ollama.com) running locally (for local models)
- OpenAI API key (optional, for GPT models)
- Anthropic API key (optional, for Claude models)

## Install

```bash
git clone <repo-url>
cd llm-replay
npm install
npm run build
npm link  # makes `llm-replay` command available globally
```

### Provider Setup

```bash
# Ollama — works out of the box, no config needed

# OpenAI (optional)
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com  # or any OpenAI-compatible API

# Anthropic (optional)
export ANTHROPIC_API_KEY=sk-ant-...
```

The proxy auto-detects which providers are available from env vars.

## Quick Start

### 1. Capture a session

```bash
llm-replay capture --session my-run
```

Your agent points at `localhost:11435`. The proxy accepts both `/api/chat` (Ollama) and `/v1/chat/completions` (OpenAI format), routing by model name:

- `gpt-*`, `o1*`, `o3*` → OpenAI
- `claude-*` → Anthropic
- Everything else → Ollama

Works with `stream: true` and `stream: false`.

### 2. Replay instantly

```bash
llm-replay replay --session my-run
```

Same agent, same output, under 1 second. No LLM calls.

### 3. Re-execute with a different model

```bash
llm-replay reexec --parent my-run --model minicpm-v4.6:latest --session my-run-minicpm
```

Actually calls the new model with the same inputs. Produces a real session for comparison.

### 4. Judge which model is better

```bash
llm-replay judge --a my-run --b my-run-minicpm
```

Output:
```
══════════════════════════════════════════════════
  my-run: 6.1/10 avg | my-run-minicpm: 5.4/10 avg | Winner: my-run (5-1-1)
══════════════════════════════════════════════════

  Turn 1: ◀ 7.2/10 vs 5.8/10
    "Review this code and list all bugs..."
    → A provides more specific technical details with accurate references

  Turn 2: ◀ 6.5/10 vs 5.1/10
    "Write the corrected version..."
    → A's fix handles more edge cases

  Turn 3: = 5.0/10 vs 5.0/10
    "Give a one-line summary..."
    → Both adequate, similar quality
```

The judge evaluates each turn on 6 criteria:

| Criteria | What it measures |
|---|---|
| **Accuracy** | Factual correctness, hallucination detection |
| **Completeness** | Coverage of the topic |
| **Conciseness** | Clear and direct, no fluff |
| **Safety** | No harmful advice, bias, or dangerous suggestions |
| **Relevance** | Actually answers the question asked |
| **Coherence** | Logical structure, internal consistency |

Note: The judge uses an LLM (default: minicpm-v4.6) to score. Scores may vary slightly between runs due to LLM non-determinism. Use `--model` to pick a stronger judge model for more consistent results.

### 5. Compare stats

```bash
llm-replay stats --session my-run
llm-replay stats --session my-run-minicpm
```

### 6. CI/CD assertions

```bash
llm-replay test --session my-run --assert "contains:async" "not_contains:error" "max_latency_ms:60000"
# Exit code: 0 (pass) or 1 (fail)
```

### 7. Parallel agents

One proxy handles multiple agents via `X-Session-Id` header:

```python
requests.post("http://localhost:11435/api/chat",
    headers={"X-Session-Id": "agent-search"},
    json={"model": "qwen3.6", "messages": [...]})
```

Each session ID gets its own recording file.

### 8. Web Playground

```bash
llm-replay ui                    # API server on :3001
cd playground && npm run dev     # React UI on :5173
```

Features:
- Session list with model info
- Event timeline with "Branch here" buttons
- One-click re-execution with model picker
- Side-by-side diff view
- AI judge with per-turn scoring and verdict

## CLI Reference

| Command | Description |
|---------|-------------|
| `capture` | Start proxy in capture mode |
| `replay` | Start proxy in replay mode |
| `branch` | Fork a session with patches |
| `reexec` | Re-execute through a different model |
| `judge` | AI-score comparison between two sessions |
| `stats` | Token usage and latency breakdown |
| `test` | CI assertions (exit 0/1) |
| `ls` | List sessions |
| `inspect` | View raw events |
| `rm` | Delete a session |
| `ui` | Start playground API server |

### judge options

| Flag | Description |
|------|-------------|
| `--a <id>` | First session |
| `--b <id>` | Second session |
| `-m, --model <model>` | Judge model (default: minicpm-v4.6:latest) |
| `--json` | Output as JSON |

## Architecture

```
┌─────────────────────────────────────────────┐
│         Web Playground (:5173)              │
│   Sessions │ Timeline │ Diff │ Judge        │
└───────────────────────┬─────────────────────┘
                        │
┌───────────────────────▼─────────────────────┐
│            API Server (:3001)                │
└───────────────────────┬─────────────────────┘
                        │
┌───────────────────────▼─────────────────────┐
│           Replay Proxy (:11435)             │
│                                             │
│  Provider Router:                           │
│    gpt-* / o1* / o3*  → OpenAI adapter     │
│    claude-*            → Anthropic adapter  │
│    *                   → Ollama adapter     │
│                                             │
│  Session Router (X-Session-Id header)       │
│  Modes: Capture │ Replay │ Branch           │
└──────────┬──────────┬──────────┬────────────┘
           │          │          │
           ▼          ▼          ▼
       Ollama     OpenAI     Anthropic
```

## Project Structure

```
llm-replay/
├── src/
│   ├── types.ts             # Event schema + assertion types
│   ├── event-store.ts       # JSONL persistence
│   ├── clock.ts             # Real + Virtual clock
│   ├── capture.ts           # Streaming + buffered capture
│   ├── replay.ts            # Streaming + buffered replay
│   ├── branch.ts            # Timeline forking
│   ├── re-execute.ts        # Model re-execution
│   ├── stats.ts             # Token/latency extraction
│   ├── test-runner.ts       # CI assertion engine
│   ├── judge.ts             # LLM-as-a-judge scoring
│   ├── proxy.ts             # Multi-provider proxy
│   ├── api-server.ts        # REST API
│   ├── cli.ts               # CLI commands
│   ├── index.ts             # Public API
│   └── providers/
│       ├── types.ts         # Provider interface
│       ├── router.ts        # Model → provider routing
│       ├── ollama.ts
│       ├── openai.ts
│       └── anthropic.ts
├── playground/              # React web UI
├── examples/
│   └── code-reviewer.ts    # Demo agent
├── package.json
└── tsconfig.json
```

## Programmatic API

```typescript
import {
  startProxy, EventStore, reExecuteSession,
  getSessionStats, runTest, judgeSessions,
  ProviderRouter, routerConfigFromEnv
} from 'llm-replay';

// Capture
const proxy = await startProxy({
  port: 11435, mode: 'capture',
  sessionId: 'my-session', ollamaBaseUrl: 'http://localhost:11434',
});

// Re-execute
const store = new EventStore();
await reExecuteSession({
  parentSessionId: 'my-session',
  patch: { model: 'mistral' },
  store, ollamaBaseUrl: 'http://localhost:11434',
});

// Judge
const judgment = await judgeSessions(turns, 'session-a', 'session-b', {
  model: 'minicpm-v4.6:latest',
});
console.log(judgment.overall.summary);

// CI test
const test = await runTest({
  sessionId: 'my-session', store,
  assertions: [{ type: 'contains', value: 'async' }],
});
process.exit(test.passed ? 0 : 1);
```

## Design Decisions

Key choices made and why — useful for explaining the architecture to others.

### Why a proxy instead of an SDK?

An SDK requires modifying agent code. A proxy is transparent — point any agent at `localhost:11435` regardless of language, framework, or LLM library. Python, TypeScript, Go, curl — all work without changes. The agent doesn't know it's being recorded.

### Why JSONL for storage?

- **Append-only** — writes never corrupt existing data, even on crash
- **Streamable** — read million-event sessions line-by-line without loading into RAM
- **Greppable** — `grep "error" session.jsonl` works from the terminal
- **No database dependency** — one file per session, copy/share/delete trivially

Trade-off: no indexing or querying. Acceptable because sessions are typically <10K events and read sequentially.

### Why provider adapters instead of a universal format?

Each LLM API has quirks (Anthropic's top-level system prompt, Ollama's options format, OpenAI's streaming SSE). Adapters isolate these differences behind one `Provider` interface. Adding a new provider is one file, no existing code changes. The proxy doesn't know or care what's behind the adapter.

### Why deterministic judging (seed: 42, temperature: 0)?

LLM-as-a-judge is inherently non-deterministic. Without pinning seed and temperature, the same comparison produces different winners on different runs. This undermines trust. By setting `seed: 42` and `temperature: 0`, the judge produces identical scores for identical inputs — the winner is always the same. Trade-off: slightly less nuanced scoring (zero temperature reduces exploration), but consistency matters more for evaluation.

### Why re-execute instead of just branching?

Branch only patches recorded history — it swaps the model name in existing events but doesn't call the new model. Useful for testing prompt changes against the same cached output. Re-execute actually calls the new model with the same inputs and records fresh responses. This is what you need for real model comparison.

### Why multi-session routing via header?

Multi-agent systems run N agents in parallel. Without routing, all traffic interleaves into one session file and replay breaks. The `X-Session-Id` header lets each agent self-identify. One proxy, one port, N sessions. If no header is sent, falls back to the CLI-specified session ID (backwards compatible).

### Why token tracking at the proxy level?

Ollama includes token counts in every response (`prompt_eval_count`, `eval_count`). We extract and store them per-turn. This means you get cost/performance data without any instrumentation in your agent code — the proxy captures it automatically.

### Why stream chunks are recorded individually?

Streaming responses arrive as NDJSON lines (one token-batch per line). Recording each chunk preserves the exact timing and order the agent experienced. During replay, the same chunks are served back. The agent can't tell the difference between a live stream and a recorded one.

### Why the event store uses async generators?

Sessions can grow large (thousands of stream chunks). Loading everything into memory for every read would blow RAM on big sessions. Async generators (`for await (const event of store.read(...))`) stream events one-by-one with constant memory usage.

### Why CI assertions instead of snapshot testing?

Snapshot testing (exact output match) breaks constantly because LLMs produce slightly different wording each run. Assertions like `contains:async` or `max_latency_ms:5000` are stable — they check properties of the output, not exact text. This makes tests resilient to model upgrades and prompt tweaks.

## Tests

```bash
npm test  # 8 tests (unit + integration)
```

Integration tests use local Ollama and skip gracefully when unavailable.

## Roadmap

- [x] Streaming capture and replay
- [x] Real model re-execution
- [x] Token/cost tracking
- [x] CI assertion runner
- [x] Web playground with diff view
- [x] Multi-session routing
- [x] Multi-provider support (Ollama, OpenAI, Anthropic)
- [x] LLM-as-a-judge scoring (6 criteria)
- [ ] Batch eval mode (N sessions x M models)
- [ ] Deterministic judging (seed + multi-run averaging)
- [ ] Session export as portable test fixtures
- [ ] Prompt versioning + A/B testing

## License

MIT
