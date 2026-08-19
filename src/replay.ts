/**
 * Replay Module — serves cached responses from a recorded session.
 *
 * Design patterns:
 * - Iterator/Cursor: maintains a pointer into the event sequence and
 *   advances one request/response pair at a time.
 * - Null Object: when the session runs out of events, returns a clear
 *   "end of replay" error instead of crashing.
 *
 * Flow:
 *   Agent → Replay Proxy → (reads from JSONL, never hits Ollama)
 *
 * Guarantees:
 * - Same request order → same response. The agent relives the session.
 * - Virtual clock advances to match original timing.
 * - If the agent sends a request that doesn't match the next recorded
 *   request, we log a drift warning but still serve the response
 *   (configurable: strict mode can reject mismatches).
 */

import { VirtualClock } from './clock.js';
import { EventStore } from './event-store.js';
import type { RequestEvent, ResponseEvent, StreamChunkEvent, StreamEndEvent, ReplayEvent } from './types.js';

export interface ReplayOptions {
  sessionId: string;
  store: EventStore;
  strict?: boolean;
}

export interface ReplayResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface DriftWarning {
  seq: number;
  field: string;
  expected: string;
  actual: string;
}

/** A turn can be either a buffered request/response pair OR a streaming sequence */
interface BufferedTurn {
  kind: 'buffered';
  request: RequestEvent;
  response: ResponseEvent;
}

interface StreamingTurn {
  kind: 'streaming';
  request: RequestEvent;
  chunks: StreamChunkEvent[];
  end: StreamEndEvent;
}

type Turn = BufferedTurn | StreamingTurn;

export class ReplaySession {
  private readonly sessionId: string;
  private readonly store: EventStore;
  private readonly strict: boolean;
  private clock: VirtualClock;

  private turns: Turn[] = [];
  private cursor = 0;
  private initialized = false;
  private _driftWarnings: DriftWarning[] = [];

  constructor(opts: ReplayOptions) {
    this.sessionId = opts.sessionId;
    this.store = opts.store;
    this.strict = opts.strict ?? false;
    this.clock = new VirtualClock();
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const events = await this.store.readAll(this.sessionId);
    if (events.length === 0) {
      throw new Error(`Session "${this.sessionId}" is empty`);
    }

    const meta = events.find((e) => e.type === 'meta');
    if (meta?.type === 'meta') {
      this.clock = new VirtualClock(meta.data.started_at);
    }

    this.turns = this.extractTurns(events);
    this.initialized = true;
  }

  /**
   * Serve the next recorded response. Handles both buffered and streaming turns.
   * For streaming turns: reassembles chunks into NDJSON body.
   */
  async serve(
    method: string,
    path: string,
    _headers: Record<string, string>,
    body: Buffer
  ): Promise<ReplayResult> {
    await this.init();

    if (this.cursor >= this.turns.length) {
      return {
        status: 410,
        headers: { 'x-replay-status': 'exhausted' },
        body: Buffer.from(JSON.stringify({
          error: 'replay_exhausted',
          message: `Session "${this.sessionId}" has no more recorded responses (served ${this.turns.length} turns)`,
        })),
      };
    }

    const turn = this.turns[this.cursor];
    this.detectDrift(turn.request, method, path, body);
    this.cursor++;

    if (turn.kind === 'buffered') {
      this.clock.setElapsed(turn.response.t);
      const responseBody = typeof turn.response.data.body === 'string'
        ? turn.response.data.body
        : JSON.stringify(turn.response.data.body);

      return {
        status: turn.response.data.status,
        headers: {
          ...turn.response.data.headers,
          'x-replay-seq': String(turn.response.seq),
          'x-replay-session': this.sessionId,
        },
        body: Buffer.from(responseBody, 'utf-8'),
      };
    }

    // Streaming turn: reconstruct NDJSON from recorded chunks
    this.clock.setElapsed(turn.end.t);
    const ndjson = turn.chunks
      .map((c) => JSON.stringify(c.data.chunk))
      .join('\n') + '\n';

    return {
      status: 200,
      headers: {
        'content-type': 'application/x-ndjson',
        'transfer-encoding': 'chunked',
        'x-replay-seq': String(turn.end.seq),
        'x-replay-session': this.sessionId,
        'x-replay-streamed': 'true',
        'x-replay-chunks': String(turn.chunks.length),
      },
      body: Buffer.from(ndjson, 'utf-8'),
    };
  }

  get remaining(): number {
    return Math.max(0, this.turns.length - this.cursor);
  }

  get total(): number {
    return this.turns.length;
  }

  get driftWarnings(): DriftWarning[] {
    return this._driftWarnings;
  }

  get isExhausted(): boolean {
    return this.cursor >= this.turns.length;
  }

  reset(): void {
    this.cursor = 0;
    this._driftWarnings = [];
    this.clock.reset();
  }

  /**
   * Extract turns from events — supports both:
   * - request → response (buffered)
   * - request → stream_chunk* → stream_end (streaming)
   */
  private extractTurns(events: ReplayEvent[]): Turn[] {
    const turns: Turn[] = [];
    let i = 0;

    while (i < events.length) {
      const event = events[i];

      if (event.type === 'request') {
        // Look ahead: is the next meaningful event a response or stream_chunk?
        const rest = events.slice(i + 1);
        const nextRelevant = rest.find((e) =>
          e.type === 'response' || e.type === 'stream_chunk'
        );

        if (nextRelevant?.type === 'response') {
          // Buffered turn
          turns.push({ kind: 'buffered', request: event, response: nextRelevant });
          i = events.indexOf(nextRelevant) + 1;
        } else if (nextRelevant?.type === 'stream_chunk') {
          // Streaming turn — collect all chunks until stream_end
          const chunks: StreamChunkEvent[] = [];
          let j = i + 1;
          while (j < events.length && events[j].type !== 'stream_end') {
            if (events[j].type === 'stream_chunk') {
              chunks.push(events[j] as StreamChunkEvent);
            }
            j++;
          }
          const end = events[j] as StreamEndEvent | undefined;
          if (end?.type === 'stream_end') {
            turns.push({ kind: 'streaming', request: event, chunks, end });
            i = j + 1;
          } else {
            i++; // malformed, skip
          }
        } else {
          i++; // orphan request, skip
        }
      } else {
        i++;
      }
    }
    return turns;
  }

  private detectDrift(
    recorded: RequestEvent,
    actualMethod: string,
    actualPath: string,
    actualBody: Buffer
  ): void {
    if (recorded.data.method !== actualMethod) {
      this.addDrift(recorded.seq, 'method', recorded.data.method, actualMethod);
    }
    if (recorded.data.path !== actualPath) {
      this.addDrift(recorded.seq, 'path', recorded.data.path, actualPath);
    }
    try {
      const recordedBody = JSON.stringify(recorded.data.body);
      const incomingBody = actualBody.toString('utf-8');
      if (recordedBody !== incomingBody) {
        this.addDrift(recorded.seq, 'body', recordedBody.slice(0, 100), incomingBody.slice(0, 100));
      }
    } catch { /* skip */ }
  }

  private addDrift(seq: number, field: string, expected: string, actual: string): void {
    const warning: DriftWarning = { seq, field, expected, actual };
    this._driftWarnings.push(warning);
    if (this.strict) {
      throw new Error(
        `Replay drift at seq ${seq}: ${field} mismatch.\n` +
        `  Expected: ${expected}\n  Actual:   ${actual}`
      );
    }
  }
}
