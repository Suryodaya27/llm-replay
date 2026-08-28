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
        const result = eventToStep(msg.session_id, event);
        if (result) {
          const newSteps = Array.isArray(result) ? result : [result];
          setSteps((prev) => {
            const updated = [...prev, ...newSteps];
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

function eventToStep(sessionId: string, event: { seq: number; t: number; type: string; data: unknown }): LiveStep | LiveStep[] | null {
  const data = event.data as Record<string, unknown>;

  switch (event.type) {
    case 'meta':
      return { id: `${sessionId}-${event.seq}`, session_id: sessionId, type: 'session', content: `Session started · ${(data.model as string) ?? 'unknown model'}`, time: event.t };

    case 'tool_call': {
      // From hooks — data contains tool info directly
      const content = (data.content as string) ?? (data.toolName as string) ?? (data.name as string) ?? JSON.stringify(data).slice(0, 150);
      return { id: `${sessionId}-${event.seq}`, session_id: sessionId, type: 'tool_call', content, time: event.t };
    }

    case 'user': {
      // From hooks — user prompt
      const content = (data.content as string) ?? (data.userPrompt as string) ?? (data.prompt as string) ?? JSON.stringify(data).slice(0, 150);
      return { id: `${sessionId}-${event.seq}`, session_id: sessionId, type: 'user', content, time: event.t };
    }

    case 'session': {
      const content = (data.content as string) ?? 'Session event';
      return { id: `${sessionId}-${event.seq}`, session_id: sessionId, type: 'session', content, time: event.t };
    }

    case 'request': {
      const body = data.body as Record<string, unknown> | undefined;
      const messages = body?.messages as Array<Record<string, unknown>> | undefined;
      if (!messages) return null;

      // Check if this is the first user message
      if (messages.length <= 2 && messages[messages.length - 1]?.role === 'user') {
        const content = (messages[messages.length - 1].content as string) ?? '';
        return { id: `${sessionId}-${event.seq}`, session_id: sessionId, type: 'user', content, time: event.t };
      }

      // Find tool results that come AFTER the last assistant message (these are new)
      let lastAssistantIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') { lastAssistantIdx = i; break; }
      }

      const newToolResults: LiveStep[] = [];
      for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === 'tool') {
          const content = (msg.content as string) ?? '';
          newToolResults.push({
            id: `${sessionId}-${event.seq}-tr${i}`,
            session_id: sessionId,
            type: 'tool_result',
            content: content.slice(0, 200),
            time: event.t,
          });
        }
      }
      if (newToolResults.length > 0) return newToolResults;
      return null;
    }

    case 'response': {
      const body = data.body as Record<string, unknown> | undefined;
      const msg = body?.message as Record<string, unknown> | undefined;
      if (!msg) return null;

      const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
      if (toolCalls && toolCalls.length > 0) {
        // Return multiple steps for multiple tool calls
        return toolCalls.map((tc, i) => {
          const fn = tc.function as Record<string, unknown>;
          const name = (fn?.name as string) ?? 'unknown';
          const args = typeof fn?.arguments === 'string'
            ? fn.arguments
            : JSON.stringify(fn?.arguments ?? {});
          return {
            id: `${sessionId}-${event.seq}-tc${i}`,
            session_id: sessionId,
            type: 'tool_call',
            content: `${name}(${args})`,
            time: event.t,
          };
        });
      }

      const content = (msg.content as string) ?? '';
      return [{ id: `${sessionId}-${event.seq}`, session_id: sessionId, type: 'answer', content: content.slice(0, 300), time: event.t }];
    }

    case 'stream_end': {
      const content = (data.assembled_content as string) ?? '';
      return { id: `${sessionId}-${event.seq}`, session_id: sessionId, type: 'answer', content: content.slice(0, 300), time: event.t };
    }

    default: {
      // Handle any unknown event type (hooks, custom events)
      const content = typeof data === 'object' ? JSON.stringify(data).slice(0, 200) : String(data);
      return { id: `${sessionId}-${event.seq}`, session_id: sessionId, type: event.type, content, time: event.t };
    }
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
