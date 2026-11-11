import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { handleRelayHttp } from './http.ts';

test('POST /diag on the shared handler is logged, including the /evengrok prefix', async () => {
  const logs: string[] = [];
  const server = createServer((req, res) => {
    handleRelayHttp(req, res, {
      log: line => logs.push(line),
      serveApp: (_path, response: ServerResponse) => {
        response.statusCode = 404;
        response.end();
      },
      health: () => ({ ok: true }),
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const body = JSON.stringify({ event: 'attempt', result: 'closed', hasToken: false, candidates: ['ws://127.0.0.1/ws'] });
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/evengrok/diag', method: 'POST' }, (res: IncomingMessage) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });
  await new Promise(r => setTimeout(r, 30));
  server.close();
  assert.equal(status, 204);
  assert.ok(logs.some(line => line.startsWith('diag ') && line.includes('"hasToken":false') && line.includes('attempt')));
  assert.equal(logs.some(line => line.includes('secret-token')), false);
});
