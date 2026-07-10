import type { RunEnvelope } from './vmRun.js';

/**
 * host(runFeed) <-> child(feedChild) 的 IPC 消息协议。
 * 全部 JSON 可序列化；httpFetch 是宿主函数无法跨进程，
 * 故 opts.httpFetch 存在时 child 走 http 桥（http / http-result 往返）。
 */

export interface RunMessage {
  type: 'run';
  root: string;
  user: string;
  entryPath?: string;
  code?: string;
  args?: unknown;
  /** true = feed 的 net/http 请求经 IPC 回宿主执行（如 Arrays 路由 fetch） */
  httpBridge: boolean;
}

export interface HttpRequestMessage {
  type: 'http';
  id: number;
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
}

export interface HttpResultMessage {
  type: 'http-result';
  id: number;
  ok: boolean;
  response?: { status: number; ok: boolean; headers: Record<string, string>; body: string };
  error?: string;
}

export interface ResultMessage {
  type: 'result';
  envelope: RunEnvelope;
}

export type HostToChild = RunMessage | HttpResultMessage;
export type ChildToHost = HttpRequestMessage | ResultMessage;
