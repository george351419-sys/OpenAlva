import type { HttpFetchImpl, HttpResponse } from '@openalva/feed-runtime';
import { cliAlvaRunner, type AlvaRunner } from './arraysViaAlva.js';

/**
 * 路由型 httpFetch，供 feed-runtime 使用。
 *
 * feed 代码对 Arrays（data-tools.prd.space.id）的 `http.fetch(url, Bearer <jwt>)`
 * 在本地无法鉴权——JWT 只在 Alva 云沙箱的 secrets 里。此包装拦截命中 Arrays 主机
 * 的请求，把「用云端 JWT 取这个 URL」的代码发进 `alva run` 执行，再合成一个
 * HttpResponse 返回。feed 自带的 Authorization 头被忽略（云端注入真 JWT），
 * 因此 crypto-top5-watch 等参考实现无需改动即可在本地跑真实数据。
 *
 * 非 Arrays 请求原样交给 fallback（默认本地 fetch）。
 */

export interface ArraysRoutingOptions {
  /** Arrays 基址主机（默认 data-tools.prd.space.id）。仅命中此主机的请求走云端。 */
  arraysHost?: string;
  runner?: AlvaRunner;
  fallback: HttpFetchImpl;
}

const SENTINEL = '__OPENALVA_HTTP__';

export function createArraysRoutingFetch(opts: ArraysRoutingOptions): HttpFetchImpl {
  const arraysHost = opts.arraysHost ?? 'data-tools.prd.space.id';
  const runner = opts.runner ?? cliAlvaRunner;

  return async (url, init) => {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      host = '';
    }
    if (host !== arraysHost) return opts.fallback(url, init);

    const method = init?.method ?? 'GET';
    const code = buildRawFetchCode(url, method, init?.body);
    const envelope = await runner.run(code);
    if (envelope.status === 'failed' || envelope.error) {
      throw new Error(`arrays-via-alva run failed: ${envelope.error ?? 'unknown'}`);
    }
    const payload = extractRawSentinel(envelope.logs ?? '');
    if (!payload) throw new Error('arrays-via-alva: no sentinel payload in run logs');
    return synthResponse(payload);
  };
}

interface RawPayload {
  status: number;
  ok: boolean;
  body: string;
}

/** 生成云端取数代码：用云 JWT 请求完整 URL，回传原始响应体字符串。 */
export function buildRawFetchCode(url: string, method: string, body?: string): string {
  const urlLit = JSON.stringify(url);
  const methodLit = JSON.stringify(method);
  const bodyLit = body === undefined ? 'undefined' : JSON.stringify(body);
  const sentinel = JSON.stringify(SENTINEL);
  return `
const http = require("net/http");
const secret = require("secret-manager");
(async () => {
  const jwt = secret.loadPlaintext("ARRAYS_JWT");
  const init = { method: ${methodLit}, headers: { Authorization: "Bearer " + (jwt || "") } };
  ${body === undefined ? '' : `init.headers["Content-Type"] = "application/json"; init.body = ${bodyLit};`}
  const resp = await http.fetch(${urlLit}, init);
  const text = await resp.text();
  console.log(${sentinel} + JSON.stringify({ status: resp.status, ok: resp.ok, body: text }));
})();
`;
}

export function extractRawSentinel(logs: string): RawPayload | null {
  const idx = logs.lastIndexOf(SENTINEL);
  if (idx === -1) return null;
  const rest = logs.slice(idx + SENTINEL.length);
  const nl = rest.indexOf('\n');
  const jsonStr = nl === -1 ? rest : rest.slice(0, nl);
  try {
    return JSON.parse(jsonStr) as RawPayload;
  } catch {
    return null;
  }
}

function synthResponse(payload: RawPayload): HttpResponse {
  return {
    status: payload.status,
    ok: payload.ok,
    // 限制：云端响应头未回传，恒为空。参考实现 feed 只用 body/status，
    // 若未来 feed 读 content-type/rate-limit 会静默拿到空——届时需扩展哨兵负载。
    headers: {},
    text: async () => payload.body,
    json: async () => JSON.parse(payload.body),
  };
}
