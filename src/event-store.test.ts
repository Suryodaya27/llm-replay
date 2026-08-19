/**
 * Self-check: verifies the core capture → replay loop works end-to-end.
 * If this fails, the fundamental contract is broken.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventStore } from './event-store.js';
import { ReplaySession } from './replay.js';
import type { ReplayEvent } from './types.js';

describe('EventStore + ReplaySession', () => {
  let dir: string;
  let store: EventStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'llm-replay-test-'));
    store = new EventStore({ storeDir: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it('round-trips events through JSONL', async () => {
    const events: ReplayEvent[] = [
      { seq: 0, t: 0, type: 'meta', data: { session_id: 'test-1', started_at: '2026-01-01T00:00:00Z', mode: 'capture', ollama_base_url: 'http://localhost:11434' } },
      { seq: 1, t: 10, type: 'request', data: { method: 'POST', path: '/api/chat', headers: {}, body: { model: 'llama3', messages: [] } } },
      { seq: 2, t: 320, type: 'response', data: { status: 200, headers: {}, body: { message: { content: 'hello' } }, duration_ms: 310 } },
    ];

    await store.appendBatch('test-1', events);
    const loaded = await store.readAll('test-1');

    expect(loaded).toHaveLength(3);
    expect(loaded[0].type).toBe('meta');
    expect(loaded[1].type).toBe('request');
    expect(loaded[2].type).toBe('response');
  });

  it('replay serves recorded responses in order', async () => {
    const events: ReplayEvent[] = [
      { seq: 0, t: 0, type: 'meta', data: { session_id: 'test-2', started_at: '2026-01-01T00:00:00Z', mode: 'capture', ollama_base_url: 'http://localhost:11434' } },
      { seq: 1, t: 5, type: 'request', data: { method: 'POST', path: '/api/chat', headers: {}, body: { model: 'llama3', messages: [{ role: 'user', content: 'hi' }] } } },
      { seq: 2, t: 200, type: 'response', data: { status: 200, headers: { 'content-type': 'application/json' }, body: { message: { role: 'assistant', content: 'Hello!' } }, duration_ms: 195 } },
    ];

    await store.appendBatch('test-2', events);

    const session = new ReplaySession({ sessionId: 'test-2', store });
    const body = Buffer.from(JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] }));
    const result = await session.serve('POST', '/api/chat', {}, body);

    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body.toString());
    expect(parsed.message.content).toBe('Hello!');
  });

  it('replay returns 410 when exhausted', async () => {
    const events: ReplayEvent[] = [
      { seq: 0, t: 0, type: 'meta', data: { session_id: 'test-3', started_at: '2026-01-01T00:00:00Z', mode: 'capture', ollama_base_url: 'http://localhost:11434' } },
    ];

    await store.appendBatch('test-3', events);

    const session = new ReplaySession({ sessionId: 'test-3', store });
    const result = await session.serve('POST', '/api/chat', {}, Buffer.from('{}'));

    expect(result.status).toBe(410);
  });
});
