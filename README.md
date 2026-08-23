# llm-replay

Agent Session Inspector — see exactly what your AI agent did, step by step, in real-time.

## What it does

A transparent HTTP proxy that captures all LLM traffic from any AI agent and presents it as a readable conversation flow. Watch your agent think, call tools, and produce answers — live in the browser or after the fact.

```
Your Agent (any language) → proxy (:11435) → Ollama / OpenAI / Anthropic
                                ↓
                    Live Dashboard + Session Recording
```

No SDK. No code changes. Just point your agent's HTTP at the proxy.

## Quick Start

**One command starts everything:**

```bash
cd llm-replay
npm run build
node dist/cli.js ui
```

This starts:
- API server on `:3001`
- Live WebSocket on `ws://localhost:3001/ws`
- Capture proxy on `:11435`

**Open the dashboard:**

```bash
cd playground && npm run dev
# Open http://localhost:5173
```

**Run any agent:**

```bash
# Point your agent at localhost:11435 instead of localhost:11434
MODEL=minicpm-v4.6:latest npx tsx my-agent.ts --proxy
```

Watch the **Live** tab — you'll see events appear in real-time as the agent works.

## What You See

The inspector parses raw HTTP into a readable story:

```
→ USER
  "What's the weather in London and Paris? Calculate the average."

⚡ TOOL CALL — get_weather
    city: London
← TOOL RESULT
    {"temperature_celsius": 14, "condition": "Rainy"}

⚡ TOOL CALL — get_weather
    city: Paris
← TOOL RESULT
    {"temperature_celsius": 18, "condition": "Overcast"}

⚡ TOOL CALL — calculate
    expression: (14 + 18) / 2
← TOOL RESULT
    {"result": 16}

✓ FINAL ANSWER                                         3.2s
  The average temperature is 16°C (60.8°F).
  London: 14°C (Rainy), Paris: 18°C (Overcast).
```

Every tool call shows expandable inputs and outputs. Click to see the full data.

## Features

| Feature | Description |
|---|---|
| **Live Dashboard** | Watch events stream in real-time via WebSocket as your agent runs |
| **Session Inspector** | Click any recorded session to see the full conversation flow |
| **Tool Call Parsing** | Extracts structured tool calls (OpenAI, Anthropic, Ollama formats) |
| **Expandable I/O** | Click any tool call to see inputs and outputs |
| **Multi-Provider** | Routes to Ollama, OpenAI, or Anthropic by model name |
| **Multi-Session** | One proxy handles parallel agents via `X-Session-Id` header |
| **Token Tracking** | Tokens and latency per step, extracted automatically |
| **Session Stats** | Total tokens, duration, tool usage summary |
| **CI Assertions** | Test recorded sessions with assertions (exit 0/1) |

## Requirements

