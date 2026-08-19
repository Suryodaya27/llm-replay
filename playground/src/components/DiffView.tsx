import { useEffect, useState } from 'react';
import { fetchDiff, judgeCompare, type DiffResult, type JudgeResult } from '../api';

interface Props {
  session1: string;
  session2: string;
  onBack: () => void;
}

export default function DiffView({ session1, session2, onBack }: Props) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [judgment, setJudgment] = useState<JudgeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [judging, setJudging] = useState(false);
  const [judgeElapsed, setJudgeElapsed] = useState(0);

  useEffect(() => {
    loadDiff();
  }, [session1, session2]);

  const loadDiff = async () => {
    setLoading(true);
    const data = await fetchDiff(session1, session2);
    setDiff(data);
    setLoading(false);
  };

  const runJudge = async () => {
    setJudging(true);
    setJudgeElapsed(0);
    const timer = setInterval(() => setJudgeElapsed((e) => e + 1), 1000);
    try {
      const result = await judgeCompare(session1, session2);
      setJudgment(result);
    } catch (e) {
      console.error('Judge failed:', e);
    } finally {
      setJudging(false);
      clearInterval(timer);
    }
  };

  if (loading) return <div style={{ color: 'var(--text-dim)' }}>Computing diff...</div>;
  if (!diff) return <div>No diff data.</div>;

  const differsCount = diff.comparisons.filter((c) => c.differs).length;

  return (
    <div>
      <div className="timeline-header">
        <div>
          <button className="btn" onClick={onBack}>← Back</button>
          <span style={{ marginLeft: 16, fontSize: 16, fontWeight: 600 }}>
            Comparing Sessions
          </span>
        </div>
        <button
          className="btn btn-primary"
          onClick={runJudge}
          disabled={judging}
        >
          {judging ? `Judging... (${judgeElapsed}s)` : judgment ? 'Re-judge' : 'Judge with AI'}
        </button>
      </div>

      <div className="diff-stats">
        <span>{diff.totalTurns} turns total</span>
        <span className="differs-count">{differsCount} turns differ</span>
      </div>

      {/* Judge Results Banner */}
      {judgment && (
        <div style={{ marginBottom: 24, padding: '16px 20px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>AI Judge Verdict</span>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>judged by {judgment.judgeModel}</span>
          </div>

          <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
            <ScoreBlock
              label={judgment.sessionA}
              score={judgment.overall.scoreA}
              isWinner={judgment.overall.winner === 'a'}
            />
            <span style={{ fontSize: 20, color: 'var(--text-dim)' }}>vs</span>
            <ScoreBlock
              label={judgment.sessionB}
              score={judgment.overall.scoreB}
              isWinner={judgment.overall.winner === 'b'}
            />
          </div>

          <p style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {judgment.overall.summary}
          </p>
        </div>
      )}

      {/* Diff Grid */}
      <div className="diff-container">
        <div className="diff-column-header">{session1}</div>
        <div className="diff-column-header">{session2}</div>

        {diff.comparisons.map((comp) => {
          const tj = judgment?.turns.find(t => t.turnIndex === comp.turnIndex);
          return (
            <div key={comp.turnIndex} className="diff-turn">
              <div className="diff-turn-label">
                Turn {comp.turnIndex + 1}
                {comp.session1?.request.content && (
                  <span style={{ fontWeight: 400, textTransform: 'none', marginLeft: 8 }}>
                    "{comp.session1.request.content.slice(0, 60)}..."
                  </span>
                )}
                {comp.differs && <span style={{ color: 'var(--purple)', marginLeft: 8 }}>● differs</span>}
                {tj && (
                  <span style={{ marginLeft: 12, fontSize: 11, color: tj.scoreA.total > tj.scoreB.total ? 'var(--green)' : tj.scoreB.total > tj.scoreA.total ? 'var(--accent)' : 'var(--text-dim)' }}>
                    {tj.scoreA.total > tj.scoreB.total ? `← wins (${tj.scoreA.total} vs ${tj.scoreB.total})` :
                      tj.scoreB.total > tj.scoreA.total ? `wins → (${tj.scoreA.total} vs ${tj.scoreB.total})` :
                        `tie (${tj.scoreA.total})`}
                  </span>
                )}
              </div>
              <div className={`diff-cell ${comp.differs ? 'differs' : 'same'}`}>
                {comp.session1 ? (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
                      {comp.session1.request.model ?? ''} • {(comp.session1.response.duration_ms / 1000).toFixed(1)}s
                      {tj && <span style={{ marginLeft: 8, color: tj.winner === 'a' ? 'var(--green)' : 'var(--text-dim)' }}>
                        {tj.scoreA.total}/10
                      </span>}
                    </div>
                    {comp.session1.response.content}
                  </>
                ) : (
                  <span style={{ color: 'var(--text-dim)' }}>— no data —</span>
                )}
              </div>
              <div className={`diff-cell ${comp.differs ? 'differs' : 'same'}`}>
                {comp.session2 ? (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
                      {comp.session2.request.model ?? ''} • {(comp.session2.response.duration_ms / 1000).toFixed(1)}s
                      {tj && <span style={{ marginLeft: 8, color: tj.winner === 'b' ? 'var(--green)' : 'var(--text-dim)' }}>
                        {tj.scoreB.total}/10
                      </span>}
                    </div>
                    {comp.session2.response.content}
                  </>
                ) : (
                  <span style={{ color: 'var(--text-dim)' }}>— no data —</span>
                )}
              </div>

              {/* Per-turn judge reason */}
              {tj && tj.reason && (
                <>
                  <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--text-muted)', padding: '6px 0', fontStyle: 'italic' }}>
                    Judge: {tj.reason}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScoreBlock({ label, score, isWinner }: { label: string; score: number; isWinner: boolean }) {
  return (
    <div style={{
      padding: '12px 20px',
      background: isWinner ? 'var(--green-subtle)' : 'var(--surface-2)',
      border: `1px solid ${isWinner ? 'rgba(34,197,94,0.3)' : 'var(--border)'}`,
      borderRadius: 'var(--radius-xs)',
      textAlign: 'center',
      flex: 1,
    }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4, fontFamily: "'JetBrains Mono', monospace" }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: isWinner ? 'var(--green)' : 'var(--text-muted)' }}>
        {score.toFixed(1)}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>/10 avg</div>
      {isWinner && <div style={{ fontSize: 10, color: 'var(--green)', marginTop: 4, fontWeight: 600 }}>WINNER</div>}
    </div>
  );
}
