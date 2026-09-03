/**
 * Conversation Parser — turns raw HTTP request/response events into
 * a readable agent conversation timeline.
 *
 * Handles:
 * - OpenAI format (tool_calls in response, tool role in messages)
 * - Anthropic format (tool_use content blocks, tool_result blocks)
 * - Ollama format (same as OpenAI)
 * - Plain chat (no tools, just messages back and forth)
 *
 * Output: A linear array of "steps" that tell the story of what the agent did.
 */

import {
  extractAssistantMessage, extractAssistantContent, extractToolCalls,
  extractTokensFromBody, extractImages,
} from '../providers/response-format.js';
import type { ReplayEvent } from '../types.js';

// --- Output types (what the UI renders) ---

export type StepType = 'user' | 'thinking' | 'tool_call' | 'tool_result' | 'answer' | 'error';

export interface ConversationStep {
  type: StepType;
  index: number;
  /** Original event seq number (for linking back to raw data) */
  seq: number;
  /** Timestamp relative to session start */
  time_ms: number;
  /** Main content to display */
  content: string;
  /** Additional metadata */
  meta?: {
    tool_name?: string;
    tool_args?: Record<string, unknown>;
    model?: string;
    tokens?: { prompt: number; completion: number };
    latency_ms?: number;
    /** Image URLs or base64 data URIs from vision messages */
    images?: string[];
  };
}

export interface ParsedSession {
  session_id: string;
  model: string;
  steps: ConversationStep[];
  summary: {
    total_steps: number;
    tool_calls: number;
    tools_used: string[];
    total_tokens: number;
    total_latency_ms: number;
    outcome: 'success' | 'error' | 'unknown';
    one_liner: string;
  };
}

// --- Parser ---

