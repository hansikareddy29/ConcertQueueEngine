import { WebSocket } from 'ws';

export interface WsMessage {
  type: string;
  [key: string]: any;
}

export class WsManager {
  // Map of "eventId:userId" -> WebSocket
  private connections: Map<string, WebSocket> = new Map();

  register(eventId: string, userId: string, socket: WebSocket): void {
    const key = `${eventId}:${userId}`;
    this.connections.set(key, socket);

    socket.on('close', () => {
      this.connections.delete(key);
    });

    socket.on('error', (err: any) => {
      console.warn(`[WS] Error for ${key}:`, err?.message || err);
      this.connections.delete(key);
    });
  }

  unregister(eventId: string, userId: string): void {
    const key = `${eventId}:${userId}`;
    const sock = this.connections.get(key);
    if (sock) {
      try {
        sock.close();
      } catch {}
      this.connections.delete(key);
    }
  }

  sendToUser(eventId: string, userId: string, payload: WsMessage): boolean {
    const key = `${eventId}:${userId}`;
    const sock = this.connections.get(key);
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  broadcastToEvent(eventId: string, payload: WsMessage): void {
    const msg = JSON.stringify(payload);
    for (const [key, sock] of this.connections.entries()) {
      if (key.startsWith(`${eventId}:`) && sock.readyState === WebSocket.OPEN) {
        sock.send(msg);
      }
    }
  }

  getActiveCount(eventId: string): number {
    let count = 0;
    for (const [key, sock] of this.connections.entries()) {
      if (key.startsWith(`${eventId}:`) && sock.readyState === WebSocket.OPEN) {
        count++;
      }
    }
    return count;
  }
}

export const wsManager = new WsManager();
