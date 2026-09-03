import { useEffect, useState } from 'react';
import { createBranch, type BranchResult } from '../api';

const BASE = '';

interface ConversationStep {
  type: 'user' | 'thinking' | 'tool_call' | 'tool_result' | 'answer' | 'error';
  index: number;
  seq: number;
  time_ms: number;
  content: string;
  meta?: {
    tool_name?: string;
    tool_args?: Record<string, unknown>;
    model?: string;
    tokens?: { prompt: number; completion: number };
    latency_ms?: number;
    images?: string[];
  };
}

interface Issue {
  severity: 'critical' | 'warning' | 'info';
  type: string;
  message: string;
  steps: number[];
}

interface ParsedSession {
  session_id: string;
  model: string;
  steps: ConversationStep[];
  summary: {
    total_steps: number;
    tool_calls: number;
    tools_used: string[];
    total_tokens: number;
    total_latency_ms: number;
    outcome: string;
    one_liner: string;
  };
  issues?: Issue[];
  healthScore?: number;
}

interface Props {
  sessionId: string;
  onBack: () => void;
  onOpenSession?: (id: string) => void;
}

export default function ConversationView({ sessionId, onBack, onOpenSession }: Props) {
  const [data, setData] = useState<ParsedSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingStep, setEditingStep] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [branching, setBranching] = useState(false);
  const [branchResult, setBranchResult] = useState<BranchResult | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`${BASE}/api/sessions/${encodeURIComponent(sessionId)}/conversation`)
      .then(res => res.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, [sessionId]);

  const startEdit = (step: ConversationStep) => {
    setEditingStep(step.index);
    setEditText(step.content);
    setBranchResult(null);
    setBranchError(null);
  };

  const cancelEdit = () => {
    setEditingStep(null);
    setEditText('');
  };

  const submitBranch = async () => {
    if (editingStep === null) return;
    setBranching(true);
    setBranchError(null);
    try {
      const result = await createBranch(sessionId, editingStep, editText);
      setBranchResult(result);
      setEditingStep(null);
    } catch (err) {
      setBranchError(err instanceof Error ? err.message : 'Branch failed');
    }
    setBranching(false);
  };

  if (loading) return <div className="loading">Loading session...</div>;
  if (!data) return <div>Failed to load session.</div>;

  const formatTime = (ms: number) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

  return (
    <div className="conversation">
      {/* Header */}
      <div className="conv-header">
        <button className="btn" onClick={onBack}>← Back</button>
        <div className="conv-title">{sessionId}</div>
      </div>

      {/* Summary bar */}
      <div className="conv-summary">
        <div className="conv-summary-item">
          <span className="conv-label">Model</span>
          <span className="conv-value">{data.model || 'unknown'}</span>
        </div>
        <div className="conv-summary-item">
          <span className="conv-label">Steps</span>
          <span className="conv-value">{data.summary.total_steps}</span>
        </div>
        {data.summary.tool_calls > 0 && (
          <div className="conv-summary-item">
            <span className="conv-label">Tools</span>
            <span className="conv-value">{data.summary.tools_used.join(', ')}</span>
          </div>
        )}
        <div className="conv-summary-item">
          <span className="conv-label">Tokens</span>
          <span className="conv-value">{data.summary.total_tokens.toLocaleString()}</span>
        </div>
        <div className="conv-summary-item">
          <span className="conv-label">Duration</span>
          <span className="conv-value">{formatTime(data.summary.total_latency_ms)}</span>
        </div>
        <div className="conv-summary-item">
          <span className="conv-label">Outcome</span>
          <span className={`conv-value conv-outcome-${data.summary.outcome}`}>
            {data.summary.outcome === 'success' ? '✓ completed' : data.summary.outcome === 'error' ? '✗ failed' : '? incomplete'}
          </span>
        </div>
      </div>

      {/* Issues */}
      {data.issues && data.issues.length > 0 && (
        <div className="conv-issues">
          <div className="conv-issues-header">
            <span className="conv-issues-title">
              {data.issues.length} {data.issues.length === 1 ? 'issue' : 'issues'} detected
            </span>
            {data.healthScore !== undefined && (
              <span className={`conv-health-score ${data.healthScore >= 80 ? 'good' : data.healthScore >= 50 ? 'ok' : 'bad'}`}>
                Health: {data.healthScore}/100
              </span>
            )}
          </div>
          {data.issues.map((issue, i) => (
            <div key={i} className={`conv-issue conv-issue-${issue.severity}`}>
              <span className="conv-issue-icon">
                {issue.severity === 'critical' ? '●' : issue.severity === 'warning' ? '▲' : 'ℹ'}
              </span>
              <span className="conv-issue-message">{issue.message}</span>
            </div>
          ))}
        </div>
      )}

      {branchError && (
        <div className="conv-branch-error">
          Branch failed: {branchError}
        </div>
      )}

      {/* Steps */}
      <div className="conv-steps">
        {data.steps.map((step) => {
          const isBranchedStep = branchResult && step.index === branchResult.branchAtStep;
          const isAfterBranch = branchResult && step.index > branchResult.branchAtStep;

          return (
            <div key={step.index}>
              <div className={`conv-step conv-step-${step.type} ${isAfterBranch ? 'conv-step-faded' : ''}`}>
                <div className="conv-step-header">
                  <span className="conv-step-icon">{stepIcon(step.type)}</span>
                  <span className="conv-step-type">{stepLabel(step.type)}</span>
                  {isBranchedStep && <span className="conv-branch-badge">branched here</span>}
                  {step.meta?.tool_name && (
                    <span className="conv-step-tool">{step.meta.tool_name}</span>
                  )}
                  <span className="conv-step-time">
                    {step.meta?.latency_ms ? formatTime(step.meta.latency_ms) : ''}
                  </span>
                  {editingStep !== step.index && !isAfterBranch && (
                    <button
                      className="btn btn-edit"
                      onClick={(e) => { e.stopPropagation(); startEdit(step); }}
                      title="Edit this step and re-run from here"
                      style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px' }}
                    >
                      What if?
                    </button>
                  )}
                </div>

                {editingStep === step.index ? (
                  <div className="conv-step-edit">
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={Math.min(10, editText.split('\n').length + 2)}
                      style={{ width: '100%', fontFamily: 'inherit', fontSize: 13, padding: 8, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                    />
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button className="btn btn-primary" onClick={submitBranch} disabled={branching}>
                        {branching ? 'Re-running...' : 'Re-run from here'}
                      </button>
                      <button className="btn" onClick={cancelEdit} disabled={branching}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="conv-step-content">
                    {isBranchedStep && (
                      <div className="conv-step-original">
                        <span className="conv-step-original-label">original</span>
                      </div>
                    )}
                    {step.type === 'tool_call' ? (
                      <ToolCallContent step={step} />
                    ) : step.type === 'tool_result' ? (
                      <ExpandableContent text={step.content} label="output" preformatted />
                    ) : (step.type === 'thinking' || step.type === 'answer' || step.type === 'user') && step.content.length > 200 ? (
                      <ExpandableContent text={step.content} label={step.type === 'user' ? 'prompt' : 'response'} />
                    ) : (
                      <TextContent text={step.content} />
                    )}
                    {step.meta?.images && step.meta.images.length > 0 && (
                      <div className="conv-step-images">
                        {step.meta.images.map((src, i) => (
                          <img key={i} src={src} alt={`Attached image ${i + 1}`} className="conv-step-image" />
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {step.meta?.tokens && editingStep !== step.index && (
                  <div className="conv-step-tokens">
                    {step.meta.tokens.prompt + step.meta.tokens.completion} tokens
                  </div>
                )}
              </div>

              {/* Show edited content + branch result inline right after the branched step */}
              {isBranchedStep && branchResult && (
                <>
                  <div className="conv-step conv-step-branch-edit">
                    <div className="conv-step-header">
                      <span className="conv-step-icon">✎</span>
                      <span className="conv-step-type">Edited {stepLabel(step.type)}</span>
                      <span className="conv-branch-badge">what-if</span>
                    </div>
                    <div className="conv-step-content">
                      <TextContent text={branchResult.editedContent} />
                    </div>
                  </div>

                  <div className="conv-branch-result">
                    <div className="conv-branch-header">
                      <span>{branchResult.turns} {branchResult.turns === 1 ? 'turn' : 'turns'} re-run</span>
                      <span>{branchResult.totalTokens} tokens, {(branchResult.durationMs / 1000).toFixed(1)}s</span>
                    </div>
                    {branchResult.newSteps.map((s, i) => (
                      <div key={i} className={`conv-step conv-step-${s.role === 'assistant' ? 'answer' : 'tool_result'}`} style={{ marginBottom: 8 }}>
                        <div className="conv-step-header">
                          <span className="conv-step-icon">{s.role === 'assistant' ? '✓' : '←'}</span>
                          <span className="conv-step-type">{s.role === 'assistant' ? 'New LLM Response' : 'Tool Result'}</span>
                        </div>
                        <div className="conv-step-content">
                          <TextContent text={s.content} />
                        </div>
                      </div>
                    ))}
                    {onOpenSession && (
                      <button className="btn" onClick={() => onOpenSession(branchResult.sessionId)} style={{ marginTop: 8 }}>
                        Open full branch session
                      </button>
                    )}
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

function ToolCallContent({ step }: { step: ConversationStep }) {
  const [expanded, setExpanded] = useState(false);
  const name = step.meta?.tool_name ?? 'unknown';
  const args = step.meta?.tool_args ?? {};
  const hasArgs = Object.keys(args).length > 0;

  const preview = hasArgs
    ? Object.entries(args).map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}=${val.length > 60 ? val.slice(0, 57) + '...' : val}`;
    }).join(', ')
    : '';

  return (
    <div className="tool-call-block">
      <div className="tool-call-name">
        <strong>{name}</strong>
        <span className="tool-call-preview">({preview})</span>
      </div>
      {hasArgs && (
        <button className="expand-pill" onClick={() => setExpanded(!expanded)}>
          <span className="expand-pill-icon">{expanded ? '▾' : '▸'}</span>
          {expanded ? 'Hide args' : 'Show args'}
        </button>
      )}
      {expanded && (
        <div className="tool-call-args">
          {Object.entries(args).map(([key, value]) => (
            <div key={key} className="tool-call-arg">
              <span className="tool-arg-key">{key}:</span>
              <span className="tool-arg-value">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TextContent({ text }: { text: string }) {
  // Simple markdown-ish rendering: detect code blocks
  const parts = text.split(/(```[\s\S]*?```)/g);
  return (
    <div>
      {parts.map((part, i) => {
        if (part.startsWith('```')) {
          const code = part.replace(/^```\w*\n?/, '').replace(/```$/, '');
          return <pre key={i} className="conv-code-block">{code}</pre>;
        }
        return <span key={i}>{part}</span>;
      })}
    </div>
  );
}

function ExpandableContent({ text, label, preformatted }: { text: string; label: string; preformatted?: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <button className={`expand-pill ${expanded ? 'expand-pill-active' : ''}`} onClick={() => setExpanded(!expanded)}>
        <span className="expand-pill-icon">{expanded ? '▾' : '▸'}</span>
        {expanded ? `Hide ${label}` : `Show ${label}`}
      </button>
      {expanded && (
        preformatted ? (
          <pre className="conv-code-block" style={{ marginTop: 8 }}>{text}</pre>
        ) : (
          <div style={{ marginTop: 8 }}><TextContent text={text} /></div>
        )
      )}
    </div>
  );
}

function stepIcon(type: string): string {
  switch (type) {
    case 'user': return '→';
    case 'thinking': return '·';
    case 'tool_call': return '⚡';
    case 'tool_result': return '←';
    case 'answer': return '✓';
    case 'error': return '✗';
    default: return '·';
  }
}

function stepLabel(type: string): string {
  switch (type) {
    case 'user': return 'User';
    case 'thinking': return 'LLM Response';
    case 'tool_call': return 'Tool Call';
    case 'tool_result': return 'Tool Result';
    case 'answer': return 'Final Answer';
    case 'error': return 'Error';
    default: return type;
  }
}
