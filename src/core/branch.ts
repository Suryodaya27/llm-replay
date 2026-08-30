/**
 * Branch — "What if" replay. Takes a recorded session, lets you edit a step,
 * and re-runs from that point with the real LLM.
 *
 * Multi-turn loop:
 *   1. Read original session, rebuild conversation up to the edit point
 *   2. Inject the user's edit
 *   3. Call LLM
 *   4. If LLM returns tool calls → look up recorded tool results from the
 *      original session → feed them back as context → call LLM again
 *   5. Repeat until LLM gives a final answer or max turns reached
 *   6. Record entire branch conversation into a new session
 */

import { EventStore } from './event-store.js';
import { RealClock } from './clock.js';
import { parseConversation, type ConversationStep } from '../analysis/conversation-parser.js';
import {
  extractAssistantMessage, extractAssistantContent, extractToolCalls,
} from '../providers/response-format.js';
import { ProviderRouter } from '../providers/router.js';
import type { ChatResponse } from '../providers/types.js';
import type { SessionMeta, TokenUsage } from '../types.js';

const MAX_BRANCH_TURNS = 10;

export interface BranchOptions {
  sessionId: string;
  stepIndex: number;
  editedContent: string;
  newSessionId?: string;
  store: EventStore;
  router: ProviderRouter;
  ollamaBaseUrl?: string;
}

export interface BranchResult {
  sessionId: string;
  parentSessionId: string;
  branchAtStep: number;
  originalContent: string;
  editedContent: string;
  /** Full new conversation from the branch point onward */
  newSteps: Array<{ role: string; content: string }>;
  newResponse: string;
  totalTokens: number;
  turns: number;
  durationMs: number;
}

export async function runBranch(opts: BranchOptions): Promise<BranchResult> {
  const { sessionId, stepIndex, editedContent, store, router } = opts;
  const newSessionId = opts.newSessionId ?? `branch-${sessionId}-${stepIndex}-${Date.now()}`;

  // 1. Read original session
  const events = await store.readAll(sessionId);
  if (events.length === 0) throw new Error(`Session "${sessionId}" is empty`);

  const parsed = parseConversation(sessionId, events);
  const targetStep = parsed.steps[stepIndex];
  if (!targetStep) throw new Error(`Step ${stepIndex} not found (session has ${parsed.steps.length} steps)`);

  const originalContent = targetStep.content;

  // Collect recorded tool results from steps AFTER the branch point
  // These are used when the LLM makes tool calls during the branch
  const recordedToolResults = collectToolResults(parsed.steps, stepIndex);

  // 2. Rebuild messages up to the branch point and inject edit
  const messages = rebuildMessages(events, targetStep.seq);
  applyEdit(messages, targetStep, editedContent);

  // 3. Detect model
  const model = parsed.model || detectModel(events);
  if (!model) throw new Error('Cannot determine model from session');

  const provider = router.resolve(model);
  const clock = new RealClock();
  const start = Date.now();

  // 4. Multi-turn loop: call LLM → handle tool calls → repeat
  const newSteps: Array<{ role: string; content: string }> = [];
  let totalTokens = 0;
  let turns = 0;
  let lastContent = '';

  while (turns < MAX_BRANCH_TURNS) {
    turns++;

    const response = await provider.chat({
      model,
      messages: messages.map(m => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content })),
      stream: false,
    });

    if (response.tokens) {
      totalTokens += response.tokens.total_tokens;
    }

    // Parse the response
    const toolCalls = extractToolCallsFromResponse(response);

    if (toolCalls.length > 0) {
      // LLM wants to call tools — add assistant message + tool results
      const assistantContent = response.content || `[tool calls: ${toolCalls.map(t => t.name).join(', ')}]`;
      messages.push({ role: 'assistant', content: assistantContent });
      newSteps.push({ role: 'assistant', content: assistantContent });

      // Look up recorded tool results, or use a placeholder
      for (const tc of toolCalls) {
        const recorded = recordedToolResults.shift();
        const toolResult = recorded?.content ?? `[no recorded result for ${tc.name}]`;
        messages.push({ role: 'tool', content: toolResult });
        newSteps.push({ role: 'tool', content: toolResult });
      }

      // Continue the loop — LLM needs to process tool results
      continue;
    }

    // No tool calls — this is the final answer
    lastContent = response.content;
    messages.push({ role: 'assistant', content: lastContent });
    newSteps.push({ role: 'assistant', content: lastContent });

    // Record into branch session
    await recordBranchSession(
      newSessionId, sessionId, targetStep, model, events, messages,
      response, clock, store, opts.ollamaBaseUrl,
    );

    break;
  }

  const durationMs = Date.now() - start;

  return {
    sessionId: newSessionId,
    parentSessionId: sessionId,
    branchAtStep: stepIndex,
    originalContent,
    editedContent,
    newSteps,
    newResponse: lastContent,
    totalTokens,
    turns,
    durationMs,
  };
}

// --- Recording ---

