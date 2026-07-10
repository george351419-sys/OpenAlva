/** Data Skill 目录的镜像类型（源自 alva data-skills 的 JSON 输出）。 */

export type EndpointTier = 'public' | 'alternative' | 'unstructured';
export type EndpointAccess = 'free_and_pro' | 'pro_only' | string;

export interface EndpointMeta {
  skill: string;
  file: string;
  method: string;
  path: string;
  tier: EndpointTier;
  required_subscription_tier: string;
  access: EndpointAccess;
  pro_required: boolean;
}

export interface SkillMeta {
  name: string;
  description: string;
  endpoint_count: number;
  pro_count: number;
  endpoints: EndpointMeta[];
}

export interface Catalog {
  mirrored_at: string;
  base_url: string;
  skills: SkillMeta[];
}

/** 统一 Arrays 响应封套。 */
export interface ArraysEnvelope<T = unknown> {
  success: boolean;
  data: T[];
  request_id?: string;
}

export type DataErrorCode =
  | 'PRO_GATED'
  | 'ENDPOINT_UNKNOWN'
  | 'SOURCE_UNAVAILABLE'
  | 'AUTH'
  | 'UPSTREAM'
  | 'PARSE';

export class DataError extends Error {
  constructor(
    readonly code: DataErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DataError';
  }
}

export interface DataCallInput {
  skill: string;
  endpoint: string;
  params: Record<string, string | number | boolean | undefined>;
}

export interface DataSource {
  readonly name: string;
  call(input: DataCallInput): Promise<ArraysEnvelope>;
}