export function parseConversation(sessionId: string, events: ReplayEvent[]): ParsedSession {
  const steps: ConversationStep[] = [];
  let model = '';
  let totalTokens = 0;
  let totalLatency = 0;
  let stepIndex = 0;
  const toolsUsed = new Set<string>();

  // Extract model from meta or first request
  const meta = events.find(e => e.type === 'meta');
  if (meta?.type === 'meta') model = meta.data.model ?? '';

  // Pre-collect tool results by call ID so we can pair them with calls
  const pendingToolResults = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'request') {
      const body = event.data.body as Record<string, unknown> | undefined;
      const messages = body?.messages as Array<Record<string, unknown>> | undefined;
      if (messages) {
        for (const msg of messages) {
          if (msg.role === 'tool' && msg.tool_call_id) {
            pendingToolResults.set(msg.tool_call_id as string, extractAssistantContent(msg));
          }
        }
      }
    }
  }

  // Track user messages already added (by content) to avoid duplicates from repeated history
  const seenUserMessages = new Set<string>();

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    if (event.type === 'request') {
      const body = event.data.body as Record<string, unknown> | undefined;
      if (!body) continue;

      if (!model && typeof body.model === 'string') model = body.model;

      const messages = body.messages as Array<Record<string, unknown>> | undefined;
      if (!messages || !Array.isArray(messages)) continue;

      // Find all new messages since we track the conversation growth
      // Check every message for user content
      for (const msg of messages) {
        const role = msg.role as string;

        if (role === 'user') {
          const content = extractAssistantContent(msg);
          if (content.startsWith('OBSERVATION:') || content.startsWith('Tool result:')) continue;
          if (!seenUserMessages.has(content)) {
            seenUserMessages.add(content);
            const images = extractImages(msg);
            steps.push({
              type: 'user',
              index: stepIndex++,
              seq: event.seq,
              time_ms: event.t,
              content,
              meta: images.length > 0 ? { images } : undefined,
            });
          }
        }
        // Tool results are now handled by matching with tool calls in parseAssistantMessage
      }
    }

    if (event.type === 'response') {
      const body = event.data.body as Record<string, unknown> | undefined;
      if (!body) continue;

      const latency = event.data.duration_ms ?? 0;
      totalLatency += latency;

      // Extract tokens (any provider format)
      const tokens = extractTokensFromBody(body);
      const promptTokens = tokens?.prompt_tokens ?? 0;
      const completionTokens = tokens?.completion_tokens ?? 0;
      totalTokens += promptTokens + completionTokens;

      // Extract assistant message (any provider format)
      const msg = extractAssistantMessage(body);
      if (msg) {
        parseAssistantMessage(msg, event, latency, promptTokens, completionTokens);
      }
    }

    // Stream end events (for streaming sessions)
    if (event.type === 'stream_end') {
      const data = event.data as { assembled_content: string; duration_ms: number; tokens?: { prompt_tokens: number; completion_tokens: number } };
      totalLatency += data.duration_ms;
      if (data.tokens) totalTokens += data.tokens.prompt_tokens + data.tokens.completion_tokens;

      steps.push({
        type: 'thinking',
        index: stepIndex++,
        seq: event.seq,
        time_ms: event.t,
        content: data.assembled_content,
        meta: {
          latency_ms: data.duration_ms,
          tokens: data.tokens ? { prompt: data.tokens.prompt_tokens, completion: data.tokens.completion_tokens } : undefined,
        },
      });
    }
  }

  // Helper: parse an assistant message (any provider format)
  function parseAssistantMessage(
    msg: Record<string, unknown>,
    event: ReplayEvent,
    latency: number,
    promptTokens: number,
    completionTokens: number,
  ) {
    const content = extractAssistantContent(msg);
    const toolCallsParsed = extractToolCalls(msg);

    // If has tool calls — it's a tool invocation
    if (toolCallsParsed.length > 0) {
      // First, add thinking if there's also text content
      if (content.trim()) {
        steps.push({
          type: 'thinking',
          index: stepIndex++,
          seq: event.seq,
          time_ms: event.t,
          content,
          meta: { latency_ms: latency, tokens: { prompt: promptTokens, completion: completionTokens } },
        });
      }

      for (const tc of toolCallsParsed) {
        toolsUsed.add(tc.name);

        // Add tool call step
        steps.push({
          type: 'tool_call',
          index: stepIndex++,
          seq: event.seq,
          time_ms: event.t,
          content: `${tc.name}(${JSON.stringify(tc.args)})`,
          meta: { tool_name: tc.name, tool_args: tc.args },
        });

        // Look ahead for the matching tool result in subsequent events
        if (tc.id) {
          const resultContent = pendingToolResults.get(tc.id);
          if (resultContent !== undefined) {
            steps.push({
              type: 'tool_result',
              index: stepIndex++,
              seq: event.seq,
              time_ms: event.t,
              content: resultContent,
              meta: { tool_name: tc.name },
            });
            pendingToolResults.delete(tc.id);
          }
        }
      }
    } else if (content.trim()) {
      // No tool calls — it's thinking or a final answer
      const isLast = !events.slice(events.indexOf(event) + 1).some(e => e.type === 'response' || e.type === 'stream_end');

      steps.push({
        type: isLast ? 'answer' : 'thinking',
        index: stepIndex++,
        seq: event.seq,
        time_ms: event.t,
        content,
        meta: { latency_ms: latency, tokens: { prompt: promptTokens, completion: completionTokens }, model },
      });
    }
  }

  // Build summary
  const toolCallCount = steps.filter(s => s.type === 'tool_call').length;
  const lastStep = steps[steps.length - 1];
  const outcome = lastStep?.type === 'answer' ? 'success' : lastStep?.type === 'error' ? 'error' : 'unknown';

  // Generate one-liner from first user message + outcome
  const userStep = steps.find(s => s.type === 'user');
  const answerStep = steps.find(s => s.type === 'answer');
  let oneLiner = '';
  if (userStep) {
    oneLiner = userStep.content.slice(0, 80);
    if (answerStep) oneLiner += ' → completed';
    else oneLiner += ' → ' + (outcome === 'error' ? 'failed' : 'incomplete');
  }

  return {
    session_id: sessionId,
    model,
    steps,
    summary: {
      total_steps: steps.length,
      tool_calls: toolCallCount,
      tools_used: [...toolsUsed],
      total_tokens: totalTokens,
      total_latency_ms: totalLatency,
      outcome,
      one_liner: oneLiner,
    },
  };
}
