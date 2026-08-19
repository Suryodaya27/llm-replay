import { useEffect, useState } from 'react';
import { fetchSession, fetchModels, createBranch, reExecute, type ReplayEvent, type OllamaModel } from '../api';
import BranchModal from './BranchModal';

interface Props {
  sessionId: string;
  onBack: () => void;
  onBranchCreated: (newSessionId: string) => void;
}

export default function Timeline({ sessionId, onBack, onBranchCreated }: Props) {
  const [events, setEvents] = useState<ReplayEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [branchAt, setBranchAt] = useState<number | null>(null);
  const [models, setModels] = useState<OllamaModel[]>([]);

  useEffect(() => {
    loadSession();
    fetchModels().then(setModels).catch(() => { });
  }, [sessionId]);

  const loadSession = async () => {
    setLoading(true);
    const data = await fetchSession(sessionId);
    setEvents(data.events);
    setLoading(false);
  };

  const handleBranch = async (mode: 'reexec' | 'branch', model: string, prompt: string) => {
    if (branchAt === null) return;
    const patch: Record<string, unknown> = {};
    if (model) patch.model = model;
    if (prompt) patch.system_prompt = prompt;

    if (mode === 'reexec') {
      const result = await reExecute(sessionId, patch);
      setBranchAt(null);
      onBranchCreated(result.sessionId);
    } else {
      const result = await createBranch(sessionId, branchAt, patch);
      setBranchAt(null);
      onBranchCreated(result.sessionId);
    }
  };

  const formatTime = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const getEventSummary = (event: ReplayEvent): string => {
    switch (event.type) {
      case 'meta': {
        const d = event.data as Record<string, unknown>;
        const model = (d as { model?: string }).model;
        return model ? `Session started with ${model}` : 'Session started';
      }
      case 'request': {
        const d = event.data as { method: string; path: string; body?: { messages?: Array<{ role: string; content: string }> } };
        const msgs = d.body?.messages;
        const lastUser = msgs?.filter((m) => m.role === 'user').pop();
        if (lastUser) return lastUser.content.slice(0, 300);
        return `${d.method} ${d.path}`;
      }
      case 'response': {
        const d = event.data as { status: number; duration_ms: number; body?: { message?: { content?: string } } };
        const content = d.body?.message?.content;
        if (content) return content.slice(0, 400);
        return `Status ${d.status} (${formatTime(d.duration_ms)})`;
      }
      case 'stream_end': {
        const d = event.data as { chunks_count: number; assembled_content: string; duration_ms: number; tokens?: { prompt_tokens: number; completion_tokens: number } };
        const tokens = d.tokens ? ` · ${d.tokens.prompt_tokens + d.tokens.completion_tokens} tokens` : '';
        return `${d.assembled_content.slice(0, 400)}\n\n${d.chunks_count} chunks, ${formatTime(d.duration_ms)}${tokens}`;
      }
      case 'error': {
        const d = event.data as { message: string };
        return d.message;
      }
      default:
        return JSON.stringify(event.data).slice(0, 200);
    }
  };

  if (loading) return <div style={{ color: 'var(--text-dim)', padding: 80, textAlign: 'center' }}>Loading...</div>;

  const metaEvent = events.find((e) => e.type === 'meta');
  const metaData = metaEvent?.data as Record<string, unknown> | undefined;
  const sessionModel = (metaData?.model as string) ?? extractModelFromRequests(events);
  const sessionMode = (metaData?.mode as string) ?? 'capture';
  const parentSession = metaData?.parent_session_id as string | undefined;

  return (
    <div>
      <div className="timeline-header">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
          <button className="btn" onClick={onBack}>Back</button>
          <h2 className="section-title">{sessionId}</h2>
          <span className="section-count">{events.length} events</span>
        </div>
      </div>

      <div className="timeline-info">
        <div className="timeline-info-item">
          <label>Model</label>
          <span style={{ color: 'var(--accent)' }}>{sessionModel || 'unknown'}</span>
        </div>
        <div className="timeline-info-item">
          <label>Mode</label>
          <span>{sessionMode}</span>
        </div>
        {parentSession && (
          <div className="timeline-info-item">
            <label>Branched from</label>
            <span>{parentSession}</span>
          </div>
        )}
      </div>

      <div className="timeline">
        {collapseStreamChunks(events).map((event) => (
          <div key={event.seq} className={`timeline-event type-${event.type}`}>
            <div className="event-header">
              <span className="event-type">
                {String(event.seq).padStart(2, '0')} {event.type}
              </span>
              <span className="event-time">+{formatTime(event.t)}</span>
            </div>
            <div className="event-content">
              {getEventSummary(event)}
            </div>
            {(event.type === 'response' || event.type === 'stream_end') && (
              <button
                className="branch-btn btn btn-small btn-primary"
                onClick={() => setBranchAt(event.seq)}
              >
                Branch here
              </button>
            )}
          </div>
        ))}
      </div>

      {branchAt !== null && (
        <BranchModal
          sessionId={sessionId}
          branchAt={branchAt}
          models={models}
          onSubmit={handleBranch}
          onClose={() => setBranchAt(null)}
        />
      )}
    </div>
  );
}

function extractModelFromRequests(events: ReplayEvent[]): string {
  for (const e of events) {
    if (e.type === 'request') {
      const body = e.data.body as Record<string, unknown> | undefined;
      if (body && typeof body.model === 'string') return body.model;
    }
  }
  return '';
}

function collapseStreamChunks(events: ReplayEvent[]): ReplayEvent[] {
  const result: ReplayEvent[] = [];
  let chunkCount = 0;

  for (const event of events) {
    if (event.type === 'stream_chunk') {
      chunkCount++;
      continue;
    }
    if (event.type === 'stream_end' && chunkCount > 0) {
      result.push(event);
      chunkCount = 0;
      continue;
    }
    if (chunkCount > 0) {
      chunkCount = 0;
    }
    result.push(event);
  }
  return result;
}
