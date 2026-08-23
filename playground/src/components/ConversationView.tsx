import { useEffect, useState } from 'react';

const BASE = 'http://localhost:3001';

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
  };
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
}

interface Props {
  sessionId: string;
  onBack: () => void;
}

export default function ConversationView({ sessionId, onBack }: Props) {
  const [data, setData] = useState<ParsedSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`${BASE}/api/sessions/${encodeURIComponent(sessionId)}/conversation`)
      .then(res => res.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, [sessionId]);

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

      {/* Steps */}
      <div className="conv-steps">
        {data.steps.map((step) => (
          <div key={step.index} className={`conv-step conv-step-${step.type}`}>
            <div className="conv-step-header">
              <span className="conv-step-icon">{stepIcon(step.type)}</span>
              <span className="conv-step-type">{stepLabel(step.type)}</span>
              {step.meta?.tool_name && (
                <span className="conv-step-tool">{step.meta.tool_name}</span>
              )}
              <span className="conv-step-time">
                {step.meta?.latency_ms ? formatTime(step.meta.latency_ms) : ''}
              </span>
            </div>
            <div className="conv-step-content">
              {step.type === 'tool_call' ? (
                <ToolCallContent step={step} />
              ) : step.type === 'tool_result' ? (
                <ExpandableContent text={step.content} label="output" preformatted />
              ) : step.type === 'thinking' && step.content.length > 200 ? (
                <ExpandableContent text={step.content} label="reasoning" />
              ) : (
                <TextContent text={step.content} />
              )}
            </div>
            {step.meta?.tokens && (
              <div className="conv-step-tokens">
                {step.meta.tokens.prompt + step.meta.tokens.completion} tokens
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolCallContent({ step }: { step: ConversationStep }) {
  const [expanded, setExpanded] = useState(false);
  const name = step.meta?.tool_name ?? 'unknown';
  const args = step.meta?.tool_args ?? {};
  const hasArgs = Object.keys(args).length > 0;

  return (
    <div className="tool-call-block">
      <div className="tool-call-name" onClick={() => setExpanded(!expanded)} style={{ cursor: 'pointer' }}>
        {name}
        <span className="tool-expand-hint">{expanded ? '▼' : '▶'} {hasArgs ? 'inputs' : 'no inputs'}</span>
      </div>
      {expanded && (
        <div className="tool-call-args">
          {hasArgs ? (
            Object.entries(args).map(([key, value]) => (
              <div key={key} className="tool-call-arg">
                <span className="tool-arg-key">{key}:</span>
                <span className="tool-arg-value">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</span>
              </div>
            ))
          ) : (
            <div className="tool-call-arg">
              <span className="tool-arg-value" style={{ fontStyle: 'italic' }}>No arguments passed (model sent empty object)</span>
            </div>
          )}
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
  const preview = text.slice(0, 120);
  const isLong = text.length > 120;

  return (
    <div>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: 8 }}
      >
        <span className="tool-expand-hint">{expanded ? '▼' : '▶'} {label}</span>
        {!expanded && isLong && (
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{preview}...</span>
        )}
      </div>
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
    case 'thinking': return 'Agent';
    case 'tool_call': return 'Tool Call';
    case 'tool_result': return 'Tool Result';
    case 'answer': return 'Final Answer';
    case 'error': return 'Error';
    default: return type;
  }
}
