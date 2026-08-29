import { describe, it, expect } from 'vitest';
import { detectIssues } from '../analysis/issue-detector.js';
import type { ParsedSession, ConversationStep } from '../analysis/conversation-parser.js';

function makeSession(steps: ConversationStep[], id = 'test'): ParsedSession {
  return {
    session_id: id,
    model: 'test-model',
    steps,
    summary: { total_steps: steps.length, tool_calls: 0, tools_used: [], total_tokens: 0, total_latency_ms: 0, outcome: 'unknown', one_liner: '' },
  };
}

function step(type: ConversationStep['type'], index: number, content: string, meta?: ConversationStep['meta']): ConversationStep {
  return { type, index, seq: index, time_ms: index * 100, content, meta };
}

describe('Issue Detector', () => {
  describe('loop detection', () => {
    it('detects 3+ identical tool calls as critical loop', () => {
      const s = makeSession([
        step('user', 0, 'do something'),
        step('tool_call', 1, 'calc({"q":"1+1"})'),
        step('tool_result', 2, '2'),
        step('tool_call', 3, 'calc({"q":"1+1"})'),
        step('tool_result', 4, '2'),
        step('tool_call', 5, 'calc({"q":"1+1"})'),
        step('tool_result', 6, '2'),
      ]);
      const report = detectIssues(s);
      const loop = report.issues.find(i => i.type === 'loop');
      expect(loop).toBeDefined();
      expect(loop!.severity).toBe('critical');
      expect(loop!.steps).toEqual([1, 3, 5]);
    });

    it('detects 2 identical calls as warning (repeated_call)', () => {
      const s = makeSession([
        step('tool_call', 0, 'fetch({"url":"x"})'),
        step('tool_result', 1, 'ok'),
        step('tool_call', 2, 'fetch({"url":"x"})'),
        step('tool_result', 3, 'ok'),
      ]);
      const report = detectIssues(s);
      expect(report.issues.find(i => i.type === 'repeated_call')).toBeDefined();
    });

    it('ignores different args', () => {
      const s = makeSession([
        step('tool_call', 0, 'calc({"q":"1+1"})'),
        step('tool_call', 1, 'calc({"q":"2+2"})'),
        step('tool_call', 2, 'calc({"q":"3+3"})'),
      ]);
      const report = detectIssues(s);
      expect(report.issues.filter(i => i.type === 'loop')).toHaveLength(0);
    });
  });

  describe('empty tool args', () => {
    it('flags tool call with no args', () => {
      const s = makeSession([
        step('tool_call', 0, 'search({})', { tool_name: 'search', tool_args: {} }),
      ]);
      const report = detectIssues(s);
      const issue = report.issues.find(i => i.type === 'empty_args');
      expect(issue).toBeDefined();
      expect(issue!.message).toContain('search');
    });

    it('flags tool call with undefined args', () => {
      const s = makeSession([
        step('tool_call', 0, 'search()', { tool_name: 'search' }),
      ]);
      const report = detectIssues(s);
      expect(report.issues.find(i => i.type === 'empty_args')).toBeDefined();
    });

    it('does not flag tool call with args', () => {
      const s = makeSession([
        step('tool_call', 0, 'search({"q":"hi"})', { tool_name: 'search', tool_args: { q: 'hi' } }),
      ]);
      const report = detectIssues(s);
      expect(report.issues.filter(i => i.type === 'empty_args')).toHaveLength(0);
    });
  });

  describe('ignored errors', () => {
    it('flags tool error not acknowledged by next step', () => {
      const s = makeSession([
        step('tool_result', 0, 'Error: connection timeout'),
        step('thinking', 1, 'Let me try a different approach to solve the math problem'),
      ]);
      const report = detectIssues(s);
      const issue = report.issues.find(i => i.type === 'ignored_error');
      expect(issue).toBeDefined();
      expect(issue!.steps).toEqual([0, 1]);
    });

    it('does not flag when error is acknowledged', () => {
      const s = makeSession([
        step('tool_result', 0, 'Error: connection timeout'),
        step('thinking', 1, 'The tool returned an error, I should retry with different params'),
      ]);
      const report = detectIssues(s);
      expect(report.issues.filter(i => i.type === 'ignored_error')).toHaveLength(0);
    });

    it('does not flag non-error tool results', () => {
      const s = makeSession([
        step('tool_result', 0, 'The result is 42'),
        step('thinking', 1, 'Great, now let me continue'),
      ]);
      const report = detectIssues(s);
      expect(report.issues.filter(i => i.type === 'ignored_error')).toHaveLength(0);
    });
  });

  describe('token waste (duplicate thinking)', () => {
    it('detects identical thinking steps', () => {
      const longContent = 'Let me analyze this problem step by step and consider all the relevant factors here';
      const s = makeSession([
        step('thinking', 0, longContent),
        step('tool_call', 1, 'x({"a":"b"})'),
        step('thinking', 2, longContent),
      ]);
      const report = detectIssues(s);
      expect(report.issues.find(i => i.type === 'duplicate_thinking')).toBeDefined();
    });

    it('ignores short identical content', () => {
      const s = makeSession([
        step('thinking', 0, 'OK'),
        step('thinking', 1, 'OK'),
      ]);
      const report = detectIssues(s);
      expect(report.issues.filter(i => i.type === 'duplicate_thinking')).toHaveLength(0);
    });
  });

  describe('no final answer', () => {
    it('flags session with no answer step', () => {
      const s = makeSession([
        step('user', 0, 'hello'),
        step('thinking', 1, 'thinking...'),
        step('tool_call', 2, 'search({"q":"hello"})'),
      ]);
      const report = detectIssues(s);
      expect(report.issues.find(i => i.type === 'no_answer')).toBeDefined();
    });

    it('does not flag session with answer', () => {
      const s = makeSession([
        step('user', 0, 'hello'),
        step('answer', 1, 'Hi there!'),
      ]);
      const report = detectIssues(s);
      expect(report.issues.filter(i => i.type === 'no_answer')).toHaveLength(0);
    });

    it('does not flag very short sessions', () => {
      const s = makeSession([
        step('user', 0, 'hello'),
        step('thinking', 1, 'hmm'),
      ]);
      const report = detectIssues(s);
      expect(report.issues.filter(i => i.type === 'no_answer')).toHaveLength(0);
    });
  });

  describe('scoring', () => {
    it('healthy session scores 100', () => {
      const s = makeSession([
        step('user', 0, 'hello'),
        step('answer', 1, 'Hi!'),
      ]);
      expect(detectIssues(s).score).toBe(100);
    });

    it('critical issues deduct 25', () => {
      const s = makeSession([
        step('tool_call', 0, 'x({"a":"b"})'),
        step('tool_call', 1, 'x({"a":"b"})'),
        step('tool_call', 2, 'x({"a":"b"})'),
        step('answer', 3, 'done'),
      ]);
      const report = detectIssues(s);
      expect(report.issues.some(i => i.severity === 'critical')).toBe(true);
      expect(report.score).toBeLessThanOrEqual(75);
    });

    it('score floors at 0', () => {
      const s = makeSession([
        step('tool_call', 0, 'a({"x":"1"})'), step('tool_call', 1, 'a({"x":"1"})'), step('tool_call', 2, 'a({"x":"1"})'),
        step('tool_call', 3, 'b({"x":"1"})'), step('tool_call', 4, 'b({"x":"1"})'), step('tool_call', 5, 'b({"x":"1"})'),
        step('tool_call', 6, 'c({"x":"1"})'), step('tool_call', 7, 'c({"x":"1"})'), step('tool_call', 8, 'c({"x":"1"})'),
        step('tool_call', 9, 'd({"x":"1"})'), step('tool_call', 10, 'd({"x":"1"})'), step('tool_call', 11, 'd({"x":"1"})'),
        step('tool_call', 12, 'e({"x":"1"})'), step('tool_call', 13, 'e({"x":"1"})'), step('tool_call', 14, 'e({"x":"1"})'),
      ]);
      expect(detectIssues(s).score).toBe(0);
    });
  });
});
