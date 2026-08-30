import { useEffect, useState } from 'react';
import { fetchCompare, type CompareResult } from '../api';

interface Props {
  session1: string;
  session2: string;
  onBack: () => void;
}

export default function DiffView({ session1, session2, onBack }: Props) {
  const [data, setData] = useState<CompareResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchCompare(session1, session2)
      .then(setData)
      .finally(() => setLoading(false));
  }, [session1, session2]);

  if (loading) return <div style={{ color: 'var(--text-dim)', padding: 80, textAlign: 'center' }}>Comparing sessions...</div>;
  if (!data) return <div>Failed to load comparison.</div>;

  const s1 = data.session1;
  const s2 = data.session2;

  return (
    <div>
      <div className="conv-header">
        <button className="btn" onClick={onBack}>← Back</button>
        <div className="conv-title">Compare Sessions</div>
      </div>

      <div className="compare-grid">
        <div className="compare-header" />
        <div className="compare-header compare-session-label">{s1.sessionId}</div>
        <div className="compare-header compare-session-label">{s2.sessionId}</div>

        <CompareRow label="Model" v1={s1.model} v2={s2.model} />
        <CompareRow label="Outcome" v1={outcomeLabel(s1.outcome)} v2={outcomeLabel(s2.outcome)} highlight={(a, b) => a === 'completed' && b !== 'completed' ? 'left' : b === 'completed' && a !== 'completed' ? 'right' : null} />
        <CompareRow label="Final Answer" v1={s1.finalAnswer ?? '—'} v2={s2.finalAnswer ?? '—'} long />
        <CompareRow label="Total Tokens" v1={String(s1.totalTokens)} v2={String(s2.totalTokens)} highlight={lower} />
        <CompareRow label="Prompt Tokens" v1={String(s1.promptTokens)} v2={String(s2.promptTokens)} highlight={lower} />
        <CompareRow label="Completion Tokens" v1={String(s1.completionTokens)} v2={String(s2.completionTokens)} highlight={lower} />
        <CompareRow label="Turns" v1={String(s1.totalTurns)} v2={String(s2.totalTurns)} highlight={lower} />
        <CompareRow label="Total Steps" v1={String(s1.totalSteps)} v2={String(s2.totalSteps)} />
        <CompareRow label="Avg Latency" v1={`${s1.avgLatencyMs}ms`} v2={`${s2.avgLatencyMs}ms`} highlight={lower} />
        <CompareRow label="Total Duration" v1={formatMs(s1.totalDurationMs)} v2={formatMs(s2.totalDurationMs)} highlight={lower} />
        <CompareRow label="Tool Calls" v1={String(s1.toolCalls)} v2={String(s2.toolCalls)} />
        <CompareRow label="Tools Used" v1={s1.toolsUsed.join(', ') || '—'} v2={s2.toolsUsed.join(', ') || '—'} />
        <CompareRow label="Health Score" v1={`${s1.healthScore}/100`} v2={`${s2.healthScore}/100`} highlight={higher} />
        <CompareRow label="Issues" v1={String(s1.issueCount)} v2={String(s2.issueCount)} highlight={lower} />
      </div>

      {/* Issues detail */}
      {(s1.issues.length > 0 || s2.issues.length > 0) && (
        <div className="compare-issues">
          <div className="compare-issues-col">
            {s1.issues.map((issue, i) => (
              <div key={i} className={`conv-issue conv-issue-${issue.severity}`}>
                <span className="conv-issue-icon">{issue.severity === 'critical' ? '●' : issue.severity === 'warning' ? '▲' : 'ℹ'}</span>
                <span className="conv-issue-message">{issue.message}</span>
              </div>
            ))}
          </div>
          <div className="compare-issues-col">
            {s2.issues.map((issue, i) => (
              <div key={i} className={`conv-issue conv-issue-${issue.severity}`}>
                <span className="conv-issue-icon">{issue.severity === 'critical' ? '●' : issue.severity === 'warning' ? '▲' : 'ℹ'}</span>
                <span className="conv-issue-message">{issue.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CompareRow({ label, v1, v2, highlight, long }: {
  label: string;
  v1: string;
  v2: string;
  highlight?: (a: string, b: string) => 'left' | 'right' | null;
  long?: boolean;
}) {
  const winner = highlight ? highlight(v1, v2) : null;

  return (
    <>
      <div className="compare-label">{label}</div>
      <div className={`compare-value ${winner === 'left' ? 'compare-winner' : ''} ${long ? 'compare-long' : ''}`}>{v1}</div>
      <div className={`compare-value ${winner === 'right' ? 'compare-winner' : ''} ${long ? 'compare-long' : ''}`}>{v2}</div>
    </>
  );
}

function lower(a: string, b: string): 'left' | 'right' | null {
  const na = parseFloat(a);
  const nb = parseFloat(b);
  if (isNaN(na) || isNaN(nb) || na === nb) return null;
  return na < nb ? 'left' : 'right';
}

function higher(a: string, b: string): 'left' | 'right' | null {
  const na = parseFloat(a);
  const nb = parseFloat(b);
  if (isNaN(na) || isNaN(nb) || na === nb) return null;
  return na > nb ? 'left' : 'right';
}

function outcomeLabel(outcome: string): string {
  if (outcome === 'success') return 'completed';
  if (outcome === 'error') return 'failed';
  return 'incomplete';
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
