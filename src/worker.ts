// Cloudflare Worker 入口：/api/* 交给接口处理，其余请求返回前端静态文件（dist/）。
// 部署到 Cloudflare Pages 时不用这个文件，接口由 functions/api/[[path]].ts 提供。

import { handleApi, type ApiEnv } from './server/routes.ts';

interface WorkerEnv extends ApiEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
};
