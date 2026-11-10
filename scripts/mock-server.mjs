// 仅用于本地检查界面：提供 dist/ 静态文件，并用预设的模型回复模拟 /api/agent。
// 不会部署到线上；线上的 /api/agent 由 functions/ 实时调用 DeepSeek。
// 用法：npm run build && node scripts/mock-server.mjs [端口]

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const port = Number(process.argv[2]) || 4173;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.bcmap': 'application/octet-stream' };

import { script, sse } from './mock-script.mjs';

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/config') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ requireCode: false, codeOk: true, hasKey: true, ops: { model: 'deepseek-flash', thinking: true, effort: 'high' }, review: { model: 'deepseek-flash', thinking: true, effort: 'high' }, models: ['deepseek-flash'] }));
  }
  if (url.pathname === '/api/agent' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { role, messages, thinking } = JSON.parse(body);
      setTimeout(() => sse(res, script(role, messages), { thinking }), 400);
    });
    return;
  }
  let file = join(dist, decodeURIComponent(url.pathname));
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(port, () => console.log(`mock server on http://localhost:${port}`));
