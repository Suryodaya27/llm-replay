import { useState, useEffect, useRef } from 'react';
import type { OllamaModel } from '../api';

type Mode = 'reexec' | 'branch';

interface Props {
  sessionId: string;
  branchAt: number;
  models: OllamaModel[];
  onSubmit: (mode: Mode, model: string, prompt: string) => void;
  onClose: () => void;
}

export default function BranchModal({ sessionId, branchAt, models, onSubmit, onClose }: Props) {
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<Mode>('reexec');
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  const handleSubmit = async () => {
    setLoading(true);
    setElapsed(0);
    setError(null);
    timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);

    try {
      await onSubmit(mode, model, prompt);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    }
  };

  return (
    <div className="modal-overlay" onClick={loading ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Compare with Different Model</h2>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>
          Session: <strong>{sessionId}</strong> (from event #{branchAt})
        </p>

        <div className="form-group">
          <label>Mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} disabled={loading}>
            <option value="reexec">Re-execute (calls Ollama with new model — real comparison)</option>
            <option value="branch">Branch only (patches history, no new LLM calls)</option>
          </select>
        </div>

        <div className="form-group">
          <label>Model</label>
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={loading}>
            <option value="">— keep original —</option>
            {models.map((m) => (
              <option key={m.name} value={m.name}>{m.name}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>Override System Prompt (optional)</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Leave empty to keep original prompt"
            disabled={loading}
          />
        </div>

        {mode === 'reexec' && !loading && (
          <p style={{ fontSize: 12, color: 'var(--orange)', marginTop: 8 }}>
            This will call the LLM and may take a few minutes for large models.
          </p>
        )}

        {loading && (
          <div style={{ marginTop: 12, padding: '12px 16px', background: 'var(--surface-2)', borderRadius: 'var(--radius-xs)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                {mode === 'reexec' ? 'Calling LLM for all turns...' : 'Creating branch...'}
              </span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: 'var(--accent-hover)' }}>
                {elapsed}s
              </span>
            </div>
            <div style={{ marginTop: 8, height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ height: '100%', background: 'var(--accent)', borderRadius: 2, animation: 'pulse 1.5s infinite', width: '60%' }} />
            </div>
          </div>
        )}

        {error && (
          <div style={{ marginTop: 12, padding: '10px 14px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 'var(--radius-xs)', fontSize: 13, color: 'var(--red)' }}>
            {error}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={loading}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={loading || (!model && !prompt)}
          >
            {loading
              ? `Re-executing... (${elapsed}s)`
              : (mode === 'reexec' ? 'Re-execute & Compare' : 'Create Branch')
            }
          </button>
        </div>
      </div>
    </div>
  );
}
