/**
 * Stats Module — extracts token usage, latency, and cost data from sessions.
 */

import { EventStore } from './event-store.js';
import type { ReplayEvent, SessionStats, TurnStats, TokenUsage, StreamEndEvent } from './types.js';

export async function getSessionStats(sessionId: string, store: EventStore): Promise<SessionStats> {
  const events = await store.readAll(sessionId);
  const meta = events.find((e) => e.type === 'meta');

  const turns: TurnStats[] = [];
  const totalTokens: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let totalDuration = 0;
  let model: string | undefined;

  if (meta?.type === 'meta') {
    model = meta.data.model;
  }

  // Walk through events and extract stats per turn
  let i = 0;
  let turnIndex = 0;

  while (i < events.length) {
    const event = events[i];

    if (event.type === 'request') {
      // Extract model from first request if not in meta
      if (!model) {
        const body = event.data.body as Record<string, unknown> | undefined;
        if (body && typeof body.model === 'string') model = body.model;
      }

      // Find matching response or stream_end
      const response = findResponse(events, i);
      if (response) {
        const turn = buildTurnStats(turnIndex, event, response, events);
        turns.push(turn);
        totalTokens.prompt_tokens += turn.prompt_tokens;
        totalTokens.completion_tokens += turn.completion_tokens;
        totalDuration += turn.latency_ms;
        turnIndex++;
        i = response.index + 1;
        continue;
      }
    }
    i++;
  }

  totalTokens.total_tokens = totalTokens.prompt_tokens + totalTokens.completion_tokens;

  return {
    session_id: sessionId,
    total_turns: turns.length,
    total_tokens: totalTokens,
    avg_latency_ms: turns.length > 0 ? Math.round(totalDuration / turns.length) : 0,
    total_duration_ms: totalDuration,
    model,
    turns,
  };
}

interface FoundResponse {
  index: number;
  event: ReplayEvent;
  streamed: boolean;
}

function findResponse(events: ReplayEvent[], requestIdx: number): FoundResponse | null {
  for (let j = requestIdx + 1; j < events.length; j++) {
    if (events[j].type === 'response') {
      return { index: j, event: events[j], streamed: false };
    }
    if (events[j].type === 'stream_end') {
      return { index: j, event: events[j], streamed: true };
    }
    if (events[j].type === 'request') {
      // Next request started without a response — orphan
      return null;
    }
  }
  return null;
}

function buildTurnStats(
  index: number,
  request: ReplayEvent,
  response: FoundResponse,
  _events: ReplayEvent[],
): TurnStats {
  let promptTokens = 0;
  let completionTokens = 0;
  let latencyMs = 0;

  if (response.streamed && response.event.type === 'stream_end') {
    const end = response.event as StreamEndEvent;
    latencyMs = end.data.duration_ms;
    if (end.data.tokens) {
      promptTokens = end.data.tokens.prompt_tokens;
      completionTokens = end.data.tokens.completion_tokens;
    }
  } else if (response.event.type === 'response') {
    const data = response.event.data as { duration_ms: number; body?: unknown };
    latencyMs = data.duration_ms;
    // Extract tokens from response body
    const body = data.body as Record<string, unknown> | undefined;
    if (body) {
      promptTokens = (body.prompt_eval_count as number) ?? 0;
      completionTokens = (body.eval_count as number) ?? 0;
    }
  }

  return {
    index,
    request_seq: request.seq,
    response_seq: response.event.seq,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    latency_ms: latencyMs,
    streamed: response.streamed,
  };
}
