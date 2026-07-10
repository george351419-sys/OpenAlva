import { describe, expect, it, vi } from 'vitest';
import {
  createArraysRoutingFetch,
  buildRawFetchCode,
  extractRawSentinel,
} from './arraysRouting.js';
import type { AlvaRunner } from './arraysViaAlva.js';

describe('createArraysRoutingFetch', () => {
  it('Arrays 主机 → 云端 run；其余 → fallback', async () => {
    const runner: AlvaRunner = {
      run: async () =>
        ({
          logs: '__OPENALVA_HTTP__{"status":200,"ok":true,"body":"{\\"success\\":true,\\"data\\":[1,2]}"}\n',
          status: 'completed',
        }),
    };
    const fallback = vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: {},
      text: async () => 'local',
      json: async () => ({ local: true }),
    }));

    const fetchImpl = createArraysRoutingFetch({ runner, fallback });

    // Arrays host → 走云端，fallback 不触发
    const arraysResp = await fetchImpl(
      'https://data-tools.prd.space.id/api/v1/crypto/binance/spot/usdt/kline?symbol=BTC',
      { headers: { Authorization: 'Bearer local-placeholder' } },
    );
    expect(arraysResp.status).toBe(200);
    expect(await arraysResp.json()).toEqual({ success: true, data: [1, 2] });
    expect(fallback).not.toHaveBeenCalled();

    // 其他 host → fallback
    const other = await fetchImpl('https://example.com/x');
    expect(await other.text()).toBe('local');
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('云端 run 失败 → 抛错', async () => {
    const runner: AlvaRunner = { run: async () => ({ status: 'failed', error: 'boom' }) };
    const fetchImpl = createArraysRoutingFetch({
      runner,
      fallback: async () => {
        throw new Error('should not be called');
      },
    });
    await expect(
      fetchImpl('https://data-tools.prd.space.id/api/v1/x'),
    ).rejects.toThrow(/run failed/);
  });
});

describe('buildRawFetchCode / extractRawSentinel', () => {
  it('生成含 URL、方法、JWT 的取数代码', () => {
    const code = buildRawFetchCode('https://data-tools.prd.space.id/api/v1/x?a=1', 'GET');
    expect(code).toContain('data-tools.prd.space.id/api/v1/x?a=1');
    expect(code).toContain('ARRAYS_JWT');
    expect(code).toContain('"GET"');
  });

  it('提取原始响应哨兵', () => {
    const payload = extractRawSentinel('x\n__OPENALVA_HTTP__{"status":200,"ok":true,"body":"hi"}\n');
    expect(payload).toEqual({ status: 200, ok: true, body: 'hi' });
    expect(extractRawSentinel('none')).toBeNull();
  });
});
