/**
 * Issue Detector — analyzes a parsed session and flags problems.
 *
 * Detects:
 * - Loops: same tool called with same args repeatedly
 * - Ignored errors: tool returned error but agent continued without addressing it
 * - Token waste: identical or near-identical messages sent multiple times
 * - Stuck agent: no progress across multiple turns
 * - Empty tool args: model failed to pass required arguments
 *
 * Returns a list of issues with severity, description, and the step where it happened.
 */

import type { ParsedSession, ConversationStep } from './conversation-parser.js';

export type IssueSeverity = 'critical' | 'warning' | 'info';

export interface Issue {
  severity: IssueSeverity;
  type: string;
  message: string;
  steps: number[]; // step indices involved
}

export interface IssueReport {
  session_id: string;
  issues: Issue[];
  score: number; // 0-100, higher = healthier
}

export function detectIssues(session: ParsedSession): IssueReport {
  const issues: Issue[] = [];

  detectLoops(session.steps, issues);
  detectEmptyToolArgs(session.steps, issues);
  detectIgnoredErrors(session.steps, issues);
  detectTokenWaste(session.steps, issues);
  detectNoFinalAnswer(session.steps, issues);

  // Score: start at 100, deduct per issue
  let score = 100;
  for (const issue of issues) {
    if (issue.severity === 'critical') score -= 25;
    else if (issue.severity === 'warning') score -= 10;
    else score -= 3;
  }

  return {
    session_id: session.session_id,
    issues,
    score: Math.max(0, score),
  };
}

/** Detect repeated tool calls with same name + same args */
function detectLoops(steps: ConversationStep[], issues: Issue[]): void {
  const toolCalls = steps.filter(s => s.type === 'tool_call');
  const seen = new Map<string, number[]>();

  for (const step of toolCalls) {
    const key = step.content; // "tool_name({args})"
    const existing = seen.get(key) ?? [];
    existing.push(step.index);
    seen.set(key, existing);
  }

  for (const [call, indices] of seen) {
    if (indices.length >= 3) {
      issues.push({
        severity: 'critical',
        type: 'loop',
        message: `Agent called "${call.slice(0, 60)}" ${indices.length} times with identical args — stuck in a loop`,
        steps: indices,
      });
    } else if (indices.length === 2) {
      issues.push({
        severity: 'warning',
        type: 'repeated_call',
        message: `Agent called "${call.slice(0, 60)}" twice with same args — possible retry or loop`,
        steps: indices,
      });
    }
  }
}

/** Detect tool calls where the model sent empty or missing arguments */
function detectEmptyToolArgs(steps: ConversationStep[], issues: Issue[]): void {
  for (const step of steps) {
    if (step.type !== 'tool_call') continue;
    const args = step.meta?.tool_args;
    if (!args || Object.keys(args).length === 0) {
      issues.push({
        severity: 'warning',
        type: 'empty_args',
        message: `Tool "${step.meta?.tool_name ?? 'unknown'}" called with no arguments — model may not understand the tool schema`,
        steps: [step.index],
      });
    }
  }
}

/** Detect tool results that contain errors but agent doesn't address them */
function detectIgnoredErrors(steps: ConversationStep[], issues: Issue[]): void {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.type !== 'tool_result') continue;

    const content = step.content.toLowerCase();
    const hasError = content.includes('error') || content.includes('failed') || content.includes('exception') || content.includes('timeout');
    if (!hasError) continue;

    // Check if the next thinking/answer step acknowledges the error
    const nextStep = steps[i + 1];
    if (nextStep && (nextStep.type === 'thinking' || nextStep.type === 'answer')) {
      const nextContent = nextStep.content.toLowerCase();
      const acknowledges = nextContent.includes('error') || nextContent.includes('fail') || nextContent.includes('retry') || nextContent.includes('issue');
      if (!acknowledges) {
        issues.push({
          severity: 'warning',
          type: 'ignored_error',
          message: `Tool returned an error at step ${step.index} but agent didn't acknowledge it in the next response`,
          steps: [step.index, nextStep.index],
        });
      }
    }
  }
}

/** Detect near-identical messages (token waste) */
function detectTokenWaste(steps: ConversationStep[], issues: Issue[]): void {
  const thinkingSteps = steps.filter(s => s.type === 'thinking');

  for (let i = 0; i < thinkingSteps.length; i++) {
    for (let j = i + 1; j < thinkingSteps.length; j++) {
      const a = thinkingSteps[i].content.slice(0, 200);
      const b = thinkingSteps[j].content.slice(0, 200);
      if (a === b && a.length > 50) {
        issues.push({
          severity: 'info',
          type: 'duplicate_thinking',
          message: `Steps ${thinkingSteps[i].index} and ${thinkingSteps[j].index} have identical content — possible token waste`,
          steps: [thinkingSteps[i].index, thinkingSteps[j].index],
        });
      }
    }
  }
}

/** Detect sessions that never reach a final answer */
function detectNoFinalAnswer(steps: ConversationStep[], issues: Issue[]): void {
  const hasAnswer = steps.some(s => s.type === 'answer');
  if (!hasAnswer && steps.length > 2) {
    issues.push({
      severity: 'warning',
      type: 'no_answer',
      message: 'Agent never produced a final answer — may have hit max iterations or crashed',
      steps: [steps[steps.length - 1]?.index ?? 0],
    });
  }
}
