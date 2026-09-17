import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import next from 'next';
import { createProxyMiddleware } from 'http-proxy-middleware';

const dev = process.argv.includes('--dev');
const port = Number(process.env.PORT ?? process.env.WEB_PORT ?? 3000);
const hostname = process.env.LISTEN_IP ?? '0.0.0.0';
// Next lazily installs its router/HMR upgrade listener on httpServer. Give it
// an unbound event target so it cannot also close our terminal upgrade socket.
const nextUpgrades = http.createServer();
const app = next({
  dev,
  dir: path.dirname(fileURLToPath(import.meta.url)),
  hostname,
  port,
  httpServer: nextUpgrades,
});
await app.prepare();
const handle = app.getRequestHandler();
const terminalProxy = createProxyMiddleware({
  target: process.env.API_BASE_URL ?? 'http://127.0.0.1:4000',
  changeOrigin: true,
  ws: true,
  on: {
    error: (_error, _request, response) => {
      if ('destroy' in response) response.destroy();
    },
  },
});
const server = http.createServer((request, response) => void handle(request, response));
const sockets = new Set();
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
server.on('upgrade', (request, socket, head) => {
  if (request.url?.split('?')[0] !== '/api/terminals/socket') {
    if (!nextUpgrades.emit('upgrade', request, socket, head)) socket.destroy();
    return;
  }
  try {
    const dataHome = process.env.AGENTWAYPOINT_HOME;
    if (!dataHome) throw new Error('AGENTWAYPOINT_HOME is required');
    const external = new URL(
      `${request.socket.encrypted ? 'https' : 'http'}://${request.headers.host}`,
    ).origin;
    for (const name of Object.keys(request.headers))
      if (name.startsWith('x-aw-terminal-')) delete request.headers[name];
    request.headers['x-aw-terminal-key'] = fs
      .readFileSync(path.join(dataHome, 'run', 'terminal-ingress.key'), 'utf8')
      .trim();
    request.headers['x-aw-terminal-external-origin'] = external;
    terminalProxy.upgrade(request, socket, head);
  } catch {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
});
server.listen(port, hostname, () => {
  const actualPort = server.address().port;
  process.stdout.write(`Web listening on ${hostname}:${actualPort}\n`);
  process.send?.({ type: 'ready', port: actualPort });
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  for (const socket of sockets) socket.destroy();
  server.close();
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
