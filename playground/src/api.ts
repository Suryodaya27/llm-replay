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

export interface BranchResult {
  sessionId: string;
  parentSessionId: string;
  branchAtStep: number;
  originalContent: string;
  editedContent: string;
  newSteps: Array<{ role: string; content: string }>;
  newResponse: string;
  totalTokens: number;
  turns: number;
  durationMs: number;
}

export async function createBranch(sessionId: string, stepIndex: number, editedContent: string, newSessionId?: string): Promise<BranchResult> {
  const res = await fetch(`${BASE}/api/branch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, stepIndex, editedContent, newSessionId }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error ?? 'Branch failed');
  }
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

export interface SessionCompareSummary {
  sessionId: string;
  model: string;
  outcome: string;
  finalAnswer: string | null;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalTurns: number;
  avgLatencyMs: number;
  totalDurationMs: number;
  toolCalls: number;
  toolsUsed: string[];
  healthScore: number;
  issueCount: number;
  issues: Array<{ severity: string; type: string; message: string }>;
  totalSteps: number;
}

export interface CompareResult {
  session1: SessionCompareSummary;
  session2: SessionCompareSummary;
}

export async function fetchCompare(id1: string, id2: string): Promise<CompareResult> {
  const res = await fetch(`${BASE}/api/compare/${encodeURIComponent(id1)}/${encodeURIComponent(id2)}`);
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

export async function fetchProviders(): Promise<ProviderInfo[]> {
  const res = await fetch(`${BASE}/api/providers`);
  return res.json();
}
