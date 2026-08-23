import { useEffect, useState, useRef } from 'react';

const WS_URL = 'ws://localhost:3001/ws';

interface LiveStep {
  id: string;
  session_id: string;
  type: string;
  content: string;
  time: number;
  meta?: Record<string, unknown>;
}

export default function LiveView() {
  const [connected, setConnected] = useState(false);
  const [steps, setSteps] = useState<LiveStep[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === 'session_start') {
        setActiveSession(msg.session_id);
        setSteps([]);
      }

      if (msg.type === 'session_end') {
        setActiveSession(null);
      }

      if (msg.type === 'event') {
        const event = msg.event;
        const step = eventToStep(msg.session_id, event);
        if (step) {
          setSteps((prev) => {
            const updated = [...prev, step];
            // Normalize times: subtract first event's time so it starts at 0
            if (updated.length > 0) {
              const firstTime = updated[0].time;
              return updated.map(s => ({ ...s, time: s.time - firstTime }));
            }
            return updated;
          });
        }
      }
    };

    return () => { ws.close(); };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [steps]);

  return (
    <div className="live-view">
      <div className="live-header">
        <div className="live-indicator">
          <span className={`live-dot ${connected ? 'live-dot-on' : ''}`} />
          <span>{connected ? 'Live' : 'Disconnected'}</span>
        </div>
        {activeSession && (
          <span className="live-session-name">Recording: {activeSession}</span>
        )}
        {steps.length > 0 && (
          <button className="btn btn-small" onClick={() => setSteps([])}>Clear</button>
        )}
      </div>

      {steps.length === 0 && !activeSession && (
        <div className="live-empty">
          <p>Waiting for agent activity...</p>
          <p className="live-empty-hint">Start a capture proxy and run your agent to see events here in real-time.</p>
        </div>
      )}

      <div className="live-steps">
        {steps.map((step) => (
          <div key={step.id} className={`live-step live-step-${step.type}`}>
            <span className="live-step-icon">{stepIcon(step.type)}</span>
            <div className="live-step-body">
              <div className="live-step-type">{step.type}</div>
              <div className="live-step-content">{step.content}</div>
            </div>
            <span className="live-step-time">{formatMs(step.time)}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function eventToStep(sessionId: string, event: { seq: number; t: number; type: string; data: unknown }): LiveStep | null {
  const data = event.data as Record<string, unknown>;

  switch (event.type) {
    case 'meta':
      return { id: `${sessionId}-${event.seq}`, session_id: sessionId, type: 'session', content: `Session started · ${(data.model as string) ?? 'unknown model'}`, time: event.t };

    case 'request': {
      const body = data.body as Record<string, unknown> | undefined;
      const messages = body?.messages as Array<Record<string, unknown>> | undefined;
      const last = messages?.[messages.length - 1];
      if (!last) return null;

      if (last.role === 'tool') {
        const content = (last.content as string) ?? '';
        return { id: `${sessionId}-${event.seq}`, session_id: sessionId, type: 'tool_result', content: content.slice(0, 200), time: event.t };
      }
      if (last.role === 'user' && messages!.length <= 2) {
        return { id: `${sessionId}-${event.seq}`, session_id: sessionId, type: 'user', content: (last.content as string) ?? '', time: event.t };
      }
      return null;
    }

    case 'response': {
      const body = data.body as Record<string, unknown> | undefined;
      const msg = body?.message as Record<string, unknown> | undefined;
      if (!msg) return null;

      const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
      if (toolCalls && toolCalls.length > 0) {
        const names = toolCalls.map(tc => {
          const fn = tc.function as Record<string, unknown>;
          return fn?.name as string ?? 'unknown';
        });
        return { id: `${sessionId}-${event.seq}`, session_id: sessionId, type: 'tool_call', content: names.join(', '), time: event.t };
      }

      const content = (msg.content as string) ?? '';
      return { id: `${sessionId}-${event.seq}`, session_id: sessionId, type: 'answer', content: content.slice(0, 300), time: event.t };
    }

    case 'stream_end': {
      const content = (data.assembled_content as string) ?? '';
      return { id: `${sessionId}-${event.seq}`, session_id: sessionId, type: 'answer', content: content.slice(0, 300), time: event.t };
    }

    default:
      return null;
  }
}

function stepIcon(type: string): string {
  switch (type) {
    case 'session': return '●';
    case 'user': return '→';
    case 'tool_call': return '⚡';
    case 'tool_result': return '←';
    case 'answer': return '✓';
    default: return '·';
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
