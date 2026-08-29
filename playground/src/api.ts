/** API client for the replay engine backend */

const BASE = '';

export interface SessionMeta {
  session_id: string;
  parent_session_id?: string;
  branch_point?: number;
  started_at: string;
  mode: string;
  ollama_base_url: string;
  model?: string;
  tags?: string[];
}

export interface SessionSummary {
  id: string;
  meta: SessionMeta | null;
  eventCount: number;
}

export interface ReplayEvent {
  seq: number;
  t: number;
  type: string;
  data: Record<string, unknown>;
}

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
  provider?: string;
}

export interface DiffTurn {
  turnIndex: number;
  session1: { session: string; index: number; request: { role: string; content: string; model?: string }; response: { content: string; duration_ms: number } } | null;
  session2: { session: string; index: number; request: { role: string; content: string; model?: string }; response: { content: string; duration_ms: number } } | null;
  differs: boolean;
}

export interface DiffResult {
  session1: string;
  session2: string;
  totalTurns: number;
  comparisons: DiffTurn[];
}

export async function fetchSessions(): Promise<SessionSummary[]> {
  const res = await fetch(`${BASE}/api/sessions`);
  return res.json();
}

export async function fetchSession(id: string): Promise<{ id: string; events: ReplayEvent[] }> {
  const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(id)}`);
  return res.json();
}

export async function deleteSession(id: string): Promise<void> {
  await fetch(`${BASE}/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function fetchModels(): Promise<OllamaModel[]> {
  const res = await fetch(`${BASE}/api/models`);
  return res.json();
}

export async function createBranch(parentSessionId: string, branchAt: number, patch: Record<string, unknown>, newSessionId?: string): Promise<{ sessionId: string; eventsKept: number; patchesApplied: string[] }> {
  const res = await fetch(`${BASE}/api/branch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parentSessionId, branchAt, patch, newSessionId }),
  });
  return res.json();
}

export async function reExecute(parentSessionId: string, patch: Record<string, unknown>, newSessionId?: string): Promise<{ sessionId: string; turnsExecuted: number; totalTokens: { total_tokens: number }; durationMs: number }> {
  const res = await fetch(`${BASE}/api/reexec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parentSessionId, patch, newSessionId }),
  });
  return res.json();
}

export async function fetchDiff(id1: string, id2: string): Promise<DiffResult> {
  const res = await fetch(`${BASE}/api/diff/${encodeURIComponent(id1)}/${encodeURIComponent(id2)}`);
  return res.json();
}

export async function startCapture(sessionId?: string): Promise<{ sessionId: string; port: number }> {
  const res = await fetch(`${BASE}/api/capture/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  return res.json();
}

export async function stopCapture(): Promise<{ sessionId: string }> {
  const res = await fetch(`${BASE}/api/capture/stop`, { method: 'POST' });
  return res.json();
}

export interface ProviderInfo {
  name: string;
  type: string;
  baseUrl: string;
  hasApiKey: boolean;
  routes: string[];
}

export interface JudgeScore {
  accuracy: number;
  completeness: number;
  conciseness: number;
  safety: number;
  relevance: number;
  coherence: number;
  total: number;
}

export interface TurnJudgment {
  turnIndex: number;
  question: string;
  scoreA: JudgeScore;
  scoreB: JudgeScore;
  winner: 'a' | 'b' | 'tie';
  reason: string;
}

export interface JudgeResult {
  sessionA: string;
  sessionB: string;
  judgeModel: string;
  turns: TurnJudgment[];
  overall: {
    winner: 'a' | 'b' | 'tie';
    scoreA: number;
    scoreB: number;
    summary: string;
  };
}

export async function fetchProviders(): Promise<ProviderInfo[]> {
  const res = await fetch(`${BASE}/api/providers`);
  return res.json();
}

export async function judgeCompare(session1: string, session2: string, judgeModel?: string): Promise<JudgeResult> {
  const res = await fetch(`${BASE}/api/judge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session1, session2, judgeModel }),
  });
  return res.json();
}
