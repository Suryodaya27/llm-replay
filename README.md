# llm-replay (agentlens)

## Highlights

- **Situation:** AI agents make multi-step decisions across LLM calls and tool invocations, but when they fail there's no way to see which step went wrong without manually reading logs.
- **Task:** Built a language-agnostic proxy layer that captures, visualizes, and analyzes AI agent sessions in real-time — without requiring any SDK integration or code changes in the agent.
- **Action:** Designed a transparent HTTP proxy with circuit breaker pattern for resilience, WebSocket-based live event streaming, a conversation parser that extracts structured tool calls from raw HTTP (supporting OpenAI, Anthropic, and Ollama formats), and a post-session issue detector that automatically flags loops, ignored errors, and token waste.
- **Result:** Any AI agent (Python, JS, Go, Rust — any language) can be inspected by changing one URL. The system detects stuck loops, failed tool calls, and wasted tokens automatically, reducing agent debugging time from hours of trace-reading to a single glance at the dashboard.

---

Agent Session Inspector — see what your AI agent did, catch what went wrong, automatically.

## What it does

A transparent HTTP proxy that captures AI agent sessions, shows you the full decision flow in real-time, and flags issues automatically.

```
Any AI Agent (Python/JS/Go/anything) → proxy (:11435) → LLM Provider
                                            ↓
                              Live Dashboard + Issue Detection
```

No SDK. No code changes. One URL change.

## What it catches

The proxy doesn't just record — it analyzes. After each session:

```
⚠️ 2 issues detected                              Health: 50/100

● Agent called "calculate({"query":"GDP / GDP"})" 9 times with
  identical args — stuck in a loop

▲ Tool returned an error at step 4 but agent didn't acknowledge
  it in the next response
```

Issue types detected:
- **Loops** — same tool called with same args repeatedly (agent is stuck)
- **Empty tool args** — model failed to pass required parameters
- **Ignored errors** — tool returned an error, agent continued as if nothing happened
- **Token waste** — duplicate reasoning steps
- **No final answer** — agent hit max iterations without completing

## Circuit Breaker

The proxy protects your agent from hanging when LLM providers go down:

```
Provider healthy:    Agent → Proxy → Ollama → response (normal)
Provider down:       Agent → Proxy → 503 instant (no 5-minute hang)
Provider recovered:  Agent → Proxy → Ollama → response (auto-recovery)
```

Three states: CLOSED (normal) → OPEN (failing fast) → HALF_OPEN (probing recovery).

If Ollama crashes or takes too long, your agent gets an instant 503 with `retry-after` header instead of waiting forever. The proxy auto-recovers when the provider comes back.

## Quick Start

```bash
# 1. Install
git clone https://github.com/Suryodaya27/llm-replay
cd llm-replay
npm install

# 2. Build (backend + dashboard)
npm run build
cd playground && npm install && npm run build && cd ..

# 3. Start everything (API server + proxy + dashboard)
node dist/cli.js ui

# 4. Open http://localhost:3001
```

One command. One port. Dashboard, API, and WebSocket all served from `:3001`.

**Name your session:**

```bash
node dist/cli.js ui --session my-experiment
```

**Run any agent (separate terminal):**

```bash
# Point your agent at localhost:11435 instead of the LLM provider directly
curl http://localhost:11435/api/chat -d '{
  "model": "llama3",
  "messages": [{"role": "user", "content": "What is 2+2?"}],
  "stream": false
}'
```

The **Live** tab shows events streaming in real-time. The **Sessions** tab shows recorded sessions with issue detection.

## Usage

Point your agent at `localhost:11435` instead of the LLM provider. One URL change, any language.

**Ollama (default, no config needed):**

```bash
# Your agent talks to Ollama via the proxy
curl http://localhost:11435/api/chat -d '{
  "model": "llama3",
  "messages": [{"role": "user", "content": "What is 2+2?"}],
  "stream": false
}'
```

**OpenAI:**

```bash
# Set your key, then point agent at the proxy
export OPENAI_API_KEY=sk-...
node dist/cli.js ui --session openai-test
```

```python
# Python — one line change
from openai import OpenAI
client = OpenAI(base_url="http://localhost:11435/v1")
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello"}]
)
```

```typescript
// Node.js — one line change
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'http://localhost:11435/v1' });
```

