/**
 * Branch Module — fork a session at any point and create alternate timelines.
 *
 * Design patterns:
 * - Command pattern: BranchPatch is a declarative command object that
 *   describes *what* to change without knowing *how* replay works.
 * - Memento pattern (partial): we snapshot history up to a point, then
 *   diverge. The original session is never mutated.
 * - Factory: creates a new CaptureSession pre-loaded with patched history.
 *
 * Flow:
 *   1. Load parent session events up to `branchAt` seq number
 *   2. Apply patch (swap prompt, inject error, change model)
 *   3. Write patched events to a new session file
 *   4. Return a CaptureSession that continues from the branch point,
 *      forwarding to Ollama with modified context
 *
 * This is where "time travel debugging" becomes real — you can ask
 * "what if the model was different?" or "what if this tool failed?"
 * and get a concrete answer.
 */

import { randomUUID } from 'node:crypto';
import { EventStore } from './event-store.js';
import { RealClock } from './clock.js';
import { CaptureSession } from './capture.js';
import type { ReplayEvent, BranchPatch, SessionMeta, RequestEvent } from './types.js';

export interface BranchOptions {
  parentSessionId: string;
  branchAt: number; // seq number to branch at (events up to this are kept)
  patch: BranchPatch;
  store: EventStore;
  ollamaBaseUrl: string;
  newSessionId?: string;
}

export interface BranchResult {
  sessionId: string;
  eventsKept: number;
  patchesApplied: string[];
  captureSession: CaptureSession; // ready to continue proxying
}

export async function createBranch(opts: BranchOptions): Promise<BranchResult> {
  const {
    parentSessionId,
    branchAt,
    patch,
    store,
    ollamaBaseUrl,
    newSessionId = `branch-${randomUUID().slice(0, 8)}`,
  } = opts;

  // 1. Load parent events up to branch point
  const parentEvents = await store.readUntil(parentSessionId, branchAt);
  if (parentEvents.length === 0) {
    throw new Error(`No events found in session "${parentSessionId}" up to seq ${branchAt}`);
  }

  // 2. Apply patches to the copied events
  const patchedEvents = applyPatches(parentEvents, patch);
  const patchesApplied = describePatchesApplied(patch);

  // 3. Rewrite meta event for the new branch
  const branchMeta: SessionMeta = {
    session_id: newSessionId,
    parent_session_id: parentSessionId,
    branch_point: branchAt,
    started_at: new Date().toISOString(),
    mode: 'branch',
    ollama_base_url: ollamaBaseUrl,
    model: patch.model ?? extractModel(parentEvents),
  };

  // Replace or prepend meta
  const finalEvents: ReplayEvent[] = [
    { seq: 0, t: 0, type: 'meta', data: branchMeta },
    ...patchedEvents.filter((e) => e.type !== 'meta'),
  ];

  // 4. Write to new session file
  await store.appendBatch(newSessionId, finalEvents);

  // 5. Create a CaptureSession that continues from the branch point
  const clock = new RealClock();
  const captureSession = new CaptureSession({
    sessionId: newSessionId,
    ollamaBaseUrl,
    clock,
    store,
    model: branchMeta.model,
  });

  return {
    sessionId: newSessionId,
    eventsKept: finalEvents.length,
    patchesApplied,
    captureSession,
  };
}

/** Apply patch transformations to event history */
function applyPatches(events: ReplayEvent[], patch: BranchPatch): ReplayEvent[] {
  return events.map((event) => {
    // Swap system prompt in request bodies
    if (patch.system_prompt && event.type === 'request') {
      return patchSystemPrompt(event, patch.system_prompt);
    }

    // Swap model in request bodies
    if (patch.model && event.type === 'request') {
      return patchModel(event, patch.model);
    }

    // Inject error at specific seq
    if (patch.inject_error && event.type === 'response' && event.seq === patch.inject_error.at_seq) {
      return {
        ...event,
        data: {
          ...event.data,
          status: patch.inject_error.error.status,
          body: patch.inject_error.error.body,
        },
      };
    }

    // Override tool result at specific seq
    if (patch.override_tool_result && event.type === 'tool_result' && event.seq === patch.override_tool_result.at_seq) {
      return {
        ...event,
        data: { ...event.data, result: patch.override_tool_result.result },
      };
    }

    return event;
  });
}

/** Patch system prompt in a request event's body */
function patchSystemPrompt(event: RequestEvent, newPrompt: string): RequestEvent {
  const body = event.data.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return event;

  // Ollama chat API uses messages array with role: "system"
  if (Array.isArray(body.messages)) {
    const messages = body.messages.map((msg: Record<string, unknown>) =>
      msg.role === 'system' ? { ...msg, content: newPrompt } : msg
    );
    return { ...event, data: { ...event.data, body: { ...body, messages } } };
  }

  // Ollama generate API uses "system" field
  if ('system' in body) {
    return { ...event, data: { ...event.data, body: { ...body, system: newPrompt } } };
  }

  return event;
}

/** Patch model name in request body */
function patchModel(event: RequestEvent, newModel: string): RequestEvent {
  const body = event.data.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return event;
  if ('model' in body) {
    return { ...event, data: { ...event.data, body: { ...body, model: newModel } } };
  }
  return event;
}

/** Extract model from meta or first request */
function extractModel(events: ReplayEvent[]): string | undefined {
  for (const e of events) {
    if (e.type === 'meta' && e.data.model) return e.data.model;
    if (e.type === 'request') {
      const body = e.data.body as Record<string, unknown> | undefined;
      if (body && typeof body.model === 'string') return body.model;
    }
  }
  return undefined;
}

/** Human-readable description of what was patched */
function describePatchesApplied(patch: BranchPatch): string[] {
  const desc: string[] = [];
  if (patch.system_prompt) desc.push('system_prompt swapped');
  if (patch.model) desc.push(`model changed to "${patch.model}"`);
  if (patch.temperature !== undefined) desc.push(`temperature set to ${patch.temperature}`);
  if (patch.inject_error) desc.push(`error injected at seq ${patch.inject_error.at_seq}`);
  if (patch.override_tool_result) desc.push(`tool result overridden at seq ${patch.override_tool_result.at_seq}`);
  return desc;
}
