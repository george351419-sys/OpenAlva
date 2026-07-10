import { describe, expect, it } from 'vitest';
import { loadCatalog, findEndpoint, skillNames, publicEndpoints } from './catalog.js';
import {
  ArraysViaAlvaSource,
  buildFetchCode,
  extractSentinel,
  type AlvaRunner,
} from './arraysViaAlva.js';
import { DataError } from './types.js';

describe('catalog（镜像产物）', () => {
  it('加载 19 个 skill、区分 public / pro-gated', () => {
    const cat = loadCatalog();
    expect(cat.skills).toHaveLength(19);
    expect(skillNames(cat)).toContain('arrays-data-api-spot-market-price-and-volume');
    const pub = publicEndpoints(cat);
    expect(pub.length).toBeGreaterThan(0);
    expect(pub.every((e) => !e.pro_required)).toBe(true);
  });

  it('findEndpoint 支持 file 名与 path 匹配，未知端点报错', () => {
    const cat = loadCatalog();
    const byFile = findEndpoint(
      cat,
      'arrays-data-api-spot-market-price-and-volume',
      'binance-spot-usdt-kline',
    );
    expect(byFile.path).toBe('/api/v1/crypto/binance/spot/usdt/kline');
    const byPath = findEndpoint(
      cat,
      'arrays-data-api-spot-market-price-and-volume',
      '/api/v1/crypto/binance/spot/usdt/kline',
    );
    expect(byPath.file).toBe('binance-spot-usdt-kline');
    expect(() => findEndpoint(cat, 'no-such-skill', 'x')).toThrow(DataError);
    expect(() =>
      findEndpoint(cat, 'arrays-data-api-spot-market-price-and-volume', 'no-such-ep'),
    ).toThrow(/Unknown endpoint/);
  });
});

describe('buildFetchCode / extractSentinel', () => {
  it('参数编码进 URL，代码含 Bearer 鉴权与哨兵输出', () => {
    const code = buildFetchCode('https://data-tools.prd.space.id', '/api/v1/crypto/binance/spot/usdt/kline', {
      symbol: 'BTC',
      interval: '1d',
      limit: 3,
      skip: undefined,
    });
    expect(code).toContain('symbol=BTC');
    expect(code).toContain('interval=1d');
    expect(code).toContain('limit=3');
    expect(code).not.toContain('skip=');
    expect(code).toContain('Authorization');
    expect(code).toContain('ARRAYS_JWT');
  });

  it('从多行日志里提取最后一条哨兵负载', () => {
    const logs = 'some log\n__OPENALVA_DATA__{"ok":true,"status":200,"data":[{"x":1}]}\ntrailing\n';
    const p = extractSentinel(logs);
    expect(p?.ok).toBe(true);
    expect(p?.data).toEqual([{ x: 1 }]);
    expect(extractSentinel('no sentinel here')).toBeNull();
  });
});

function stubRunner(logs: string, extra: Partial<{ status: string; error: string }> = {}): AlvaRunner {
  return { run: async () => ({ logs, status: 'completed', ...extra }) };
}

describe('ArraysViaAlvaSource.call', () => {
  const cat = loadCatalog();

  it('public 端点：解析云沙箱返回的数据', async () => {
    const src = new ArraysViaAlvaSource({
      catalog: cat,
      runner: stubRunner(
        '__OPENALVA_DATA__{"ok":true,"status":200,"data":[{"price_close":62290}],"request_id":"r1"}\n',
      ),
    });
    const env = await src.call({
      skill: 'arrays-data-api-spot-market-price-and-volume',
      endpoint: 'binance-spot-usdt-kline',
      params: { symbol: 'BTC', interval: '1d', start_time: 1, end_time: 2 },
    });
    expect(env.success).toBe(true);
    expect(env.data).toHaveLength(1);
    expect(env.request_id).toBe('r1');
  });

  it('pro-gated 端点：本地即拒绝，不发起 run', async () => {
    let called = false;
    const proSkill = cat.skills.find((s) => s.endpoints.some((e) => e.pro_required))!;
    const proEp = proSkill.endpoints.find((e) => e.pro_required)!;
    const src = new ArraysViaAlvaSource({
      catalog: cat,
      runner: { run: async () => ((called = true), { logs: '' }) },
    });
    await expect(
      src.call({ skill: proSkill.name, endpoint: proEp.file, params: {} }),
    ).rejects.toMatchObject({ code: 'PRO_GATED' });
    expect(called).toBe(false);
  });

  it('鉴权失败 → AUTH；上游失败 → UPSTREAM；无哨兵 → PARSE', async () => {
    const base = {
      skill: 'arrays-data-api-spot-market-price-and-volume',
      endpoint: 'binance-spot-usdt-kline',
      params: {},
    };
    await expect(
      new ArraysViaAlvaSource({
        catalog: cat,
        runner: stubRunner('__OPENALVA_DATA__{"ok":false,"status":401}\n'),
      }).call(base),
    ).rejects.toMatchObject({ code: 'AUTH' });

    await expect(
      new ArraysViaAlvaSource({
        catalog: cat,
        runner: stubRunner('__OPENALVA_DATA__{"ok":false,"status":500}\n'),
      }).call(base),
    ).rejects.toMatchObject({ code: 'UPSTREAM' });

    await expect(
      new ArraysViaAlvaSource({ catalog: cat, runner: stubRunner('nothing here') }).call(base),
    ).rejects.toMatchObject({ code: 'PARSE' });
  });

  it('alva run 自身失败 → UPSTREAM', async () => {
    const src = new ArraysViaAlvaSource({
      catalog: cat,
      runner: stubRunner('', { status: 'failed', error: 'boom' }),
    });
    await expect(
      src.call({
        skill: 'arrays-data-api-spot-market-price-and-volume',
        endpoint: 'binance-spot-usdt-kline',
        params: {},
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM' });
  });
});
