/**
 * Integration tests — capture and replay with local Ollama.
 * Skips if Ollama isn't running.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startProxy, type ProxyInstance } from '../server/proxy.js';
import { EventStore } from '../core/event-store.js';

const OLLAMA_URL = 'http://localhost:11434';
const MODEL = 'minicpm-v4.6:latest';
const CAPTURE_PORT = 18932;
const REPLAY_PORT = 18933;

let ollamaAvailable = false;

async function checkOllama(): Promise<boolean> {
  try { return (await fetch(`${OLLAMA_URL}/api/tags`)).ok; } catch { return false; }
}

async function chat(port: number, message: string): Promise<string> {
  const res = await fetch(`http://localhost:${port}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: message }], stream: false }),
  });
  if (!res.ok) throw new Error(`Chat failed: ${res.status}`);
  const data = await res.json() as { message?: { content?: string } };
  return data.message?.content ?? '';
}

describe('Integration: Capture and Replay', () => {
  let storeDir: string;
  let store: EventStore;
  let proxy: ProxyInstance | null = null;

  beforeAll(async () => {
    ollamaAvailable = await checkOllama();
    storeDir = await mkdtemp(join(tmpdir(), 'llm-replay-test-'));
    store = new EventStore({ storeDir });
  });

  afterEach(async () => {
    if (proxy) { await proxy.close(); proxy = null; }
  });

  afterAll(async () => {
    await rm(storeDir, { recursive: true });
  });

  it('captures a real conversation', async () => {
    if (!ollamaAvailable) return;

    proxy = await startProxy({ port: CAPTURE_PORT, mode: 'capture', sessionId: 'test-cap', ollamaBaseUrl: OLLAMA_URL, storeDir });
    const answer = await chat(CAPTURE_PORT, 'Say hello in one word.');
    expect(answer).toBeTruthy();

    await proxy.close(); proxy = null;

    const events = await store.readAll('test-cap');
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0].type).toBe('meta');
    expect(events[1].type).toBe('request');
    expect(events[2].type).toBe('response');
  }, 60_000);

  it('replays the same response without hitting Ollama', async () => {
    if (!ollamaAvailable) return;
    if (!(await store.exists('test-cap'))) return;

    const events = await store.readAll('test-cap');
    const original = events.find(e => e.type === 'response');
    const originalContent = (original?.data.body as any)?.message?.content ?? '';

    proxy = await startProxy({ port: REPLAY_PORT, mode: 'replay', sessionId: 'test-cap', ollamaBaseUrl: OLLAMA_URL, storeDir });
    const replayed = await chat(REPLAY_PORT, 'Say hello in one word.');
    expect(replayed).toBe(originalContent);
  }, 10_000);

  it('returns 410 when exhausted', async () => {
    if (!ollamaAvailable) return;
    if (!(await store.exists('test-cap'))) return;

    proxy = await startProxy({ port: REPLAY_PORT, mode: 'replay', sessionId: 'test-cap', ollamaBaseUrl: OLLAMA_URL, storeDir });
    await chat(REPLAY_PORT, 'anything'); // consume the one pair

    const res = await fetch(`http://localhost:${REPLAY_PORT}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'x' }], stream: false }),
    });
    expect(res.status).toBe(410);
  }, 10_000);

  it('captures multiple turns and replays all', async () => {
    if (!ollamaAvailable) return;

    proxy = await startProxy({ port: CAPTURE_PORT, mode: 'capture', sessionId: 'test-multi', ollamaBaseUrl: OLLAMA_URL, storeDir });
    const a1 = await chat(CAPTURE_PORT, 'Say hello.');
    const a2 = await chat(CAPTURE_PORT, 'Say goodbye.');
    await proxy.close(); proxy = null;

    expect(a1).toBeTruthy();
    expect(a2).toBeTruthy();

    const events = await store.readAll('test-multi');
    expect(events.length).toBe(5); // meta + 2*(req+res)

    proxy = await startProxy({ port: REPLAY_PORT, mode: 'replay', sessionId: 'test-multi', ollamaBaseUrl: OLLAMA_URL, storeDir });
    const r1 = await chat(REPLAY_PORT, 'Say hello.');
    const r2 = await chat(REPLAY_PORT, 'Say goodbye.');
    expect(r1).toBe(a1);
    expect(r2).toBe(a2);
  }, 120_000);
});
