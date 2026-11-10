// Cloudflare Pages Functions：处理 /api/* 的请求（agent、config、embed），其余路径由 Pages 直接返回 dist/ 里的静态文件。
// 密钥 DEEPSEEK_API_KEY、可选的 ACCESS_CODE 和 Workers AI 绑定（变量名 AI）在 Pages 项目的设置里配置。

import { handleApi, type ApiEnv } from '../../src/server/routes.ts';

export const onRequest = (context: { request: Request; env: ApiEnv }): Promise<Response> | Response => handleApi(context.request, context.env);