async function recordBranchSession(
  newSessionId: string,
  parentSessionId: string,
  targetStep: ConversationStep,
  model: string,
  originalEvents: import('../types.js').ReplayEvent[],
  messages: Message[],
  finalResponse: ChatResponse,
  clock: Clock,
  store: EventStore,
  ollamaBaseUrl?: string,
): Promise<void> {
  let seq = 0;

  // Meta
  const meta: SessionMeta = {
    session_id: newSessionId,
    parent_session_id: parentSessionId,
    branch_point: targetStep.seq,
    started_at: new Date().toISOString(),
    mode: 'branch',
    ollama_base_url: ollamaBaseUrl ?? 'http://localhost:11434',
    model,
  };
  await store.append(newSessionId, { seq: seq++, t: 0, type: 'meta', data: meta });

  // Copy original events up to the branch point
  for (const event of originalEvents) {
    if (event.type === 'meta') continue;
    if (event.seq > targetStep.seq) break;
    await store.append(newSessionId, { ...event, seq: seq++ });
  }

  // Record the new request (with edited messages)
  await store.append(newSessionId, {
    seq: seq++,
    t: clock.elapsed(),
    type: 'request',
    data: {
      method: 'POST',
      path: '/api/chat',
      headers: {},
      body: { model, messages, stream: false },
    },
  });

  // Record the final response
  const tokens: TokenUsage | undefined = finalResponse.tokens ? {
    prompt_tokens: finalResponse.tokens.prompt_tokens,
    completion_tokens: finalResponse.tokens.completion_tokens,
    total_tokens: finalResponse.tokens.total_tokens,
  } : undefined;

  await store.append(newSessionId, {
    seq: seq++,
    t: clock.elapsed(),
    type: 'response',
    data: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: finalResponse.raw,
      duration_ms: finalResponse.latency_ms,
      tokens,
    },
  });
}

// --- Helpers ---

interface Message {
  role: string;
  content: string;
}

type Clock = { elapsed: () => number };

interface ToolCallInfo {
  name: string;
  args: Record<string, unknown>;
}

/** Collect tool_result steps that come after the branch point */
function collectToolResults(steps: ConversationStep[], branchIndex: number): Array<{ name: string; content: string }> {
  const results: Array<{ name: string; content: string }> = [];
  for (let i = branchIndex + 1; i < steps.length; i++) {
    if (steps[i].type === 'tool_result') {
      results.push({
        name: steps[i].meta?.tool_name ?? 'unknown',
        content: steps[i].content,
      });
    }
  }
  return results;
}

/** Extract tool calls from a provider chat response */
function extractToolCallsFromResponse(response: ChatResponse): ToolCallInfo[] {
  if (!response.raw || typeof response.raw !== 'object') return [];
  const msg = extractAssistantMessage(response.raw as Record<string, unknown>);
  if (!msg) return [];
  return extractToolCalls(msg).map(tc => ({ name: tc.name, args: tc.args }));
}

/** Rebuild messages from raw events up to a given seq number */
function rebuildMessages(events: import('../types.js').ReplayEvent[], upToSeq: number): Message[] {
  const messages: Message[] = [];

  for (const event of events) {
    if (event.seq > upToSeq) break;

    if (event.type === 'request') {
      const body = event.data.body as Record<string, unknown> | undefined;
      const msgs = body?.messages as Array<Record<string, unknown>> | undefined;
      if (msgs && Array.isArray(msgs)) {
        messages.length = 0;
        for (const m of msgs) {
          messages.push({
            role: (m.role as string) ?? 'user',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          });
        }
      }
    }

    if (event.type === 'response') {
      const body = event.data.body as Record<string, unknown> | undefined;
      if (!body) continue;
      const msg = extractAssistantMessage(body);
      if (msg) {
        const content = extractAssistantContent(msg);
        if (content.trim()) {
          messages.push({ role: 'assistant', content });
        }
      }
    }

    if (event.type === 'stream_end') {
      const data = event.data as { assembled_content: string };
      if (data.assembled_content?.trim()) {
        messages.push({ role: 'assistant', content: data.assembled_content });
      }
    }
  }

  return messages;
}

/** Apply edit to messages array, truncating after the edit point */
function applyEdit(
  messages: Message[],
  targetStep: { type: string; content: string; meta?: { tool_name?: string } },
  editedContent: string,
): void {
  if (targetStep.type === 'user') {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && messages[i].content === targetStep.content) {
        messages[i].content = editedContent;
        messages.length = i + 1;
        return;
      }
    }
  }

  if (targetStep.type === 'thinking' || targetStep.type === 'answer') {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].content === targetStep.content) {
        messages[i].content = editedContent;
        messages.length = i + 1;
        return;
      }
    }
  }

  if (targetStep.type === 'tool_result') {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'tool' && messages[i].content === targetStep.content) {
        messages[i].content = editedContent;
        messages.length = i + 1;
        return;
      }
    }
  }

  if (targetStep.type === 'tool_call') {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        messages[i].content = editedContent;
        messages.length = i + 1;
        return;
      }
    }
  }

  messages.push({ role: 'user', content: editedContent });
}

function detectModel(events: import('../types.js').ReplayEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === 'meta') return event.data.model;
    if (event.type === 'request') {
      const body = event.data.body as Record<string, unknown> | undefined;
      if (body && typeof body.model === 'string') return body.model;
    }
  }
  return undefined;
}
