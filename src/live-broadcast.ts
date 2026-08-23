/**
 * Live Broadcast — pushes events to connected WebSocket clients in real-time.
 *
 * The API server creates a LiveBroadcast instance.
 * The capture proxy emits events to it.
 * The React UI subscribes via WebSocket and renders events live.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';

export interface LiveEvent {
  session_id: string;
  event: {
    seq: number;
    t: number;
    type: string;
    data: unknown;
  };
  /** Parsed summary for the UI (optional, computed on send) */
  parsed?: {
    step_type: 'user' | 'thinking' | 'tool_call' | 'tool_result' | 'answer' | 'streaming';
    content_preview: string;
    tool_name?: string;
    tokens?: number;
  };
}

export class LiveBroadcast {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      // Send initial handshake
      ws.send(JSON.stringify({ type: 'connected', clients: this.clients.size }));

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });
    });
  }

  /** Broadcast an event to all connected clients */
  emit(event: LiveEvent): void {
    if (this.clients.size === 0) return;

    const message = JSON.stringify({ type: 'event', ...event });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  /** Broadcast session start */
  sessionStart(sessionId: string, model?: string): void {
    const message = JSON.stringify({
      type: 'session_start',
      session_id: sessionId,
      model,
      timestamp: Date.now(),
    });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  /** Broadcast session end */
  sessionEnd(sessionId: string): void {
    const message = JSON.stringify({
      type: 'session_end',
      session_id: sessionId,
      timestamp: Date.now(),
    });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  /** Number of connected clients */
  get connectionCount(): number {
    return this.clients.size;
  }
}
