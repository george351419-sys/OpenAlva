import { execFile } from 'node:child_process';

/** 本地通知投递。默认 macOS 系统通知（osascript），其他平台降级打日志。 */

export interface LocalNotification {
  title: string;
  body: string;
}

export type Notifier = (n: LocalNotification) => Promise<void>;

export const defaultNotifier: Notifier = async (n) => {
  if (process.platform !== 'darwin') {
    console.log(`[notify] ${n.title}: ${n.body}`);
    return;
  }
  // 先截断再转义：反过来会把转义对切半，尾部孤立 \ 转义掉收尾引号
  const esc = (s: string, max: number): string =>
    s.slice(0, max).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const script = `display notification "${esc(n.body, 500)}" with title "${esc(n.title, 100)}"`;
  await new Promise<void>((resolve) => {
    execFile('osascript', ['-e', script], () => resolve()); // 投递失败不致命
  });
};
