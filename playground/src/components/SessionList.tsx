import { useEffect, useState } from 'react';
import { fetchSessions, fetchProviders, deleteSession, type SessionSummary, type ProviderInfo } from '../api';

interface Props {
  onSelect: (id: string) => void;
  onDiff: (id1: string, id2: string) => void;
}

export default function SessionList({ onSelect, onDiff }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [compareMode, setCompareMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    loadSessions();
    fetchProviders().then(setProviders).catch(() => { });
  }, []);

  const loadSessions = async () => {
    setLoading(true);
    try {
      const data = await fetchSessions();
      setSessions(data);
    } catch {
      setSessions([]);
    }
    setLoading(false);
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm(`Delete session "${id}"?`)) return;
    await deleteSession(id);
    loadSessions();
  };

  const handleCompareSelect = (id: string) => {
    if (selected.includes(id)) {
      setSelected(selected.filter((s) => s !== id));
    } else if (selected.length < 2) {
      const newSelected = [...selected, id];
      setSelected(newSelected);
      if (newSelected.length === 2) {
        onDiff(newSelected[0], newSelected[1]);
        setSelected([]);
        setCompareMode(false);
      }
    }
  };

  if (loading) return <div style={{ color: 'var(--text-dim)', padding: 80, textAlign: 'center' }}>Loading...</div>;

  if (sessions.length === 0) {
    return (
      <div className="landing">
        <h2>Replay Engine</h2>
        <p>Capture, replay, compare, and judge your AI agent sessions. Point your agent at the proxy and start recording.</p>
        <div className="landing-steps">
          <div className="landing-step">
            <div className="landing-step-num">01</div>
            <div className="landing-step-title">Capture</div>
            <div className="landing-step-desc">Record all LLM traffic through the proxy</div>
          </div>
          <div className="landing-step">
            <div className="landing-step-num">02</div>
            <div className="landing-step-title">Compare</div>
            <div className="landing-step-desc">Re-execute with a different model and diff the outputs</div>
          </div>
          <div className="landing-step">
            <div className="landing-step-num">03</div>
            <div className="landing-step-title">Judge</div>
            <div className="landing-step-desc">AI evaluates which model performed better</div>
          </div>
        </div>
        <p style={{ marginTop: 48, fontSize: 13, color: 'var(--text-dim)' }}>
          Run <code style={{ fontFamily: "'JetBrains Mono', monospace" }}>llm-replay capture --session my-run</code> to start
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Providers */}
      {providers.length > 0 && (
        <div className="provider-bar">
          <span className="provider-bar-label">Providers</span>
          {providers.map((p) => (
            <div key={p.name} className="provider-item">
              <span className="provider-dot" style={{ background: p.hasApiKey || p.type === 'ollama' ? 'var(--green)' : 'var(--text-dim)' }} />
              <span>{p.name}</span>
              {p.routes.length > 0 && <span className="provider-routes">{p.routes.join(', ')}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Header */}
      <div className="section-header">
        <div>
          <h2 className="section-title">Sessions</h2>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className={`btn ${compareMode ? 'btn-primary' : ''}`}
            onClick={() => { setCompareMode(!compareMode); setSelected([]); }}
          >
            {compareMode ? `Select 2 (${selected.length}/2)` : 'Compare'}
          </button>
          <button className="btn" onClick={loadSessions}>Refresh</button>
        </div>
      </div>

      {/* List */}
      <div className="session-list">
        {sessions.map((s) => (
          <div
            key={s.id}
            className="session-card"
            onClick={() => compareMode ? handleCompareSelect(s.id) : onSelect(s.id)}
            style={selected.includes(s.id) ? { borderColor: 'var(--accent)' } : undefined}
          >
            <div className="session-card-header">
              <span className="session-id">{s.id}</span>
              <span className={`session-badge badge-${s.meta?.mode ?? 'capture'}`}>
                {s.meta?.mode ?? 'capture'}
              </span>
            </div>
            <div className="session-meta">
              <span>{s.eventCount} events</span>
              {s.meta?.model && <span>{s.meta.model}</span>}
              {s.meta?.started_at && <span>{new Date(s.meta.started_at).toLocaleDateString()}</span>}
              {s.meta?.parent_session_id && <span>from {s.meta.parent_session_id}</span>}
            </div>
            {!compareMode && (
              <div className="session-actions">
                <button className="btn btn-danger" onClick={(e) => handleDelete(e, s.id)}>Delete</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
