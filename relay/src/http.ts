import type { IncomingMessage, ServerResponse } from 'node:http';

export function stripEvengrok(url: string | undefined): string {
  return (url ?? '').split('?')[0]!.replace(/^\/evengrok(?=\/)/, '');
}

export function handleRelayHttp(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    log: (line: string) => void;
    serveApp: (path: string, res: ServerResponse) => void;
    health: () => unknown;
  },
): void {
  const path = stripEvengrok(req.url);
  res.on('finish', () => deps.log(`http ${req.method} ${path} ${res.statusCode} ${String(req.headers['user-agent'] ?? '').slice(0, 60)}`));
  if (path === '/diag') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method !== 'POST') {
      res.statusCode = 204;
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer | string) => {
      if (body.length < 4096) body += String(chunk);
    });
    req.on('end', () => {
      deps.log(`diag ${body.slice(0, 4096)}`);
      res.statusCode = 204;
      res.end();
    });
    return;
  }
  if (path === '/health') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(deps.health()));
    return;
  }
  if (req.method === 'GET' && path.startsWith('/app/')) return deps.serveApp(path, res);
  res.statusCode = 404;
  res.end();
}
