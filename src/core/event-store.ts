/**
 * Event Store — append-only JSONL persistence.
 *
 * Design patterns:
 * - Repository pattern: abstracts storage behind a clean interface.
 *   Swap JSONL for SQLite, S3, or a proper event store later without
 *   touching any caller.
 * - Event Sourcing: the JSONL file IS the source of truth.
 *   State is derived by replaying events, never stored separately.
 * - Iterator pattern: `read()` returns an async generator so we can
 *   stream million-event sessions without loading everything into RAM.
 */

import { createReadStream } from 'node:fs';
import { appendFile, mkdir, stat, readdir, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ReplayEvent, SessionMeta } from '../types.js';

const DEFAULT_STORE_DIR = join(homedir(), '.llm-replay', 'sessions');

export interface EventStoreOptions {
  storeDir?: string;
}

export class EventStore {
  private readonly dir: string;
  private _onEvent: ((sessionId: string, event: ReplayEvent) => void) | null = null;

  constructor(opts?: EventStoreOptions) {
    this.dir = opts?.storeDir ?? DEFAULT_STORE_DIR;
  }

  /** Set a listener that fires on every append (for live broadcasting) */
  set onEvent(fn: ((sessionId: string, event: ReplayEvent) => void) | null) {
    this._onEvent = fn;
  }

  /** Ensure storage directory exists */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private sessionPath(sessionId: string): string {
    return join(this.dir, `${sessionId}.jsonl`);
  }

  /** Append a single event to a session file */
  async append(sessionId: string, event: ReplayEvent): Promise<void> {
    await this.init();
    await appendFile(this.sessionPath(sessionId), JSON.stringify(event) + '\n');
    if (this._onEvent) this._onEvent(sessionId, event);
  }

  /** Append multiple events atomically (single write) */
  async appendBatch(sessionId: string, events: ReplayEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.init();
    await appendFile(this.sessionPath(sessionId), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  /**
   * Stream-read events from a session. Uses async generator so we never
   * load the entire file into memory.
   */
  async *read(sessionId: string): AsyncGenerator<ReplayEvent> {
    const path = this.sessionPath(sessionId);
    await this.assertExists(path);

    const rl = createInterface({
      input: createReadStream(path, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      yield JSON.parse(trimmed) as ReplayEvent;
    }
  }

  /** Read all events into memory (for small sessions / branching) */
  async readAll(sessionId: string): Promise<ReplayEvent[]> {
    const events: ReplayEvent[] = [];
    for await (const event of this.read(sessionId)) {
      events.push(event);
    }
    return events;
  }

  /** Read events up to a sequence number (inclusive) */
  async readUntil(sessionId: string, maxSeq: number): Promise<ReplayEvent[]> {
    const events: ReplayEvent[] = [];
    for await (const event of this.read(sessionId)) {
      if (event.seq > maxSeq) break;
      events.push(event);
    }
    return events;
  }

  /** Get session metadata (first event) */
  async getMeta(sessionId: string): Promise<SessionMeta | null> {
    for await (const event of this.read(sessionId)) {
      if (event.type === 'meta') return event.data;
      break; // meta must be first event
    }
    return null;
  }

  /** List all session IDs */
  async list(): Promise<string[]> {
    await this.init();
    const files = await readdir(this.dir);
    return files
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace('.jsonl', ''))
      .sort();
  }

  /** Check if a session exists */
  async exists(sessionId: string): Promise<boolean> {
    try {
      await stat(this.sessionPath(sessionId));
      return true;
    } catch {
      return false;
    }
  }

  /** Delete a session */
  async delete(sessionId: string): Promise<void> {
    await unlink(this.sessionPath(sessionId));
  }

  /** Get event count for a session */
  async count(sessionId: string): Promise<number> {
    let n = 0;
    for await (const _ of this.read(sessionId)) {
      n++;
    }
    return n;
  }

  private async assertExists(path: string): Promise<void> {
    try {
      await stat(path);
    } catch {
      throw new Error(`Session file not found: ${path}`);
    }
  }
}
