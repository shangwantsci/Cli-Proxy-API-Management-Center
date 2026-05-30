import { apiClient } from './client';

export interface ClaudeSessionImportStartRequest {
  sourceUrl?: string;
  apiPath?: string;
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
  reason?: string;
  auth_file?: string;
  email?: string;
  auth_source?: string;
  auth_method_label?: string;
}

export interface ClaudeSessionImportJob {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'canceled';
  source_url: string;
  api_endpoint: string;
  proxy_url?: string;
  redacted_proxy_url?: string;
  concurrency: number;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  total_fetched: number;
  total_processed: number;
  imported: number;
  failed: number;
  duplicate: number;
  error?: string;
  failure_reasons?: Record<string, number>;
  results?: ClaudeSessionImportResult[];
}

export interface ClaudeSessionImportStartResponse {
  status: string;
  job_id: string;
  job: ClaudeSessionImportJob;
}

const toPayload = (payload: ClaudeSessionImportStartRequest) => ({
  source_url: payload.sourceUrl || undefined,
  api_path: payload.apiPath || undefined,
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
