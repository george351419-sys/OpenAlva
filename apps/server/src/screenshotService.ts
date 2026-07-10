/**
 * 截图服务：playwright-core 驱动本机 Chrome（channel:'chrome'，
 * 不下载 Chromium）。用于 release 后生成 Explore 卡片截图，
 * 以及 agent 的 screenshot 工具自检视觉产出。失败一律抛错，
 * 由调用方决定是否 best-effort 吞掉。
 */

export interface ScreenshotOptions {
  url: string;
  outFile: string;
  width?: number;
  height?: number;
  timeoutMs?: number;
}

export async function captureScreenshot(opts: ScreenshotOptions): Promise<void> {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: opts.width ?? 1280, height: opts.height ?? 800 },
      // 服务端据此跳过浏览数计数（截图不算一次真实浏览）
      extraHTTPHeaders: { 'x-openalva-screenshot': '1' },
    });
    // 不用 networkidle：自刷新的 watch 页永远不会 idle。load + 固定短延迟；
    // goto 超时也继续尝试截图（页面通常已渲染出可用内容）
    await page
      .goto(opts.url, { waitUntil: 'load', timeout: opts.timeoutMs ?? 15_000 })
      .catch(() => undefined);
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: opts.outFile });
  } finally {
    await browser.close();
  }
}
