import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadCatalog, findEndpoint } from './catalog.js';
import {
  type ArraysEnvelope,
  type Catalog,
  type DataCallInput,
  type DataSource,
  DataError,
} from './types.js';

const execFileAsync = promisify(execFile);

/**
 * arrays-via-alva 驱动（P0）。
 *
 * JWT 存在 Alva 云沙箱的 secrets 里，本地不持有。所以取数代码被发进
 * `alva run` 的云沙箱执行——那里 `secret-manager.loadPlaintext("ARRAYS_JWT")`
 * 可用——结果经该运行的 logs 以哨兵包裹回传，本地解析。实测零 credit。
 *
 * 仅 public 端点可用；pro-gated 在本地即拒绝，不浪费一次往返。
 */

const SENTINEL = '__OPENALVA_DATA__';

export interface AlvaRunner {
  /** 执行一段 JS（等价 `alva run --code <code>`），返回执行封套。 */
  run(code: string): Promise<{ logs?: string; status?: string; error?: string | null }>;
}

/** 默认 runner：shell out 到系统 `alva` CLI。 */
export const cliAlvaRunner: AlvaRunner = {
  async run(code: string) {
    const { stdout } = await execFileAsync('alva', ['run', '--code', code], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(stdout) as { logs?: string; status?: string; error?: string | null };
  },
};

export interface ArraysViaAlvaOptions {
  runner?: AlvaRunner;
  catalog?: Catalog;
}

export class ArraysViaAlvaSource implements DataSource {
  readonly name = 'arrays-via-alva';
  private readonly runner: AlvaRunner;
  private readonly catalog: Catalog;

  constructor(opts: ArraysViaAlvaOptions = {}) {
    this.runner = opts.runner ?? cliAlvaRunner;
    this.catalog = opts.catalog ?? loadCatalog();
  }

  async call(input: DataCallInput): Promise<ArraysEnvelope> {
    const ep = findEndpoint(this.catalog, input.skill, input.endpoint);
    if (ep.pro_required) {
      throw new DataError(
        'PRO_GATED',
        `Endpoint ${input.skill}/${ep.file} is pro-gated (tier=${ep.tier}); not available on free arrays-via-alva. Configure a native driver or upgrade.`,
      );
    }

    const code = buildFetchCode(this.catalog.base_url, ep.path, input.params);
    let envelope: { logs?: string; status?: string; error?: string | null };
    try {
      envelope = await this.runner.run(code);
    } catch (err) {
      throw new DataError('SOURCE_UNAVAILABLE', `alva run failed: ${msg(err)}`);
    }

    if (envelope.status === 'failed' || envelope.error) {
      throw new DataError('UPSTREAM', `alva run reported failure: ${envelope.error ?? 'unknown'}`);
    }

    const payload = extractSentinel(envelope.logs ?? '');
    if (payload === null) {
      throw new DataError('PARSE', 'No sentinel payload found in alva run logs');
    }
    if (!payload.ok) {
      if (payload.status === 401 || payload.status === 403) {
        throw new DataError('AUTH', `Arrays auth failed (status ${payload.status})`);
      }
      throw new DataError('UPSTREAM', `Arrays request failed (status ${payload.status})`);
    }
    return { success: true, data: payload.data ?? [], ...(payload.request_id ? { request_id: payload.request_id } : {}) };
  }
}

interface SentinelPayload {
  ok: boolean;
  status: number;
  data?: unknown[];
  request_id?: string;
}

/** 生成在云沙箱执行的取数代码。参数在本地编码进 URL，避免注入。 */
export function buildFetchCode(
  baseUrl: string,
  path: string,
  params: Record<string, string | number | boolean | undefined>,
): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const url = baseUrl + path + (qs ? `?${qs}` : '');
  const urlLiteral = JSON.stringify(url);
  const sentinel = JSON.stringify(SENTINEL);
  return `
const http = require("net/http");
const secret = require("secret-manager");
(async () => {
  const jwt = secret.loadPlaintext("ARRAYS_JWT");
  if (!jwt) { console.log(${sentinel} + JSON.stringify({ ok: false, status: 0, error: "ARRAYS_JWT missing" })); return; }
  const resp = await http.fetch(${urlLiteral}, { headers: { Authorization: "Bearer " + jwt } });
  let body = null;
  try { body = await resp.json(); } catch (e) { body = null; }
  const out = { ok: resp.ok && body && body.success !== false, status: resp.status };
  if (body && Array.isArray(body.data)) out.data = body.data;
  if (body && body.request_id) out.request_id = body.request_id;
  console.log(${sentinel} + JSON.stringify(out));
})();
`;
}

export function extractSentinel(logs: string): SentinelPayload | null {
  const idx = logs.lastIndexOf(SENTINEL);
  if (idx === -1) return null;
  const rest = logs.slice(idx + SENTINEL.length);
  const nl = rest.indexOf('\n');
  const jsonStr = nl === -1 ? rest : rest.slice(0, nl);
  try {
    return JSON.parse(jsonStr) as SentinelPayload;
  } catch {
    return null;
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
