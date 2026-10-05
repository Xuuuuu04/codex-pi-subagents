import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DashboardData } from './dashboard-data.js';

const assets = fileURLToPath(new URL('../dashboard/', import.meta.url));

/** Private loopback HTTP viewer. All agent operations remain with the owning Codex connection. */
export async function startDashboard({ root, port = 4317, token = randomBytes(32).toString('hex') }) {
  const data = new DashboardData(root);
  const files = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
  const server = http.createServer((request, response) => {
    const send = (status, body, contentType = 'application/json') => {
      response.writeHead(status, { 'content-type': `${contentType}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
      response.end(contentType === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      const host = `127.0.0.1:${server.address().port}`;
      if (request.headers.host !== host) { send(403, { error: 'Invalid host' }); return; }
      if (request.method !== 'GET') { send(405, { error: 'Read-only dashboard' }); return; }
      const url = new URL(request.url, `http://${host}`);
      if (files.has(url.pathname)) {
        const [file, type] = files.get(url.pathname); send(200, fs.readFileSync(path.join(assets, file)), type); return;
      }
      const auth = Buffer.from(request.headers.authorization || ''); const expected = Buffer.from(`Bearer ${token}`);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { send(401, { error: '请通过本机面板启动命令提供的链接打开页面。' }); return; }
      if (url.pathname === '/api/health') { send(200, { service: 'pi-dashboard', pid: process.pid }); return; }
      if (url.pathname === '/api/agents') { send(200, data.list()); return; }
      const match = /^\/api\/agents\/([^/]+)$/.exec(url.pathname);
      if (match) { send(200, data.detail(match[1])); return; }
      send(404, { error: 'Not found' });
    } catch (error) { send(error.code === 'ENOENT' ? 404 : 400, { error: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, token, url: `http://127.0.0.1:${server.address().port}/#${token}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.PI_SUBAGENTS_STATE_DIR || fileURLToPath(new URL('../.agents/runtime/', import.meta.url));
  const dashboard = await startDashboard({ root, port: Number(process.env.PI_DASHBOARD_PORT || 4317) });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, 'dashboard.json'), JSON.stringify({ pid: process.pid, url: dashboard.url, startedAt: new Date().toISOString() }), { mode: 0o600 });
  const stop = () => dashboard.close().then(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