**Anthropic:**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node dist/cli.js ui --session claude-test
```

```python
# Python — change base_url
import anthropic
client = anthropic.Anthropic(base_url="http://localhost:11435")
```

The proxy auto-routes by model name: `gpt-*` → OpenAI, `claude-*` → Anthropic, everything else → Ollama.

## Features

| Feature | What |
|---|---|
| **Live Dashboard** | Watch agent events stream in real-time via WebSocket |
| **Issue Detection** | Automatically flags loops, errors, token waste |
| **Circuit Breaker** | Fast failure when LLM providers are down, auto-recovery |
| **Session Inspector** | Readable conversation flow with expandable tool I/O |
| **Multi-Provider** | Routes to Ollama, OpenAI, Anthropic by model name |
| **Token Tracking** | Tokens + latency per step, automatic (all providers) |
| **CI Assertions** | `test --assert "contains:X"` — exit 0/1 |
| **Language Agnostic** | Works with any language via HTTP |
| **Named Sessions** | `ui --session my-run` for organized capture |

## Screenshots

| Screenshot | Description |
|---|---|
| ![Inspector](screenshots/inspector.png) | Session inspector showing detected errors and issue analysis |
| ![Live](screenshots/live.png) | Live tab showing real-time WebSocket event output |
| ![Sessions](screenshots/sessions.png) | Sessions tab listing all captured agent sessions |

## Requirements

- Node.js >= 20
- [Ollama](https://ollama.com) running locally (for local models)
- OpenAI/Anthropic API keys (optional, see Environment below)

## Install

```bash
git clone https://github.com/Suryodaya27/llm-replay
cd llm-replay
npm install
npm run build
cd playground && npm install && npm run build && cd ..
npm link  # optional: global command
```

## Environment

Set these to enable OpenAI/Anthropic routing (Ollama works out of the box):

```bash
# Optional — the proxy auto-routes by model name prefix
export OPENAI_API_KEY=sk-...          # routes gpt-*, o1*, o3* models
export ANTHROPIC_API_KEY=sk-ant-...   # routes claude-* models
export OLLAMA_URL=http://localhost:11434  # default, override if needed
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `ui` | Start everything (API + proxy + dashboard on one port) |
| `ui --session <name>` | Start with a named session |
| `capture` | Start capture proxy only |
| `capture --session <id>` | Capture with a named session |
| `replay --session <id>` | Serve recorded responses (for testing agent code) |
| `stats --session <id>` | Token/latency breakdown |
| `test --session <id>` | CI assertions against sessions |
| `judge` | AI-score comparison between two sessions |
| `ls` | List sessions |
| `inspect --session <id>` | View raw events |
| `rm --session <id>` | Delete session |

## Project Structure

```
src/
  index.ts              # Public API barrel
  types.ts              # Shared event types (discriminated union)
  cli.ts                # CLI entry point

  core/                 # Engine
    event-store.ts      # Append-only JSONL persistence
    capture.ts          # HTTP traffic recording
    replay.ts           # Serve recorded responses
    clock.ts            # Real + virtual clocks
    circuit-breaker.ts  # Resilience state machine

  server/               # HTTP layer
    proxy.ts            # Multi-provider proxy server
    api-server.ts       # REST API + static file serving
    live-broadcast.ts   # WebSocket event broadcasting

  analysis/             # Event analysis
    conversation-parser.ts  # Raw events → conversation timeline
    issue-detector.ts       # Automatic issue detection + scoring
    stats.ts                # Token/latency statistics
    judge.ts                # LLM-as-a-judge scoring
    test-runner.ts          # CI assertion runner

  providers/            # LLM provider adapters
    response-format.ts  # Unified response parsing (factory pattern)
    router.ts           # Model name → provider routing
    ollama.ts           # Ollama adapter
    openai.ts           # OpenAI adapter
    anthropic.ts        # Anthropic adapter

  __tests__/            # Unit + integration tests
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│           Dashboard (:3001)                     │
│     Live Tab (WebSocket) │ Sessions Tab         │
│                          │ Issue Detection       │
├──────────────────────────┴──────────────────────┤
│           API Server (:3001)                    │
│  /ws │ /api/sessions │ /api/conversation        │
│  Static files (playground/dist)                 │
└───────────────────────┬─────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────┐
│           Capture Proxy (:11435)                │
│                                                 │
│  ┌─────────────────┐  ┌──────────────────────┐ │
│  │ Circuit Breaker  │  │  Provider Router     │ │
│  │ (fast failure)   │  │  (Ollama/OpenAI/...) │ │
│  └─────────────────┘  └──────────────────────┘ │
│                                                 │
│  ┌─────────────────┐  ┌──────────────────────┐ │
│  │ Event Store      │  │  Response Format     │ │
│  │ (JSONL + WS)     │  │  (factory parser)    │ │
│  └─────────────────┘  └──────────────────────┘ │
└─────────────────────────────────────────────────┘
```

## Design Patterns Used

| Pattern | Where | Why |
|---|---|---|
| **Circuit Breaker** | `core/circuit-breaker.ts` | State machine (closed/open/half_open) prevents cascading failures when providers go down |
| **Factory** | `providers/response-format.ts` | Detects provider format by response shape, extracts content/tokens/tools uniformly |
| **Template Method** | `circuitBreaker.execute(fn)` | Breaker controls lifecycle, caller provides the operation |
| **Sliding Window** | Failure counting | Only recent failures count — prevents a single blip from breaking everything |
| **Strategy** | Provider adapters | Each provider (Ollama/OpenAI/Anthropic) implements same interface, proxy swaps at runtime |
| **Observer** | `store.onEvent` callback | Decouples recording from broadcasting — proxy doesn't know about WebSocket |
| **Discriminated Union** | Event types | TypeScript narrows event shape by `type` field at compile time |
| **Async Generator** | `store.read()` | Streams events without loading entire session into memory |

## Testing

```bash
npm test          # Run all tests (58 tests across 5 files)
```

Tests cover:
- Event store round-trip (JSONL persistence)
- Capture → replay loop (integration, requires Ollama)
- Circuit breaker state machine (all transitions, timeout, sliding window)
- Issue detector (loops, empty args, ignored errors, token waste, scoring)
- Response format factory (OpenAI, Anthropic, Ollama parsing + streaming chunks)

## License

MIT
