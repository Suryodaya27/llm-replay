import { describe, it, expect } from 'vitest';
import { parseResponseBody, extractTokensFromBody, parseStreamChunk, extractToolCalls } from '../providers/response-format.js';

describe('parseResponseBody', () => {
  describe('OpenAI format', () => {
    it('extracts content and tokens', () => {
      const body = {
        id: 'chatcmpl-123',
        model: 'gpt-4o',
        choices: [{ message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      const r = parseResponseBody(body);
      expect(r.content).toBe('Hello!');
      expect(r.tokens?.prompt_tokens).toBe(10);
      expect(r.tokens?.completion_tokens).toBe(5);
      expect(r.tokens?.total_tokens).toBe(15);
      expect(r.model).toBe('gpt-4o');
      expect(r.toolCalls).toHaveLength(0);
    });

    it('extracts tool calls', () => {
      const body = {
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_1',
              function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
            }],
          },
        }],
      };
      const r = parseResponseBody(body);
      expect(r.toolCalls).toHaveLength(1);
      expect(r.toolCalls[0].name).toBe('get_weather');
      expect(r.toolCalls[0].args).toEqual({ city: 'NYC' });
      expect(r.toolCalls[0].id).toBe('call_1');
    });
  });

  describe('Anthropic format', () => {
    it('extracts content and tokens', () => {
      const body = {
        id: 'msg_123',
        model: 'claude-sonnet-4-20250514',
        content: [{ type: 'text', text: 'Hello from Claude!' }],
        usage: { input_tokens: 20, output_tokens: 8 },
        stop_reason: 'end_turn',
      };
      const r = parseResponseBody(body);
      expect(r.content).toBe('Hello from Claude!');
      expect(r.tokens?.prompt_tokens).toBe(20);
      expect(r.tokens?.completion_tokens).toBe(8);
      expect(r.tokens?.total_tokens).toBe(28);
      expect(r.model).toBe('claude-sonnet-4-20250514');
    });

    it('extracts tool use blocks', () => {
      const body = {
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'tu_1', name: 'search', input: { query: 'vitest' } },
        ],
      };
      const r = parseResponseBody(body);
      expect(r.content).toBe('Let me check.');
      expect(r.toolCalls).toHaveLength(1);
      expect(r.toolCalls[0].name).toBe('search');
      expect(r.toolCalls[0].args).toEqual({ query: 'vitest' });
    });
  });

  describe('Ollama /api/chat format', () => {
    it('extracts content and tokens', () => {
      const body = {
        model: 'llama3',
        message: { role: 'assistant', content: 'Hi there' },
        prompt_eval_count: 15,
        eval_count: 10,
        eval_duration: 500000000, // 0.5s in nanoseconds
      };
      const r = parseResponseBody(body);
      expect(r.content).toBe('Hi there');
      expect(r.tokens?.prompt_tokens).toBe(15);
      expect(r.tokens?.completion_tokens).toBe(10);
      expect(r.tokens?.total_tokens).toBe(25);
      expect(r.tokens?.tokens_per_second).toBe(20); // 10 / 0.5s
      expect(r.model).toBe('llama3');
    });
  });

  describe('Ollama /api/generate format', () => {
    it('extracts response string', () => {
      const body = {
        model: 'llama3',
        response: 'Generated text here',
        prompt_eval_count: 5,
        eval_count: 12,
      };
      const r = parseResponseBody(body);
      expect(r.content).toBe('Generated text here');
      expect(r.tokens?.total_tokens).toBe(17);
    });
  });

  describe('edge cases', () => {
    it('handles null body', () => {
      const r = parseResponseBody(null);
      expect(r.content).toBe('');
      expect(r.tokens).toBeUndefined();
    });

    it('handles empty object', () => {
      const r = parseResponseBody({});
      expect(r.content).toBe('{}');
    });

    it('handles unknown shape', () => {
      const r = parseResponseBody({ foo: 'bar' });
      expect(r.content).toBe('{"foo":"bar"}');
      expect(r.tokens).toBeUndefined();
    });
  });
});

describe('extractTokensFromBody', () => {
  it('extracts OpenAI usage', () => {
    const t = extractTokensFromBody({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    expect(t?.prompt_tokens).toBe(10);
    expect(t?.completion_tokens).toBe(5);
  });

  it('extracts Anthropic usage', () => {
    const t = extractTokensFromBody({ usage: { input_tokens: 20, output_tokens: 8 } });
    expect(t?.prompt_tokens).toBe(20);
    expect(t?.completion_tokens).toBe(8);
    expect(t?.total_tokens).toBe(28);
  });

  it('extracts Ollama tokens', () => {
    const t = extractTokensFromBody({ prompt_eval_count: 15, eval_count: 10 });
    expect(t?.prompt_tokens).toBe(15);
    expect(t?.completion_tokens).toBe(10);
  });

  it('returns undefined for no token info', () => {
    expect(extractTokensFromBody({ content: 'hello' })).toBeUndefined();
  });
});

describe('parseStreamChunk', () => {
  it('parses OpenAI SSE chunk', () => {
    const chunk = { choices: [{ delta: { content: 'Hi' }, finish_reason: null }] };
    const p = parseStreamChunk(chunk);
    expect(p.content).toBe('Hi');
    expect(p.done).toBe(false);
  });

  it('detects OpenAI stop', () => {
    const chunk = { choices: [{ delta: {}, finish_reason: 'stop' }] };
    expect(parseStreamChunk(chunk).done).toBe(true);
  });

  it('parses Anthropic content_block_delta', () => {
    const chunk = { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } };
    const p = parseStreamChunk(chunk);
    expect(p.content).toBe('Hello');
    expect(p.done).toBe(false);
  });

  it('detects Anthropic message_stop', () => {
    expect(parseStreamChunk({ type: 'message_stop' }).done).toBe(true);
  });

  it('parses Ollama chat chunk', () => {
    const chunk = { message: { content: 'tok' }, done: false };
    const p = parseStreamChunk(chunk);
    expect(p.content).toBe('tok');
    expect(p.done).toBe(false);
  });

  it('parses Ollama final chunk with tokens', () => {
    const chunk = { message: { content: '' }, done: true, prompt_eval_count: 10, eval_count: 20 };
    const p = parseStreamChunk(chunk);
    expect(p.done).toBe(true);
    expect(p.tokens?.prompt_tokens).toBe(10);
    expect(p.tokens?.completion_tokens).toBe(20);
  });

  it('parses Ollama generate chunk', () => {
    const chunk = { response: 'word', done: false };
    expect(parseStreamChunk(chunk).content).toBe('word');
  });
});

describe('extractToolCalls', () => {
  it('parses OpenAI tool_calls with string arguments', () => {
    const msg = {
      tool_calls: [{ id: 'c1', function: { name: 'fn', arguments: '{"a":1}' } }],
    };
    const calls = extractToolCalls(msg);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ name: 'fn', args: { a: 1 }, id: 'c1' });
  });

  it('parses Anthropic tool_use in content', () => {
    const msg = {
      content: [
        { type: 'text', text: 'thinking' },
        { type: 'tool_use', id: 't1', name: 'search', input: { q: 'hi' } },
      ],
    };
    const calls = extractToolCalls(msg);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('search');
    expect(calls[0].args).toEqual({ q: 'hi' });
  });

  it('returns empty for plain message', () => {
    expect(extractToolCalls({ content: 'just text' })).toHaveLength(0);
  });
});
