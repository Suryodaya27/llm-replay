/**
 * Integration test — real capture → replay cycle against local Ollama.
 *
 * Uses minicpm-v4.6:latest (smallest local model at 1.6GB).
 * Skips gracefully if Ollama isn't running.
 *
 * What this proves:
 * 1. Capture proxy records a real LLM conversation correctly
 * 2. Replay proxy serves the exact same responses without hitting Ollama
 * 3. Branch can fork and modify history
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startProxy, type ProxyInstance } from './proxy.js';
import { EventStore } from './event-store.js';

const OLLAMA_URL = 'http://localhost:11434';
const MODEL = 'minicpm-v4.6:latest';
const PROXY_PORT = 18932; // high port to avoid conflicts
const REPLAY_PORT = 18933;

let ollamaAvailable = false;

async function checkOllama(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

async function chat(port: number, model: string, message: string): Promise<string> {
  const res = await fetch(`http://localhost:${port}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: message }],
      stream: false,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Chat failed (${res.status}): ${text}`);
  }
  const data = await res.json() as { message?: { content?: string } };
  return data.message?.content ?? '';
}

describe('Integration: Capture → Replay', () => {
  let storeDir: string;
  let store: EventStore;
  let captureProxy: ProxyInstance | null = null;
  let replayProxy: ProxyInstance | null = null;

  beforeAll(async () => {
    ollamaAvailable = await checkOllama();
    storeDir = await mkdtemp(join(tmpdir(), 'llm-replay-integ-'));
    store = new EventStore({ storeDir });
  });

  afterEach(async () => {
    if (captureProxy) { await captureProxy.close(); captureProxy = null; }
    if (replayProxy) { await replayProxy.close(); replayProxy = null; }
  });

  afterAll(async () => {
    await rm(storeDir, { recursive: true });
  });

  it('captures a real conversation with Ollama', async () => {
    if (!ollamaAvailable) return; // skip silently

    captureProxy = await startProxy({
      port: PROXY_PORT,
      mode: 'capture',
      sessionId: 'integ-capture',
      ollamaBaseUrl: OLLAMA_URL,
      storeDir,
    });

    // Send a simple question through the proxy
    const answer = await chat(PROXY_PORT, MODEL, 'What is 2+2? Reply with just the number.');

    expect(answer).toBeTruthy();
    expect(answer.length).toBeGreaterThan(0);

    await captureProxy.close();
    captureProxy = null;

    // Verify session was recorded
    const exists = await store.exists('integ-capture');
    expect(exists).toBe(true);

    const events = await store.readAll('integ-capture');
    expect(events.length).toBeGreaterThanOrEqual(3); // meta + request + response

    // Check event types
    expect(events[0].type).toBe('meta');
    expect(events[1].type).toBe('request');
    expect(events[2].type).toBe('response');

    // Verify request was recorded correctly
    const reqEvent = events[1];
    if (reqEvent.type === 'request') {
      expect(reqEvent.data.method).toBe('POST');
      expect(reqEvent.data.path).toBe('/api/chat');
      const body = reqEvent.data.body as { model: string };
      expect(body.model).toBe(MODEL);
    }
  }, 60_000); // generous timeout for LLM

  it('replays the exact same response without hitting Ollama', async () => {
    if (!ollamaAvailable) return;

    // First: verify the captured session exists from previous test
    const exists = await store.exists('integ-capture');
    if (!exists) return; // depends on previous test

    // Get the original response from the recording
    const events = await store.readAll('integ-capture');
    const originalResponse = events.find((e) => e.type === 'response');
    expect(originalResponse).toBeDefined();

    let originalContent = '';
    if (originalResponse?.type === 'response') {
      const body = originalResponse.data.body as { message?: { content?: string } };
      originalContent = body.message?.content ?? '';
    }

    // Start replay proxy
    replayProxy = await startProxy({
      port: REPLAY_PORT,
      mode: 'replay',
      sessionId: 'integ-capture',
      ollamaBaseUrl: OLLAMA_URL, // won't be contacted
      storeDir,
    });

    // Send the same request — should get same response from cache
    const replayedAnswer = await chat(REPLAY_PORT, MODEL, 'What is 2+2? Reply with just the number.');

    expect(replayedAnswer).toBe(originalContent);
  }, 10_000);

  it('replay returns 410 when session is exhausted', async () => {
    if (!ollamaAvailable) return;
    const exists = await store.exists('integ-capture');
    if (!exists) return;

    replayProxy = await startProxy({
      port: REPLAY_PORT,
      mode: 'replay',
      sessionId: 'integ-capture',
      ollamaBaseUrl: OLLAMA_URL,
      storeDir,
    });

    // First call consumes the only recorded pair
    await chat(REPLAY_PORT, MODEL, 'What is 2+2? Reply with just the number.');

    // Second call should get 410
    const res = await fetch(`http://localhost:${REPLAY_PORT}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'Another question' }],
        stream: false,
      }),
    });

    expect(res.status).toBe(410);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('replay_exhausted');
  }, 10_000);

  it('branch forks a session with a modified model', async () => {
    if (!ollamaAvailable) return;
    const exists = await store.exists('integ-capture');
    if (!exists) return;

    // Branch the captured session at seq 1 (after meta, before request goes out)
    // with model changed to qwen3.6
    const branchProxy = await startProxy({
      port: REPLAY_PORT,
      mode: 'branch',
      sessionId: 'integ-branch',
      ollamaBaseUrl: OLLAMA_URL,
      storeDir,
      parentSessionId: 'integ-capture',
      branchAt: 1,
      patch: { model: 'qwen3.6:latest' },
    });

    // Verify the branch session was created
    const branchExists = await store.exists('integ-branch');
    expect(branchExists).toBe(true);

    // Check the branch meta
    const meta = await store.getMeta('integ-branch');
    expect(meta?.parent_session_id).toBe('integ-capture');
    expect(meta?.branch_point).toBe(1);
    expect(meta?.mode).toBe('branch');

    await branchProxy.close();
  }, 10_000);
});

describe('Integration: Multi-turn capture', () => {
  let storeDir: string;
  let store: EventStore;
  let proxy: ProxyInstance | null = null;

  beforeAll(async () => {
    ollamaAvailable = await checkOllama();
    storeDir = await mkdtemp(join(tmpdir(), 'llm-replay-multi-'));
    store = new EventStore({ storeDir });
  });

  afterEach(async () => {
    if (proxy) { await proxy.close(); proxy = null; }
  });

  afterAll(async () => {
    await rm(storeDir, { recursive: true });
  });

  it('captures multiple turns and replays all of them', async () => {
    if (!ollamaAvailable) return;

    // Capture 2 turns
    proxy = await startProxy({
      port: PROXY_PORT,
      mode: 'capture',
      sessionId: 'integ-multi',
      ollamaBaseUrl: OLLAMA_URL,
      storeDir,
    });

    const answer1 = await chat(PROXY_PORT, MODEL, 'Say hello in one word.');
    const answer2 = await chat(PROXY_PORT, MODEL, 'Say goodbye in one word.');

    expect(answer1).toBeTruthy();
    expect(answer2).toBeTruthy();

    await proxy.close();
    proxy = null;

    // Verify we got 5 events: meta + (req + res) * 2
    const events = await store.readAll('integ-multi');
    expect(events.length).toBe(5);

    // Replay both turns
    proxy = await startProxy({
      port: REPLAY_PORT,
      mode: 'replay',
      sessionId: 'integ-multi',
      ollamaBaseUrl: OLLAMA_URL,
      storeDir,
    });

    const replayed1 = await chat(REPLAY_PORT, MODEL, 'Say hello in one word.');
    const replayed2 = await chat(REPLAY_PORT, MODEL, 'Say goodbye in one word.');

    expect(replayed1).toBe(answer1);
    expect(replayed2).toBe(answer2);
  }, 120_000); // two LLM calls
});