- Node.js >= 20
- [Ollama](https://ollama.com) running locally (for local models)
- OpenAI API key (optional)
- Anthropic API key (optional)

## Install

```bash
git clone <repo-url>
cd llm-replay
npm install
npm run build
npm link  # optional: makes `llm-replay` command available globally
```

### Provider Setup

```bash
# Ollama — works out of the box

# OpenAI (optional)
export OPENAI_API_KEY=sk-...

# Anthropic (optional)
export ANTHROPIC_API_KEY=sk-ant-...
```

## Usage

### Start the dashboard

```bash
node dist/cli.js ui
```

Starts API server + capture proxy + WebSocket. One command.

### Run your agent

Point your agent's LLM URL at `http://localhost:11435`:

```python
# Python
response = requests.post("http://localhost:11435/api/chat",
    json={"model": "qwen3.6", "messages": [...]})
```

```typescript
// TypeScript
const res = await fetch("http://localhost:11435/api/chat", {
  body: JSON.stringify({ model: "minicpm-v4.6:latest", messages: [...] })
});
```

```bash
# curl
curl http://localhost:11435/api/chat -d '{"model":"minicpm-v4.6:latest","messages":[...]}'
```

Works with any language. The proxy handles Ollama format (`/api/chat`) and OpenAI format (`/v1/chat/completions`).

### View the live dashboard

Open `http://localhost:5173`. The **Live** tab shows events streaming in real-time. The **Sessions** tab shows all recorded sessions you can inspect.

### Capture separately (without dashboard)

```bash
# Just the proxy, no UI
node dist/cli.js capture --session my-run

# List recorded sessions
node dist/cli.js ls

# View stats
node dist/cli.js stats --session my-run

# CI assertions
node dist/cli.js test --session my-run --assert "contains:async" "not_contains:error"
```

### Parallel agents

One proxy, multiple agents — use the `X-Session-Id` header:

```python
requests.post("http://localhost:11435/api/chat",
    headers={"X-Session-Id": "agent-search"},
    json={"model": "qwen3.6", "messages": [...]})
```

Each session ID gets its own recording and timeline.

## CLI Commands

| Command | Description |
|---------|-------------|
| `ui` | Start everything (API + proxy + WebSocket) |
| `capture` | Start capture proxy only |
| `replay` | Serve recorded responses (for testing agent code without LLM) |
| `stats` | Token/latency breakdown |
| `test` | CI assertions against sessions |
| `judge` | AI-score comparison between two sessions |
| `ls` | List sessions |
| `inspect` | View raw events |
| `rm` | Delete session |

## How It Works

1. Your agent calls `fetch("http://localhost:11435/api/chat", ...)` 
2. The proxy forwards to the real LLM provider, records request + response
3. Events are saved to `~/.llm-replay/sessions/<id>.jsonl`
4. Events are simultaneously broadcast via WebSocket to the live dashboard
5. The conversation parser extracts tool calls, reasoning, and answers from raw HTTP
6. The UI renders the parsed conversation as a readable timeline

## Architecture

```
┌─────────────────────────────────────────────┐
│         Live Dashboard (:5173)              │
│   Live Tab (WebSocket) │ Sessions Tab       │
└───────────────────────┬─────────────────────┘
                        │ WebSocket + REST
┌───────────────────────▼─────────────────────┐
│         API Server (:3001)                  │
│   /ws │ /api/sessions │ /api/conversation   │
└───────────────────────┬─────────────────────┘
                        │
┌───────────────────────▼─────────────────────┐
│         Capture Proxy (:11435)              │
│                                             │
│   Provider Router:                          │
│     gpt-* → OpenAI                          │
│     claude-* → Anthropic                    │
│     * → Ollama                              │
│                                             │
│   Session Router (X-Session-Id header)      │
│   Event Store (JSONL) + Live Broadcast (WS) │
└─────────────────────────────────────────────┘
```

## Project Structure

```
llm-replay/
├── src/
│   ├── proxy.ts               # Multi-provider capture proxy
│   ├── api-server.ts          # REST API + WebSocket
│   ├── live-broadcast.ts      # WebSocket event broadcasting
│   ├── conversation-parser.ts # Extracts tool calls from raw HTTP
│   ├── event-store.ts         # JSONL persistence with live listener
│   ├── capture.ts             # HTTP interception + recording
│   ├── replay.ts              # Cached response serving
│   ├── stats.ts               # Token/latency extraction
│   ├── test-runner.ts         # CI assertion engine
│   ├── judge.ts               # LLM-as-a-judge scoring
│   ├── cli.ts                 # All CLI commands
│   └── providers/             # LLM provider adapters
│       ├── ollama.ts
│       ├── openai.ts
│       └── anthropic.ts
├── playground/                # React web UI
│   └── src/
│       ├── App.tsx            # Live + Sessions tabs
│       └── components/
│           ├── LiveView.tsx        # Real-time event stream
│           ├── ConversationView.tsx # Parsed session inspector
│           ├── SessionList.tsx      # Session browser
│           └── DiffView.tsx         # Side-by-side comparison
├── package.json
└── tsconfig.json
```

## Supported Formats

The conversation parser handles tool calls from:

| Provider | Format | Detected |
|---|---|---|
| OpenAI | `tool_calls` array in response, `tool` role messages | Yes |
| Anthropic | `tool_use` content blocks, `tool_result` blocks | Yes |
| Ollama | Same as OpenAI (tool_calls with args as object) | Yes |
| Plain chat | No tools, just user/assistant messages | Yes |

## Tests

```bash
npm test  # 8 tests (unit + integration)
```

## Design Decisions

- **Proxy over SDK** — works with any language without code changes
- **JSONL storage** — append-only, streamable, no database dependency
- **WebSocket for live** — events appear in UI as they happen, not after
- **Conversation parser** — turns raw HTTP into readable story, handles all major formats
- **Provider adapters** — isolate API quirks, one interface for all providers
- **Multi-session via header** — one proxy handles parallel agents

## License

MIT
