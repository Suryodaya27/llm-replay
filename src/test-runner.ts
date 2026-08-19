/**
 * CI Test Runner — replay sessions and assert on outputs.
 *
 * Usage:
 *   llm-replay test --session my-run --assert contains:"valid JSON"
 *   llm-replay test --session my-run --assert-file assertions.json
 *
 * Assertions run against recorded responses without hitting Ollama.
 * Exit code 0 = all pass, exit code 1 = failure (CI-friendly).
 */

import { EventStore } from './event-store.js';
import { getSessionStats } from './stats.js';
import type { Assertion, AssertionResult, TestResult, ReplayEvent, StreamEndEvent } from './types.js';

export interface TestRunnerOptions {
  sessionId: string;
  store: EventStore;
  assertions: Assertion[];
}

export async function runTest(opts: TestRunnerOptions): Promise<TestResult> {
  const { sessionId, store, assertions } = opts;
  const events = await store.readAll(sessionId);
  const stats = await getSessionStats(sessionId, store);

  // Extract response contents for assertion checking
  const responseContents = extractResponseContents(events);

  const results: AssertionResult[] = [];

  for (const assertion of assertions) {
    const targets = getTargetContents(responseContents, assertion);
    const result = runAssertion(assertion, targets);
    results.push(result);
  }

  return {
    session_id: sessionId,
    passed: results.every((r) => r.passed),
    assertions: results,
    stats,
  };
}

interface ResponseContent {
  turnIndex: number;
  content: string;
  tokens: number;
  latencyMs: number;
}

function extractResponseContents(events: ReplayEvent[]): ResponseContent[] {
  const contents: ResponseContent[] = [];
  let turnIndex = 0;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    if (event.type === 'response') {
      const body = event.data.body as Record<string, unknown> | undefined;
      let content = '';
      if (body?.message && typeof body.message === 'object') {
        content = ((body.message as Record<string, unknown>).content as string) ?? '';
      } else if (typeof body?.response === 'string') {
        content = body.response;
      } else {
        content = JSON.stringify(body);
      }

      contents.push({
        turnIndex: turnIndex++,
        content,
        tokens: ((body?.eval_count as number) ?? 0) + ((body?.prompt_eval_count as number) ?? 0),
        latencyMs: event.data.duration_ms,
      });
    }

    if (event.type === 'stream_end') {
      const se = event as StreamEndEvent;
      contents.push({
        turnIndex: turnIndex++,
        content: se.data.assembled_content,
        tokens: se.data.tokens?.total_tokens ?? 0,
        latencyMs: se.data.duration_ms,
      });
    }
  }

  return contents;
}

function getTargetContents(all: ResponseContent[], assertion: Assertion): ResponseContent[] {
  if (assertion.turn !== undefined) {
    const match = all.find((r) => r.turnIndex === assertion.turn);
    return match ? [match] : [];
  }
  return all; // check all turns
}

function runAssertion(assertion: Assertion, targets: ResponseContent[]): AssertionResult {
  if (targets.length === 0) {
    return { assertion, passed: false, message: `No matching turns found` };
  }

  switch (assertion.type) {
    case 'contains': {
      const val = String(assertion.value);
      const allContain = targets.every((t) => t.content.includes(val));
      const failing = targets.find((t) => !t.content.includes(val));
      return {
        assertion,
        passed: allContain,
        actual: failing?.content.slice(0, 200),
        message: allContain ? undefined : `Turn ${failing?.turnIndex} does not contain "${val}"`,
      };
    }

    case 'not_contains': {
      const val = String(assertion.value);
      const noneContain = targets.every((t) => !t.content.includes(val));
      const failing = targets.find((t) => t.content.includes(val));
      return {
        assertion,
        passed: noneContain,
        actual: failing?.content.slice(0, 200),
        message: noneContain ? undefined : `Turn ${failing?.turnIndex} contains "${val}"`,
      };
    }

    case 'matches_regex': {
      const regex = new RegExp(String(assertion.value));
      const allMatch = targets.every((t) => regex.test(t.content));
      const failing = targets.find((t) => !regex.test(t.content));
      return {
        assertion,
        passed: allMatch,
        actual: failing?.content.slice(0, 200),
        message: allMatch ? undefined : `Turn ${failing?.turnIndex} does not match /${assertion.value}/`,
      };
    }

    case 'json_valid': {
      const allValid = targets.every((t) => {
        try { JSON.parse(t.content); return true; } catch { return false; }
      });
      const failing = targets.find((t) => {
        try { JSON.parse(t.content); return false; } catch { return true; }
      });
      return {
        assertion,
        passed: allValid,
        actual: failing?.content.slice(0, 200),
        message: allValid ? undefined : `Turn ${failing?.turnIndex} is not valid JSON`,
      };
    }

    case 'max_tokens': {
      const max = Number(assertion.value);
      const allUnder = targets.every((t) => t.tokens <= max);
      const failing = targets.find((t) => t.tokens > max);
      return {
        assertion,
        passed: allUnder,
        actual: failing ? String(failing.tokens) : undefined,
        message: allUnder ? undefined : `Turn ${failing?.turnIndex} used ${failing?.tokens} tokens (max: ${max})`,
      };
    }

    case 'max_latency_ms': {
      const max = Number(assertion.value);
      const allUnder = targets.every((t) => t.latencyMs <= max);
      const failing = targets.find((t) => t.latencyMs > max);
      return {
        assertion,
        passed: allUnder,
        actual: failing ? `${failing.latencyMs}ms` : undefined,
        message: allUnder ? undefined : `Turn ${failing?.turnIndex} took ${failing?.latencyMs}ms (max: ${max}ms)`,
      };
    }

    default:
      return { assertion, passed: false, message: `Unknown assertion type: ${assertion.type}` };
  }
}

/** Parse assertion from CLI shorthand: "contains:hello" → Assertion */
export function parseAssertionString(str: string): Assertion {
  const colonIdx = str.indexOf(':');
  if (colonIdx === -1) {
    throw new Error(`Invalid assertion format: "${str}". Use "type:value" (e.g. "contains:hello")`);
  }
  const type = str.slice(0, colonIdx) as Assertion['type'];
  const value = str.slice(colonIdx + 1);
  return { type, value };
}
