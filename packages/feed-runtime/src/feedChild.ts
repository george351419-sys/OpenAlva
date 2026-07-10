import process from 'node:process';
import type { HttpFetchImpl } from './sandbox.js';
import { defaultHttpFetch, executeFeedVm } from './vmRun.js';
import type { ChildToHost, HostToChild, HttpResultMessage, RunMessage } from './ipc.js';

/**
 * feed 沙箱子进程入口（由 runFeed fork，execArgv 带 tsx loader）。
 * 一次 fork 只跑一个 feed：收 run → vm 执行 → 回 result → 退出。
 * 失控同步循环 / 内存超限由宿主 SIGKILL / --max-old-space-size 兜底。
 */

const pendingHttp = new Map<
  number,
  { resolve: (msg: HttpResultMessage) => void }
>();
let nextHttpId = 1;

const bridgedHttpFetch: HttpFetchImpl = (url, init) =>
  new Promise((resolve, reject) => {
    const id = nextHttpId++;
    pendingHttp.set(id, {
      resolve: (msg) => {
        pendingHttp.delete(id);
        if (msg.ok && msg.response) {
          const { status, ok, headers, body } = msg.response;
          resolve({
            status,
            ok,
            headers,
            text: async () => body,
            json: async () => JSON.parse(body),
          });
        } else {
          reject(new Error(msg.error ?? 'bridged http.fetch failed'));
        }
      },
    });
    send({ type: 'http', id, url, ...(init !== undefined ? { init } : {}) });
  });

function send(msg: ChildToHost, done?: () => void): void {
  if (!process.send) throw new Error('feedChild must be forked with an IPC channel');
  if (done) {
    process.send(msg, () => done());
  } else {
    process.send(msg);
  }
}

async function run(msg: RunMessage): Promise<void> {
  const envelope = await executeFeedVm({
    root: msg.root,
    user: msg.user,
    ...(msg.entryPath !== undefined ? { entryPath: msg.entryPath } : {}),
    ...(msg.code !== undefined ? { code: msg.code } : {}),
    ...(msg.args !== undefined ? { args: msg.args } : {}),
    httpFetch: msg.httpBridge ? bridgedHttpFetch : defaultHttpFetch,
    onLog: (line) => send({ type: 'log', line }),
  });
  send({ type: 'result', envelope }, () => process.exit(0));
}

process.on('message', (raw: HostToChild) => {
  if (raw.type === 'run') {
    void run(raw);
  } else if (raw.type === 'http-result') {
    pendingHttp.get(raw.id)?.resolve(raw);
  }
});

// loader 就绪信号：host 收到后才发 run 并起算业务超时
send({ type: 'ready' });
