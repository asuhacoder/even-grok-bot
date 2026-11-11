import type { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { connectedOutcome, connectionLog } from './auth.ts';
import type { AdmitVia } from './auth.ts';
import { parseClientMessage } from '../../shared/protocol.ts';
import type { ClientMessage, ServerMessage } from '../../shared/protocol.ts';

export interface SocketHooks {
  authorized(token: string): boolean;
  log(line: string): void;
  welcome(): Extract<ServerMessage, { type: 'welcome' }>;
  onAuthed(ws: WebSocket): void;
  onMessage(ws: WebSocket, message: ClientMessage): void;
  onBinary(ws: WebSocket, data: Buffer): void;
  onClose(ws: WebSocket, authed: boolean): void;
}

export function attachRelaySocket(ws: WebSocket, admission: { readonly owner: boolean; readonly via: AdmitVia }, hooks: SocketHooks): void {
  let authed = false;
  const timer = setTimeout(() => {
    if (authed) return;
    hooks.log(connectionLog('auth timeout'));
    ws.close(4401, 'auth timeout');
  }, 5000);
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const bytes = asBuffer(data);
      if (authed && bytes) hooks.onBinary(ws, bytes);
      return;
    }
    const message = parseClientMessage(String(data));
    if (!message) return;
    if (!authed) {
      if (message.type === 'hello' && (admission.owner || hooks.authorized(message.token))) {
        authed = true;
        hooks.log(connectionLog(connectedOutcome(admission.owner, admission.via)));
        clearTimeout(timer);
        hooks.onAuthed(ws);
        ws.send(JSON.stringify(hooks.welcome()));
      } else {
        hooks.log(connectionLog('denied'));
        ws.send(JSON.stringify({ type: 'denied', reason: 'トークンが違います' } satisfies ServerMessage));
        ws.close(4401, 'denied');
      }
      return;
    }
    hooks.onMessage(ws, message);
  });
  ws.on('close', () => {
    clearTimeout(timer);
    hooks.onClose(ws, authed);
  });
}

function asBuffer(data: RawData): Buffer | undefined {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return undefined;
}
