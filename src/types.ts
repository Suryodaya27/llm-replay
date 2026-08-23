/**
 * Core event types for the replay engine.
 *
 * Design pattern: Discriminated Union (tagged union)
 * Every event has a `type` field that narrows its shape at compile time.
 * This gives exhaustive switch checking and zero runtime cost.
 */

// --- Session metadata ---

export interface SessionMeta {
  session_id: string;
  parent_session_id?: string; // set when branched
  branch_point?: number; // seq number where the branch started
  started_at: string; // ISO 8601
  mode: 'capture' | 'replay' | 'branch';
  ollama_base_url: string;
  model?: string;
  tags?: string[];
}

// --- Event types (discriminated union) ---

export interface MetaEvent {
  seq: number;
  t: number; // ms since session start
  type: 'meta';
  data: SessionMeta;
}

export interface RequestEvent {
  seq: number;
  t: number;
  type: 'request';
  data: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  };
}

export interface ResponseEvent {
  seq: number;
  t: number;
  type: 'response';
  data: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
    duration_ms: number;
    tokens?: TokenUsage;
  };
}

export interface ToolCallEvent {
  seq: number;
  t: number;
  type: 'tool_call';
  data: {
    name: string;
    args: Record<string, unknown>;
  };
}

export interface ToolResultEvent {
  seq: number;
  t: number;
  type: 'tool_result';
  data: {
    name: string;
    result: unknown;
    error?: string;
    duration_ms: number;
  };
}

export interface ErrorEvent {
  seq: number;
  t: number;
  type: 'error';
  data: {
    message: string;
    code?: string;
    context?: Record<string, unknown>;
  };
}

/** A single chunk in a streaming response (Ollama NDJSON) */
export interface StreamChunkEvent {
  seq: number;
  t: number;
  type: 'stream_chunk';
  data: {
    index: number; // chunk index within this stream
    chunk: unknown; // raw Ollama chunk JSON
  };
}

/** Final aggregated result after a streaming response completes */
export interface StreamEndEvent {
  seq: number;
  t: number;
  type: 'stream_end';
  data: {
    chunks_count: number;
    assembled_content: string; // full concatenated text
    duration_ms: number;
    tokens?: TokenUsage;
  };
}

/** Token usage extracted from Ollama responses */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  tokens_per_second?: number;
}

// The union
export type ReplayEvent =
  | MetaEvent
  | RequestEvent
  | ResponseEvent
  | ToolCallEvent
  | ToolResultEvent
  | ErrorEvent
  | StreamChunkEvent
  | StreamEndEvent;

// --- Proxy mode ---

export type ProxyMode = 'capture' | 'replay';

// --- Session stats ---

export interface SessionStats {
  session_id: string;
  total_turns: number;
  total_tokens: TokenUsage;
  avg_latency_ms: number;
  total_duration_ms: number;
  model?: string;
  turns: TurnStats[];
}

export interface TurnStats {
  index: number;
  request_seq: number;
  response_seq: number;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  streamed: boolean;
}

// --- CI Assertion types ---

export type AssertionType =
  | 'contains'
  | 'not_contains'
  | 'matches_regex'
  | 'json_valid'
  | 'max_tokens'
  | 'max_latency_ms'
  | 'custom';

export interface Assertion {
  type: AssertionType;
  target?: 'response' | 'all'; // which turn(s) to check, default 'all'
  turn?: number; // specific turn index (0-based), omit for all
  value: string | number;
}

export interface TestResult {
  session_id: string;
  passed: boolean;
  assertions: AssertionResult[];
  stats: SessionStats;
}

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  actual?: string;
  message?: string;
}
