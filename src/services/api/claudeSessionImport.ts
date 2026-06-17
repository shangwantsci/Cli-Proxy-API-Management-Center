import { apiClient } from './client';

export interface ClaudeSessionImportStartRequest {
  sessionKeys?: string[];
  proxyUrl?: string;
  prefix?: string;
  note?: string;
  concurrency?: number;
  timeoutSeconds?: number;
  delayMinMs?: number;
  delayMaxMs?: number;
}

export interface ClaudeSessionImportResult {
  session_key_hash: string;
  status: string;
  import_action?: 'new_imported' | 'existing_updated' | string;
  reason?: string;
  auth_file?: string;
  email?: string;
  auth_source?: string;
  auth_method_label?: string;
  plan_type?: string;
  subscription_multiplier?: number;
  subscription_precision?: string;
  subscription_capacity_units?: number;
}

export interface ClaudeSessionImportJob {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'canceled';
  proxy_url?: string;
  redacted_proxy_url?: string;
  concurrency: number;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  total_processed: number;
  imported: number;
  new_imported?: number;
  existing_updated?: number;
  failed: number;
  duplicate: number;
  error?: string;
  failure_reasons?: Record<string, number>;
  rejected: number;
  rejected_reasons?: Record<string, number>;
  new_plan_counts?: Record<string, number>;
  existing_plan_counts?: Record<string, number>;
  results?: ClaudeSessionImportResult[];
}

export interface ClaudeSessionImportStartResponse {
  status: string;
  job_id: string;
  job: ClaudeSessionImportJob;
}

const toPayload = (payload: ClaudeSessionImportStartRequest) => ({
  session_keys: payload.sessionKeys?.length ? payload.sessionKeys : undefined,
  proxy_url: payload.proxyUrl || undefined,
  prefix: payload.prefix || undefined,
  note: payload.note || undefined,
  concurrency: payload.concurrency,
  timeout_seconds: payload.timeoutSeconds,
  delay_min_ms: payload.delayMinMs,
  delay_max_ms: payload.delayMaxMs,
});

export const claudeSessionImportApi = {
  start: (payload: ClaudeSessionImportStartRequest) =>
    apiClient.post<ClaudeSessionImportStartResponse>('/claude-session-import-jobs', toPayload(payload)),

  get: (jobId: string) => apiClient.get<ClaudeSessionImportJob>(`/claude-session-import-jobs/${jobId}`),

  cancel: (jobId: string) => apiClient.post<ClaudeSessionImportJob>(`/claude-session-import-jobs/${jobId}/cancel`),
};
