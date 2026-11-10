// /api/* 的路由，Cloudflare Worker（src/worker.ts）和 Cloudflare Pages Functions（functions/api/）共用。

import { handleAgent, handleConfig } from './agent-handler.ts';
import { handleEmbed, type EmbedEnv } from './embed-handler.ts';

export type ApiEnv = EmbedEnv;

export function handleApi(request: Request, env: ApiEnv): Promise<Response> | Response {
  const { pathname } = new URL(request.url);
  if (pathname === '/api/agent') return handleAgent(request, env);
  if (pathname === '/api/config') return handleConfig(request, env);
  if (pathname === '/api/embed') return handleEmbed(request, env);
  return new Response(JSON.stringify({ error: '接口不存在' }), { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
