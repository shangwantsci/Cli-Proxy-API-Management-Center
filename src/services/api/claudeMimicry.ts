import { apiClient } from './client';

export type ClaudeMimicryStatus = 'aligned' | 'warning' | 'failed' | 'waiting';

export interface ClaudeMimicryBaseline {
  model: string;
  family: string;
  claude_version: string;
  cch_seed: string;
  expected_beta_count: number;
  expected_betas: string[];
  expected_system_hashes: string[];
  expected_top_fields: string[];
  expected_efforts?: string[];
  expected_tool_count_hint: string;
}

export interface ClaudeMimicrySystemBlock {
  index: number;
  label: string;
  status: ClaudeMimicryStatus;
  hash?: string;
  expected_hash?: string;
  length: number;
  detail?: string;
}

export interface ClaudeMimicryAudit {
  status: ClaudeMimicryStatus;
  checked_at: string;
  model: string;
  request_path: string;
  baseline: ClaudeMimicryBaseline;
  system?: {
    status: ClaudeMimicryStatus;
    blocks?: ClaudeMimicrySystemBlock[];
  };
  cch?: {
    status: ClaudeMimicryStatus;
    signed: boolean;
    seed: string;
    actual?: string;
    expected?: string;
    detail?: string;
  };
  betas?: {
    status: ClaudeMimicryStatus;
    count: number;
    expected_count: number;
    tokens?: string[];
    missing?: string[];
    unexpected?: string[];
  };
  thinking?: {
    status: ClaudeMimicryStatus;
    type?: string;
    effort?: string;
    top_fields?: string[];
    detail?: string;
  };
  tools?: {
    status: ClaudeMimicryStatus;
    count: number;
    names?: string[];
    schema_signature?: string;
    tool_choice?: string;
    unknown?: string[];
    leaky_names?: string[];
    description_warnings?: string[];
    schema_warnings?: string[];
  };
  headers?: {
    status: ClaudeMimicryStatus;
    user_agent?: string;
    package_version?: string;
    runtime_version?: string;
    os?: string;
    arch?: string;
    missing?: string[];
    blocked?: string[];
    unexpected?: string[];
  };
  warnings?: string[];
  failures?: string[];
}

export interface ClaudeMimicryAuditResponse {
  has_recent_request: boolean;
  audit: ClaudeMimicryAudit;
}

export type ClaudeMimicryGuardAction = 'allow' | 'degrade' | 'block';

export interface ClaudeMimicryEvent {
  id: string;
  request_id?: string;
  at: string;
  client_source: string;
  source_format?: string;
  action: ClaudeMimicryGuardAction;
  guard_mode: string;
  audit_status: ClaudeMimicryStatus;
  model?: string;
  request_path?: string;
  auth_id?: string;
  auth_label?: string;
  upstream_attempted: boolean;
  upstream_status?: number;
  upstream_error?: string;
  reasons?: string[];
  warnings?: string[];
  failures?: string[];
}

export interface ClaudeMimicryClientStat {
  client_source: string;
  total: number;
  allowed: number;
  degraded: number;
  blocked: number;
  last_seen: string;
  last_reason?: string;
}

export interface ClaudeMimicryEventsResponse {
  events: ClaudeMimicryEvent[];
  client_stats: Record<string, ClaudeMimicryClientStat>;
}

export const claudeMimicryApi = {
  getAudit: (model = 'claude-sonnet-4-6') =>
    apiClient.get<ClaudeMimicryAuditResponse>('/claude-mimicry-audit', {
      params: { model },
    }),
  getEvents: (limit = 100) =>
    apiClient.get<ClaudeMimicryEventsResponse>('/claude-mimicry-events', {
      params: { limit },
    }),
};
