import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { parseDocument } from 'yaml';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconBot,
  IconCheck,
  IconExternalLink,
  IconFileText,
  IconRefreshCw,
  IconSettings,
  IconShield,
  IconTrash2,
} from '@/components/ui/icons';
import { useAuthStore, useConfigStore, useNotificationStore } from '@/stores';
import {
  apiCallApi,
  apiKeysApi,
  configFileApi,
  getApiCallErrorMessage,
  type ApiCallResult,
} from '@/services/api';
import { authFilesApi, type AuthFileFieldsPatch } from '@/services/api/authFiles';
import { oauthApi } from '@/services/api/oauth';
import type { AuthFileItem } from '@/types/authFile';
import type { ClaudeExtraUsage, ClaudeProfileResponse } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';
import {
  CLAUDE_PROFILE_URL,
  CLAUDE_REQUEST_HEADERS,
  CLAUDE_USAGE_URL,
  CLAUDE_USAGE_WINDOW_KEYS,
  formatQuotaResetTime,
  normalizeNumberValue,
  parseClaudeUsagePayload,
} from '@/utils/quota';
import {
  normalizeRecentRequestBuckets,
  normalizeUsageTotal,
  statusBarDataFromRecentRequests,
} from '@/utils/recentRequests';
import styles from './DashboardPage.module.scss';

type AccountState =
  | 'active'
  | 'cooling'
  | 'quotaCooling'
  | 'authExpired'
  | 'requestError'
  | 'disabled'
  | 'unavailable';

interface AccountEditForm {
  proxyUrl: string;
  prefix: string;
  priority: string;
  note: string;
  cloakMode: string;
  cloakStrictMode: boolean;
  cloakCacheUserId: boolean;
  cloakSensitiveWords: string;
}

type AccountQuotaStatus = 'idle' | 'loading' | 'success' | 'error';

interface AccountQuotaWindow {
  id: string;
  label: string;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetLabel: string;
}

interface AccountQuotaDetail {
  status: AccountQuotaStatus;
  windows: AccountQuotaWindow[];
  planLabel?: string;
  subscriptionStatus?: string;
  organizationName?: string;
  accountEmail?: string;
  extraUsage?: ClaudeExtraUsage | null;
  error?: string;
}

const CLOAK_MODE_OPTIONS = [
  { value: 'always', label: '始终伪装为 Claude Code' },
  { value: 'auto', label: '自动伪装：真实 Claude Code 不重写' },
  { value: 'never', label: '关闭伪装' },
];

function splitApiKeyDraft(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter((item) => {
      if (!item) return false;
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function makeClientApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `sk-claude-relay-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function isYamlMapLike(value: unknown): value is { set: (key: string, value: unknown) => void } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { set?: unknown }).set === 'function'
  );
}

function updateRemoteManagementSecret(yamlContent: string, secretKey: string): string {
  const document = parseDocument(yamlContent);
  if (document.errors.length > 0) {
    throw new Error(`配置 YAML 格式异常：${document.errors[0]?.message ?? '无法解析'}`);
  }

  let remoteManagement = document.get('remote-management', true);
  if (!isYamlMapLike(remoteManagement)) {
    document.set('remote-management', {});
    remoteManagement = document.get('remote-management', true);
  }
  if (!isYamlMapLike(remoteManagement)) {
    throw new Error('无法更新 remote-management 配置块');
  }

  remoteManagement.set('secret-key', secretKey);
  return document.toString({ indent: 2, lineWidth: 120, minContentWidth: 0 });
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return '';
}

function readBool(source: Record<string, unknown>, keys: string[], defaultValue = false): boolean {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string' && value.trim()) {
      const normalized = value.trim().toLowerCase();
      return normalized === 'true' || normalized === '1' || normalized === 'yes';
    }
  }
  return defaultValue;
}

function readNumber(source: Record<string, unknown>, keys: string[], defaultValue = 0): number {
  for (const key of keys) {
    const value = source[key];
    const parsed = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return defaultValue;
}

function parseDateMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber)) return asNumber < 1e12 ? asNumber * 1000 : asNumber;
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function formatDate(value: unknown): string {
  const ms = parseDateMs(value);
  if (!ms) return '未记录';
  return new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getAccountTitle(account: AuthFileItem): string {
  const record = account as Record<string, unknown>;
  return (
    readString(record, ['email', 'account', 'label']) ||
    readString(record, ['name']) ||
    'Claude 账号'
  );
}

function claudePermanentAccountError(record: Record<string, unknown>): { code: string; message: string } | null {
  const lastError = readRecord(record.last_error ?? record.lastError);
  const parts: string[] = [
    readString(record, ['status_message', 'statusMessage']),
    readString(lastError ?? {}, ['code']),
    readString(lastError ?? {}, ['message']),
  ].filter(Boolean);

  const rawMessage = readString(lastError ?? {}, ['message']);
  if (rawMessage.trim().startsWith('{')) {
    try {
      const payload = readRecord(JSON.parse(rawMessage));
      const error = readRecord(payload?.error);
      const details = readRecord(error?.details);
      parts.push(
        readString(error ?? {}, ['type']),
        readString(error ?? {}, ['message']),
        readString(details ?? {}, ['error_code', 'errorCode'])
      );
    } catch {
      /* keep raw message */
    }
  }

  const combined = parts.join(' ').toLowerCase();
  const upstreamMessage =
    parts.find((part) => part && !part.trim().startsWith('{') && !part.includes('_')) ||
    rawMessage ||
    '上游账号不可用';

  if (combined.includes('account_banned')) {
    return { code: 'account_banned', message: upstreamMessage };
  }
  if (
    combined.includes('organization_disabled') ||
    combined.includes('organization has been disabled') ||
    combined.includes('this organization has been disabled')
  ) {
    return { code: 'organization_disabled', message: upstreamMessage };
  }
  if (
    combined.includes('account_disabled') ||
    combined.includes('account has been disabled') ||
    combined.includes('user account is disabled')
  ) {
    return { code: 'account_disabled', message: upstreamMessage };
  }
  return null;
}

function accountQuotaInfo(record: Record<string, unknown>): {
  exceeded: boolean;
  reason: string;
  recoverAt: unknown;
} {
  const quota = readRecord(record.quota);
  const exceeded =
    readBool(record, ['quota_exceeded', 'quotaExceeded'], false) ||
    readBool(quota ?? {}, ['exceeded'], false);
  return {
    exceeded,
    reason:
      readString(record, ['quota_reason', 'quotaReason']) ||
      readString(quota ?? {}, ['reason']) ||
      '',
    recoverAt:
      record.quota_next_recover_at ??
      record.quotaNextRecoverAt ??
      quota?.next_recover_at ??
      quota?.nextRecoverAt,
  };
}

function accountErrorCombinedText(record: Record<string, unknown>): string {
  const error = readRecord(record.last_error ?? record.lastError);
  const parts: string[] = [
    readString(record, ['status_message', 'statusMessage']),
    readString(record, ['health_status', 'healthStatus']),
    readString(error ?? {}, ['http_status', 'httpStatus']),
    readString(error ?? {}, ['code']),
    readString(error ?? {}, ['message']),
  ].filter(Boolean);

  const message = readString(error ?? {}, ['message']);
  if (message.trim().startsWith('{')) {
    try {
      const payload = readRecord(JSON.parse(message));
      const nestedError = readRecord(payload?.error);
      const details = readRecord(nestedError?.details);
      parts.push(
        readString(nestedError ?? {}, ['type', 'code']),
        readString(nestedError ?? {}, ['message']),
        readString(details ?? {}, ['error_code', 'errorCode'])
      );
    } catch {
      /* keep raw message */
    }
  }
  return parts.join(' ').toLowerCase();
}

function isAccountQuotaCooling(record: Record<string, unknown>): boolean {
  const quota = accountQuotaInfo(record);
  if (!quota.exceeded) return false;
  const recoverAt = parseDateMs(quota.recoverAt);
  if (recoverAt > Date.now()) return true;
  const nextRetryAt = parseDateMs(record.next_retry_after ?? record.nextRetryAfter);
  return nextRetryAt > Date.now();
}

function isAccountAuthExpired(account: AuthFileItem): boolean {
  const record = account as Record<string, unknown>;
  const status = String(record.health_status ?? record.healthStatus ?? account.status ?? '')
    .trim()
    .toLowerCase();
  if (status.includes('expired')) return true;
  const combined = accountErrorCombinedText(record);
  return (
    combined.includes('401') ||
    combined.includes('unauthorized') ||
    combined.includes('invalid authentication credentials') ||
    combined.includes('invalid_grant')
  );
}

function isAccountRequestBodyError(record: Record<string, unknown>): boolean {
  const combined = accountErrorCombinedText(record);
  return (
    combined.includes('invalid_request_error') ||
    combined.includes('invalid signature') ||
    combined.includes('could not process image') ||
    combined.includes('tool_choice') ||
    combined.includes('input_schema') ||
    combined.includes('schema') ||
    combined.includes('third-party apps now draw from your extra usage')
  );
}

function getAccountState(account: AuthFileItem): AccountState {
  const record = account as Record<string, unknown>;
  if (account.disabled) return 'disabled';
  if (claudePermanentAccountError(record)) return 'disabled';
  if (isAccountAuthExpired(account)) return 'authExpired';
  if (isAccountQuotaCooling(record)) return 'quotaCooling';
  const nextRetryAt = parseDateMs(record.next_retry_after ?? record.nextRetryAfter);
  if (nextRetryAt > Date.now()) return 'cooling';
  if (isAccountRequestBodyError(record)) return 'requestError';
  const status = String(account.status ?? '').trim().toLowerCase();
  const message = String(account.statusMessage ?? record.status_message ?? '').trim().toLowerCase();
  if (account.unavailable || status.includes('error') || status.includes('unavailable')) {
    return 'unavailable';
  }
  if (message.includes('429') || message.includes('quota') || message.includes('rate')) {
    return 'cooling';
  }
  return 'active';
}

function accountStateLabel(state: AccountState): string {
  switch (state) {
    case 'active':
      return '可用';
    case 'cooling':
      return '重试冷却';
    case 'quotaCooling':
      return '限额冷却';
    case 'authExpired':
      return '认证过期';
    case 'requestError':
      return '请求异常';
    case 'disabled':
      return '已停用';
    case 'unavailable':
      return '不可用';
  }
}

function accountStateDetail(account: AuthFileItem): string {
  const record = account as Record<string, unknown>;
  const permanentError = claudePermanentAccountError(record);
  if (permanentError) {
    return `上游已禁用：${permanentError.message}`;
  }
  if (isAccountAuthExpired(account)) {
    return 'OAuth 授权过期或凭证无效';
  }
  if (isAccountQuotaCooling(record)) {
    const quota = accountQuotaInfo(record);
    const recoverAt = parseDateMs(quota.recoverAt)
      ? quota.recoverAt
      : record.next_retry_after ?? record.nextRetryAfter;
    return `限额恢复 ${formatDate(recoverAt)}`;
  }
  if (isAccountRequestBodyError(record)) {
    return '请求体或工具调用需要处理';
  }
  const retryAt = record.next_retry_after ?? record.nextRetryAfter;
  if (parseDateMs(retryAt) > Date.now()) {
    return `下次重试 ${formatDate(retryAt)}`;
  }
  return (
    readString(record, ['status_message', 'statusMessage']) ||
    readString(record, ['status']) ||
    '最近没有异常'
  );
}

function getSensitiveWords(account: AuthFileItem): string[] {
  const record = account as Record<string, unknown>;
  const raw = record.cloak_sensitive_words ?? record.cloakSensitiveWords;
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item ?? '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function makeEditForm(account: AuthFileItem): AccountEditForm {
  const record = account as Record<string, unknown>;
  return {
    proxyUrl: readString(record, ['proxy_url', 'proxyUrl']),
    prefix: readString(record, ['prefix']),
    priority: readString(record, ['priority']),
    note: readString(record, ['note']),
    cloakMode: readString(record, ['cloak_mode', 'cloakMode']) || 'always',
    cloakStrictMode: readBool(record, ['cloak_strict_mode', 'cloakStrictMode'], false),
    cloakCacheUserId: readBool(record, ['cloak_cache_user_id', 'cloakCacheUserId'], true),
    cloakSensitiveWords: getSensitiveWords(account).join('\n'),
  };
}

function splitSensitiveWords(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter((item) => {
      if (!item) return false;
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeFlagValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return undefined;
}

function parseClaudeProfilePayload(payload: unknown): ClaudeProfileResponse | null {
  if (payload == null) return null;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as ClaudeProfileResponse;
    } catch {
      return null;
    }
  }
  if (typeof payload === 'object') return payload as ClaudeProfileResponse;
  return null;
}

function claudeApiErrorRecord(result: ApiCallResult): Record<string, unknown> | null {
  const body = result.body;
  if (typeof body === 'string') {
    try {
      return readRecord(JSON.parse(body));
    } catch {
      return null;
    }
  }
  return readRecord(body);
}

function claudeApiErrorInfo(result: ApiCallResult): { code: string; message: string } {
  const root = claudeApiErrorRecord(result);
  const error = readRecord(root?.error);
  const details = readRecord(error?.details);
  const code =
    readString(details ?? {}, ['error_code', 'errorCode']) ||
    readString(error ?? {}, ['type', 'code']) ||
    (result.statusCode === 401
      ? 'unauthorized'
      : result.statusCode === 403
        ? 'forbidden'
        : result.statusCode === 429
          ? 'rate_limited'
          : 'upstream_error');
  const message = readString(error ?? {}, ['message']) || getApiCallErrorMessage(result);
  return { code, message };
}

function formatClaudeAccountFailure(result: ApiCallResult, source: string): string {
  const { code, message } = claudeApiErrorInfo(result);
  const status = result.statusCode;
  if (code === 'account_banned' || message.toLowerCase().includes('account_banned')) {
    return `Claude 账号已被上游标记为封禁/停用（account_banned，来自 ${source}）`;
  }
  if (status === 401) {
    return `Claude 认证已失效或被撤销（401，来自 ${source}）：${message}`;
  }
  if (status === 403) {
    return `Claude 账号无权访问该接口（403，来自 ${source}）：${message}`;
  }
  if (status === 429) {
    return `Claude 额度接口被限流（429，来自 ${source}）：${message}`;
  }
  return getApiCallErrorMessage(result);
}

function isClaudeAccountBlockingStatus(statusCode: number): boolean {
  return statusCode === 401 || statusCode === 403 || statusCode === 429;
}

function resolveClaudePlanLabel(profile: ClaudeProfileResponse | null): string {
  if (!profile) return '未知套餐';
  if (normalizeFlagValue(profile.account?.has_claude_max)) return 'Claude Max';
  if (normalizeFlagValue(profile.account?.has_claude_pro)) return 'Claude Pro';
  const organizationType = String(profile.organization?.organization_type ?? '').toLowerCase();
  const subscriptionStatus = String(profile.organization?.subscription_status ?? '').toLowerCase();
  if (organizationType === 'claude_team' && subscriptionStatus === 'active') return 'Claude Team';
  if (
    normalizeFlagValue(profile.account?.has_claude_max) === false &&
    normalizeFlagValue(profile.account?.has_claude_pro) === false
  ) {
    return 'Free';
  }
  return '未知套餐';
}

function claudeWindowLabel(labelKey: string, fallback: string): string {
  const labels: Record<string, string> = {
    'claude_quota.five_hour': '5 小时窗口',
    'claude_quota.seven_day': '7 天总额度',
    'claude_quota.seven_day_oauth_apps': '7 天 OAuth Apps',
    'claude_quota.seven_day_opus': '7 天 Opus',
    'claude_quota.seven_day_sonnet': '7 天 Sonnet',
    'claude_quota.seven_day_cowork': '7 天协作',
    'claude_quota.iguana_necktie': '扩展窗口',
  };
  return labels[labelKey] ?? fallback;
}

async function fetchClaudeAccountQuota(account: AuthFileItem): Promise<AccountQuotaDetail> {
  const record = account as Record<string, unknown>;
  const authIndex = normalizeAuthIndex(record['auth_index'] ?? account.authIndex);
  if (!authIndex) {
    throw new Error('该账号缺少 auth_index，无法查询额度');
  }

  const [usageResult, profileResult] = await Promise.allSettled([
    apiCallApi.request({
      authIndex,
      method: 'GET',
      url: CLAUDE_USAGE_URL,
      header: { ...CLAUDE_REQUEST_HEADERS },
    }),
    apiCallApi.request({
      authIndex,
      method: 'GET',
      url: CLAUDE_PROFILE_URL,
      header: { ...CLAUDE_REQUEST_HEADERS },
    }),
  ]);

  if (usageResult.status === 'rejected') {
    throw usageResult.reason instanceof Error ? usageResult.reason : new Error('额度查询失败');
  }
  if (
    profileResult.status === 'fulfilled' &&
    isClaudeAccountBlockingStatus(profileResult.value.statusCode)
  ) {
    throw new Error(formatClaudeAccountFailure(profileResult.value, 'profile'));
  }
  if (usageResult.value.statusCode < 200 || usageResult.value.statusCode >= 300) {
    throw new Error(formatClaudeAccountFailure(usageResult.value, 'usage'));
  }

  const payload = parseClaudeUsagePayload(usageResult.value.body ?? usageResult.value.bodyText);
  if (!payload) {
    throw new Error('Claude 额度响应为空或格式异常');
  }

  const windows = CLAUDE_USAGE_WINDOW_KEYS.flatMap(({ key, id, labelKey }) => {
    const window = payload[key as keyof typeof payload];
    if (!window || typeof window !== 'object' || !('utilization' in window)) return [];
    const typedWindow = window as { utilization: unknown; resets_at?: string };
    const usedPercent = normalizeNumberValue(typedWindow.utilization);
    const remainingPercent = usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent));
    return [{
      id,
      label: claudeWindowLabel(labelKey, id),
      usedPercent,
      remainingPercent,
      resetLabel: formatQuotaResetTime(typedWindow.resets_at),
    }];
  });

  const profile =
    profileResult.status === 'fulfilled' &&
    profileResult.value.statusCode >= 200 &&
    profileResult.value.statusCode < 300
      ? parseClaudeProfilePayload(profileResult.value.body ?? profileResult.value.bodyText)
      : null;

  return {
    status: 'success',
    windows,
    planLabel: resolveClaudePlanLabel(profile),
    subscriptionStatus: profile?.organization?.subscription_status,
    organizationName: profile?.organization?.name,
    accountEmail: profile?.account?.email,
    extraUsage: payload.extra_usage ?? null,
  };
}

function configText(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  return fallback;
}

function healthStatusLabel(value: unknown): string {
  const status = String(value ?? '').trim().toLowerCase();
  switch (status) {
    case 'healthy':
      return '健康';
    case 'expiring_soon':
      return '即将过期';
    case 'expired':
      return '认证过期';
    case 'quota_cooling':
      return '限额冷却';
    case 'auth_expired':
      return '认证过期';
    case 'request_error':
      return '请求异常';
    case 'unavailable':
      return '不可用';
    case 'disabled':
      return '已停用';
    case 'error':
      return '异常';
    case 'refreshing':
      return '刷新中';
    case 'pending':
      return '等待中';
    default:
      return status || '未知';
  }
}

function quotaRuntimeText(record: Record<string, unknown>): string {
  const quota = accountQuotaInfo(record);
  if (quota.exceeded) {
    const reason = quota.reason || '额度/频率受限';
    const recoverAt = parseDateMs(quota.recoverAt);
    if (recoverAt > Date.now()) {
      return `${reason}，恢复 ${formatDate(quota.recoverAt)}`;
    }
    if (recoverAt > 0) {
      return `${reason}，已到恢复时间`;
    }
    return reason;
  }
  return '未触发限额';
}

function quotaDetailCoolingWindow(detail?: AccountQuotaDetail): AccountQuotaWindow | null {
  if (!detail || detail.status !== 'success') return null;
  return (
    detail.windows.find(
      (window) => window.remainingPercent !== null && window.remainingPercent <= 0
    ) ?? null
  );
}

function lastErrorText(record: Record<string, unknown>): string {
  const permanentError = claudePermanentAccountError(record);
  if (permanentError) {
    return `${permanentError.code} / ${permanentError.message}`;
  }
  const error = readRecord(record.last_error ?? record.lastError);
  if (!error) return '无';
  const status = readString(error, ['http_status', 'httpStatus']);
  const code = readString(error, ['code']);
  const message = readString(error, ['message']);
  const body = [status, code, message].filter(Boolean).join(' / ') || '有错误记录';
  if (isAccountQuotaCooling(record) || code === 'quota_exhausted' || code === 'rate_limited') {
    return `限额冷却 / ${body}`;
  }
  if (isAccountRequestBodyError(record)) {
    return `请求体错误 / ${body}`;
  }
  const combined = accountErrorCombinedText(record);
  if (combined.includes('401') || combined.includes('unauthorized')) {
    return `认证错误 / ${body}`;
  }
  return body;
}

function formatQuotaPercent(value: number | null): string {
  return value === null ? '--' : `${Math.round(value)}%`;
}

function StatCard({
  icon,
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  icon: ReactNode;
  label: string;
  value: string | number;
  detail: string;
  tone?: 'neutral' | 'good' | 'warn' | 'danger';
}) {
  return (
    <div className={`${styles.statCard} ${styles[`tone${tone}`]}`}>
      <div className={styles.statIcon}>{icon}</div>
      <div>
        <div className={styles.statValue}>{value}</div>
        <div className={styles.statLabel}>{label}</div>
        <div className={styles.statDetail}>{detail}</div>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const config = useConfigStore((state) => state.config);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const { showNotification } = useNotificationStore();

  const [accounts, setAccounts] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [sessionKey, setSessionKey] = useState('');
  const [importProxyUrl, setImportProxyUrl] = useState('');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [adminPasswordDraft, setAdminPasswordDraft] = useState('');
  const [savingAccessSettings, setSavingAccessSettings] = useState(false);
  const [editingAccount, setEditingAccount] = useState<AuthFileItem | null>(null);
  const [editForm, setEditForm] = useState<AccountEditForm | null>(null);
  const [savingAccount, setSavingAccount] = useState(false);
  const [togglingName, setTogglingName] = useState('');
  const [deletingName, setDeletingName] = useState('');
  const [reauthenticatingName, setReauthenticatingName] = useState('');
  const [quotaByAccount, setQuotaByAccount] = useState<Record<string, AccountQuotaDetail>>({});

  const loadAccessSettings = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      setApiKeyDraft('');
      return;
    }
    try {
      const keys = await apiKeysApi.list();
      setApiKeyDraft(keys.join('\n'));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '客户端 API Key 加载失败';
      showNotification(message, 'error');
    }
  }, [connectionStatus, showNotification]);

  const loadAccounts = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      setAccounts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [authFiles] = await Promise.all([
        authFilesApi
          .listClaudeHealth()
          .then((files) => ({ files }))
          .catch(() => authFilesApi.list()),
        fetchConfig(undefined, true).catch(() => null),
      ]);
      setAccounts(
        authFiles.files.filter((file) => {
          const provider = String(file.provider ?? file.type ?? '').trim().toLowerCase();
          return provider === 'claude';
        })
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '账号列表加载失败';
      showNotification(message, 'error');
    } finally {
      setLoading(false);
    }
  }, [connectionStatus, fetchConfig, showNotification]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    loadAccessSettings();
  }, [loadAccessSettings]);

  const stats = useMemo(() => {
    const states = accounts.map((account) => {
      const name = String(account.name ?? '').trim();
      return quotaDetailCoolingWindow(name ? quotaByAccount[name] : undefined)
        ? 'quotaCooling'
        : getAccountState(account);
    });
    const success = accounts.reduce((sum, account) => sum + normalizeUsageTotal(account.success), 0);
    const failed = accounts.reduce((sum, account) => sum + normalizeUsageTotal(account.failed), 0);
    const total = success + failed;
    const proxyCount = accounts.filter((account) =>
      readString(account as Record<string, unknown>, ['proxy_url', 'proxyUrl'])
    ).length;

    return {
      total: accounts.length,
      active: states.filter((state) => state === 'active').length,
      cooling: states.filter((state) => state === 'cooling' || state === 'quotaCooling').length,
      unavailable: states.filter(
        (state) => state === 'unavailable' || state === 'authExpired' || state === 'requestError'
      ).length,
      disabled: states.filter((state) => state === 'disabled').length,
      proxyCount,
      successRate: total > 0 ? Math.round((success / total) * 100) : 100,
    };
  }, [accounts, quotaByAccount]);

  const strategySummary = useMemo(() => {
    const raw = config?.raw ?? {};
    const routing = readRecord(raw.routing) ?? {};
    const claudeHeaders = readRecord(raw['claude-header-defaults']) ?? {};

    return [
      {
        label: '请求重试',
        value: configText(raw['request-retry'] ?? config?.requestRetry, '2 次'),
        detail: '上游临时失败时自动换账号重试',
      },
      {
        label: '跨账号重试',
        value: configText(raw['max-retry-credentials'], '不限'),
        detail: '同一次请求最多尝试的备用账号数',
      },
      {
        label: '冷却窗口',
        value: `${configText(raw['max-retry-interval'], '30')} 秒`,
        detail: '429 或上游不可用后的最小保护间隔',
      },
      {
        label: '切换策略',
        value:
          config?.routingStrategy === 'fill-first'
            ? '优先填满'
            : config?.routingStrategy === 'round-robin'
              ? '轮询'
              : configText(config?.routingStrategy, '轮询'),
        detail: '多账号之间如何分配请求',
      },
      {
        label: '会话粘滞',
        value: readBool(routing, ['session-affinity', 'sessionAffinity'], true) ? '开启' : '关闭',
        detail: '同一会话尽量落到同一账号，提高上下文稳定性',
      },
      {
        label: 'Claude Code 指纹',
        value: configText(claudeHeaders['user-agent'], 'claude-cli/2.1.148'),
        detail: readBool(claudeHeaders, ['stabilize-device-profile'], true)
          ? '设备画像稳定'
          : '跟随请求动态变化',
      },
    ];
  }, [config]);

  const handleCookieImport = async () => {
    if (!sessionKey.trim()) {
      showNotification('请先填写 Claude sessionKey', 'error');
      return;
    }
    setImporting(true);
    try {
      const result = await oauthApi.cookieAuthClaude({
        sessionKey: sessionKey.trim(),
        proxyUrl: importProxyUrl.trim() || undefined,
      });
      setSessionKey('');
      showNotification(`账号导入成功：${result.email || result.auth_file || 'Claude'}`, 'success');
      await loadAccounts();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Cookie 换授权失败';
      showNotification(message, 'error');
    } finally {
      setImporting(false);
    }
  };

  const handleGenerateApiKey = () => {
    const nextKey = makeClientApiKey();
    setApiKeyDraft((current) => {
      const trimmed = current.trim();
      return trimmed ? `${trimmed}\n${nextKey}` : nextKey;
    });
    showNotification('已生成新的客户端 API Key，保存后生效', 'success');
  };

  const handleSaveAccessSettings = async () => {
    const nextApiKeys = splitApiKeyDraft(apiKeyDraft);
    const nextAdminPassword = adminPasswordDraft.trim();

    if (nextApiKeys.length === 0) {
      showNotification('至少保留一个客户端 API Key，否则客户端无法调用 /v1 接口', 'error');
      return;
    }

    setSavingAccessSettings(true);
    try {
      await apiKeysApi.replace(nextApiKeys);
      setApiKeyDraft(nextApiKeys.join('\n'));

      if (nextAdminPassword) {
        const currentYaml = await configFileApi.fetchConfigYaml();
        await configFileApi.saveConfigYaml(
          updateRemoteManagementSecret(currentYaml, nextAdminPassword)
        );
        setAdminPasswordDraft('');
        showNotification('连接凭证已保存。管理员密码已变更，请用新密码重新登录管理面板。', 'success');
        return;
      }

      showNotification('客户端 API Key 已保存', 'success');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '连接凭证保存失败';
      showNotification(message, 'error');
    } finally {
      setSavingAccessSettings(false);
    }
  };

  const openEditor = (account: AuthFileItem) => {
    setEditingAccount(account);
    setEditForm(makeEditForm(account));
  };

  const closeEditor = () => {
    setEditingAccount(null);
    setEditForm(null);
  };

  const handleToggleAccount = async (account: AuthFileItem) => {
    const name = String(account.name ?? '').trim();
    if (!name) return;
    setTogglingName(name);
    try {
      await authFilesApi.setStatus(name, !account.disabled);
      showNotification(account.disabled ? '账号已启用' : '账号已停用', 'success');
      await loadAccounts();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '账号状态更新失败';
      showNotification(message, 'error');
    } finally {
      setTogglingName('');
    }
  };

  const handleDeleteAccount = async (account: AuthFileItem) => {
    const name = String(account.name ?? '').trim();
    if (!name) return;
    if (!window.confirm(`确定要删除 Claude 账号 ${getAccountTitle(account)} 吗？此操作会移除该账号授权文件。`)) {
      return;
    }
    setDeletingName(name);
    try {
      await authFilesApi.deleteFile(name);
      setQuotaByAccount((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      showNotification('Claude 账号已删除', 'success');
      await loadAccounts();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '账号删除失败';
      showNotification(message, 'error');
    } finally {
      setDeletingName('');
    }
  };

  const handleReauthenticateAccount = async (account: AuthFileItem) => {
    const name = String(account.name ?? '').trim();
    if (!name) return;
    const permanentError = claudePermanentAccountError(account as Record<string, unknown>);
    if (permanentError) {
      showNotification(`该账号已被上游禁用，不能通过重认证恢复：${permanentError.message}`, 'error');
      return;
    }
    setReauthenticatingName(name);
    try {
      await authFilesApi.reauthenticateClaude(name);
      setQuotaByAccount((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      showNotification('Claude 账号认证已刷新并恢复', 'success');
      await loadAccounts();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '账号重认证失败';
      showNotification(message, 'error');
    } finally {
      setReauthenticatingName('');
    }
  };

  const handleRefreshAccountQuota = async (account: AuthFileItem) => {
    const name = String(account.name ?? '').trim();
    if (!name) return;
    const permanentError = claudePermanentAccountError(account as Record<string, unknown>);
    if (permanentError) {
      showNotification(`该账号已被上游禁用，不能继续刷新额度：${permanentError.message}`, 'error');
      return;
    }
    setQuotaByAccount((prev) => ({
      ...prev,
      [name]: { status: 'loading', windows: [] },
    }));
    try {
      const detail = await fetchClaudeAccountQuota(account);
      setQuotaByAccount((prev) => ({
        ...prev,
        [name]: detail,
      }));
      showNotification('订阅与额度信息已刷新', 'success');
      void loadAccounts();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '订阅与额度查询失败';
      setQuotaByAccount((prev) => ({
        ...prev,
        [name]: { status: 'error', windows: [], error: message },
      }));
      showNotification(message, 'error');
      void loadAccounts();
    }
  };

  const handleSaveAccount = async () => {
    if (!editingAccount || !editForm) return;
    const name = String(editingAccount.name ?? '').trim();
    if (!name) return;
    const priority = editForm.priority.trim() ? Number(editForm.priority.trim()) : 0;
    if (!Number.isFinite(priority)) {
      showNotification('优先级必须是数字', 'error');
      return;
    }

    const patch: AuthFileFieldsPatch = {
      proxy_url: editForm.proxyUrl.trim(),
      prefix: editForm.prefix.trim(),
      priority,
      note: editForm.note.trim(),
      cloak_mode: editForm.cloakMode,
      cloak_strict_mode: editForm.cloakStrictMode,
      cloak_cache_user_id: editForm.cloakCacheUserId,
      cloak_sensitive_words: splitSensitiveWords(editForm.cloakSensitiveWords),
    };

    setSavingAccount(true);
    try {
      await authFilesApi.patchFields(name, patch);
      showNotification('账号策略已保存', 'success');
      closeEditor();
      await loadAccounts();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '账号策略保存失败';
      showNotification(message, 'error');
    } finally {
      setSavingAccount(false);
    }
  };

  return (
    <div className={styles.dashboard}>
      <section className={styles.hero}>
        <div>
          <div className={styles.kicker}>Claude Relay Console</div>
          <h1>Claude 账号池与反代控制台</h1>
          <p>
            集中管理 Claude OAuth 账号、Cookie 换授权、每账号代理、请求重试、账号切换与 Claude Code
            兼容策略。
          </p>
        </div>
        <div className={styles.heroActions}>
          <Button variant="secondary" onClick={loadAccounts} loading={loading}>
            <IconRefreshCw size={16} />
            刷新
          </Button>
          <Link to="/config" className="btn btn-primary">
            <IconSettings size={16} />
            策略设置
          </Link>
        </div>
      </section>

      <section className={styles.statsGrid}>
        <StatCard
          icon={<IconFileText size={22} />}
          label="Claude 账号"
          value={stats.total}
          detail={`${stats.active} 个可用，${stats.disabled} 个停用`}
          tone="neutral"
        />
        <StatCard
          icon={<IconCheck size={22} />}
          label="可用账号"
          value={stats.active}
          detail={stats.cooling ? `${stats.cooling} 个冷却中` : '当前池可接收请求'}
          tone="good"
        />
        <StatCard
          icon={<IconShield size={22} />}
          label="异常保护"
          value={stats.unavailable + stats.cooling}
          detail="429、认证失败或不可用会被隔离"
          tone={stats.unavailable + stats.cooling > 0 ? 'warn' : 'neutral'}
        />
        <StatCard
          icon={<IconBot size={22} />}
          label="代理覆盖"
          value={`${stats.proxyCount}/${stats.total}`}
          detail={`最近成功率 ${stats.successRate}%`}
          tone={stats.proxyCount === stats.total && stats.total > 0 ? 'good' : 'neutral'}
        />
      </section>

      <section className={styles.accessPanel}>
        <div className={styles.panelHeader}>
          <div>
            <h2>连接凭证</h2>
            <p>客户端 API Key 用于模型接口；管理员登录密码只用于进入管理面板。</p>
          </div>
          <span className={styles.connectionBadge}>
            {apiBase || (typeof window !== 'undefined' ? window.location.origin : '')}
          </span>
        </div>
        <div className={styles.accessGrid}>
          <label className={styles.textareaField}>
            <span>客户端 API Key</span>
            <textarea
              value={apiKeyDraft}
              onChange={(event) => setApiKeyDraft(event.target.value)}
              placeholder="每行一个客户端 API Key"
              spellCheck={false}
            />
          </label>
          <div className={styles.accessForm}>
            <Input
              label="管理员登录密码"
              type="password"
              value={adminPasswordDraft}
              onChange={(event) => setAdminPasswordDraft(event.target.value)}
              placeholder="留空则不修改"
              hint="保存后用于 management.html 登录；它不是客户端调用 /v1 的 API Key。"
            />
            <div className={styles.accessActions}>
              <Button variant="secondary" onClick={handleGenerateApiKey}>
                <IconShield size={16} />
                生成 API Key
              </Button>
              <Button onClick={handleSaveAccessSettings} loading={savingAccessSettings}>
                保存连接凭证
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.workspace}>
        <div className={styles.importPanel}>
          <div className={styles.panelHeader}>
            <div>
              <h2>导入 Claude 账号</h2>
              <p>支持 OAuth 授权，也支持使用 claude.ai 的 sessionKey 换取 Claude Code OAuth 授权。</p>
            </div>
            <Link to="/oauth" className={styles.textLink}>
              OAuth 导入页
              <IconExternalLink size={14} />
            </Link>
          </div>
          <Input
            label="Claude sessionKey"
            type="password"
            value={sessionKey}
            onChange={(event) => setSessionKey(event.target.value)}
            placeholder="粘贴 claude.ai Cookie 中的 sessionKey"
          />
          <Input
            label="该账号专属代理"
            value={importProxyUrl}
            onChange={(event) => setImportProxyUrl(event.target.value)}
            placeholder="socks5://user:pass@host:port 或 direct，可留空"
            hint="支持 http://、https://、socks5://、socks5h://；留空使用全局代理，direct/none 强制该账号直连。"
          />
          <Button onClick={handleCookieImport} loading={importing} fullWidth>
            Cookie 换授权并加入账号池
          </Button>
        </div>

        <div className={styles.strategyPanel}>
          <div className={styles.panelHeader}>
            <div>
              <h2>伪装与切换策略</h2>
              <p>默认策略已按 Claude Code 兼容、稳定会话与高缓存命中率配置。</p>
            </div>
          </div>
          <div className={styles.strategyGrid}>
            {strategySummary.map((item) => (
              <div key={item.label} className={styles.strategyItem}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <small>{item.detail}</small>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.accountSection}>
        <div className={styles.sectionHeader}>
          <div>
            <h2>账号池</h2>
            <p>每个账号都可以独立配置代理 IP、优先级、路径前缀和 Claude Code 伪装方式。</p>
          </div>
          <span className={styles.connectionBadge}>
            {connectionStatus === 'connected' ? apiBase || '已连接' : '未连接'}
          </span>
        </div>

        {loading ? (
          <div className={styles.emptyState}>正在加载 Claude 账号池...</div>
        ) : accounts.length === 0 ? (
          <div className={styles.emptyState}>还没有 Claude 账号。先用 OAuth 或 Cookie 换授权导入一个账号。</div>
        ) : (
          <div className={styles.accountGrid}>
            {accounts.map((account) => {
              const record = account as Record<string, unknown>;
              const name = String(account.name ?? '').trim();
              const quotaDetail = name ? quotaByAccount[name] : undefined;
              const quotaCoolingWindow = quotaDetailCoolingWindow(quotaDetail);
              const state = quotaCoolingWindow ? 'quotaCooling' : getAccountState(account);
              const recent = normalizeRecentRequestBuckets(
                account.recent_requests ?? account.recentRequests
              );
              const bar = statusBarDataFromRecentRequests(recent);
              const proxyUrl = readString(record, ['proxy_url', 'proxyUrl']);
              const prefix = readString(record, ['prefix']) || '默认';
              const priority = readNumber(record, ['priority'], 0);
              const cloakMode = readString(record, ['cloak_mode', 'cloakMode']) || 'always';
              const cacheUserId = readBool(record, ['cloak_cache_user_id', 'cloakCacheUserId'], true);
              const permanentError = claudePermanentAccountError(record);
              const stateDetail = quotaCoolingWindow
                ? `${quotaCoolingWindow.label} 额度已用完，恢复 ${quotaCoolingWindow.resetLabel}`
                : accountStateDetail(account);
              const runtimeQuotaText = quotaCoolingWindow
                ? `${quotaCoolingWindow.label} 额度已用完，恢复 ${quotaCoolingWindow.resetLabel}`
                : quotaRuntimeText(record);
              const healthLabel = permanentError
                ? '上游已禁用'
                : state === 'active'
                  ? healthStatusLabel(record.health_status ?? record.healthStatus)
                  : accountStateLabel(state);

              return (
                <article key={name || getAccountTitle(account)} className={styles.accountCard}>
                  <div className={styles.accountTop}>
                    <div>
                      <h3>{getAccountTitle(account)}</h3>
                      <span className={styles.fileName}>{name}</span>
                    </div>
                    <span className={`${styles.statusPill} ${styles[state]}`}>
                      {accountStateLabel(state)}
                    </span>
                  </div>
                  <div className={styles.accountMeta}>
                    <span>{stateDetail}</span>
                    <span>刷新 {formatDate(record.last_refresh ?? record.lastRefresh)}</span>
                  </div>
                  <div className={styles.healthBar} aria-label="最近请求状态">
                    {bar.blocks.map((block, index) => (
                      <span key={`${name}-block-${index}`} className={styles[`block${block}`]} />
                    ))}
                  </div>
                  <div className={styles.accountMetrics}>
                    <span>成功 {normalizeUsageTotal(account.success)}</span>
                    <span>失败 {normalizeUsageTotal(account.failed)}</span>
                    <span>{Math.round(bar.successRate)}%</span>
                  </div>
                  <dl className={styles.accountConfig}>
                    <div>
                      <dt>代理</dt>
                      <dd>{proxyUrl || '未配置'}</dd>
                    </div>
                    <div>
                      <dt>前缀</dt>
                      <dd>{prefix}</dd>
                    </div>
                    <div>
                      <dt>优先级</dt>
                      <dd>{priority}</dd>
                    </div>
                    <div>
                      <dt>伪装</dt>
                      <dd>
                        {cloakMode}
                        {cacheUserId ? ' / 稳定 user_id' : ' / 每次生成 user_id'}
                      </dd>
                    </div>
                    <div>
                      <dt>健康</dt>
                      <dd>{healthLabel}</dd>
                    </div>
                    <div>
                      <dt>有效期</dt>
                      <dd>{formatDate(record.expires_at ?? record.expiresAt)}</dd>
                    </div>
                    <div>
                      <dt>运行限额</dt>
                      <dd>{runtimeQuotaText}</dd>
                    </div>
                    <div>
                      <dt>最近错误</dt>
                      <dd>{lastErrorText(record)}</dd>
                    </div>
                  </dl>
                  <div className={styles.quotaPanel}>
                    <div className={styles.quotaPanelHeader}>
                      <div>
                        <strong>订阅与额度</strong>
                        <span>
                          {permanentError
                            ? '账号已被上游禁用，额度信息仅供历史参考'
                            : quotaDetail?.status === 'success'
                            ? `${quotaDetail.planLabel || '未知套餐'}${quotaDetail.subscriptionStatus ? ` / ${quotaDetail.subscriptionStatus}` : ''}`
                            : '按需查询 Claude 上游用量'}
                        </span>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={quotaDetail?.status === 'loading'}
                        disabled={Boolean(permanentError)}
                        onClick={() => handleRefreshAccountQuota(account)}
                      >
                        刷新额度
                      </Button>
                    </div>
                    {permanentError ? (
                      <div className={styles.quotaError}>
                        {permanentError.message}。该账号已从生产轮询中隔离，已有额度信息只表示 OAuth
                        资料接口曾经可读。
                      </div>
                    ) : null}
                    {quotaDetail?.status === 'success' ? (
                      <div className={styles.quotaContent}>
                        <div className={styles.quotaSummary}>
                          <span>{quotaDetail.accountEmail || getAccountTitle(account)}</span>
                          <span>{quotaDetail.organizationName || '个人/默认组织'}</span>
                        </div>
                        {quotaDetail.extraUsage?.is_enabled && (
                          <div className={styles.quotaSummary}>
                            <span>额外用量</span>
                            <span>
                              ${(quotaDetail.extraUsage.used_credits / 100).toFixed(2)} / $
                              {(quotaDetail.extraUsage.monthly_limit / 100).toFixed(2)}
                            </span>
                          </div>
                        )}
                        {quotaDetail.windows.length > 0 ? (
                          quotaDetail.windows.map((window) => (
                            <div key={window.id} className={styles.quotaWindow}>
                              <div className={styles.quotaWindowHeader}>
                                <span>{window.label}</span>
                                <strong>{formatQuotaPercent(window.remainingPercent)} 剩余</strong>
                              </div>
                              <div className={styles.quotaTrack}>
                                <span style={{ width: `${Math.max(0, Math.min(100, window.remainingPercent ?? 0))}%` }} />
                              </div>
                              <small>重置 {window.resetLabel}</small>
                            </div>
                          ))
                        ) : (
                          <div className={styles.quotaEmpty}>上游没有返回可展示的额度窗口</div>
                        )}
                      </div>
                    ) : quotaDetail?.status === 'error' && !permanentError ? (
                      <div className={styles.quotaError}>{quotaDetail.error || '额度查询失败'}</div>
                    ) : permanentError ? null : (
                      <div className={styles.quotaEmpty}>点击刷新额度后显示订阅、剩余额度和重置时间。</div>
                    )}
                  </div>
                  <div className={styles.accountActions}>
                    <Button
                      variant="danger"
                      size="sm"
                      loading={deletingName === name}
                      onClick={() => handleDeleteAccount(account)}
                    >
                      <IconTrash2 size={15} />
                      删除
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => openEditor(account)}>
                      <IconSettings size={15} />
                      设置
                    </Button>
                    {!permanentError && (
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={reauthenticatingName === name}
                        onClick={() => handleReauthenticateAccount(account)}
                      >
                        <IconRefreshCw size={15} />
                        重认证
                      </Button>
                    )}
                    <Button
                      variant={account.disabled ? 'primary' : 'ghost'}
                      size="sm"
                      loading={togglingName === name}
                      onClick={() => handleToggleAccount(account)}
                    >
                      {account.disabled ? '启用' : '停用'}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {editingAccount && editForm && (
        <div className={styles.modalBackdrop} role="presentation">
          <div className={styles.modal} role="dialog" aria-modal="true" aria-label="账号策略设置">
            <div className={styles.modalHeader}>
              <div>
                <h2>{getAccountTitle(editingAccount)}</h2>
                <p>配置该账号的路由、代理与 Claude Code 兼容策略。</p>
              </div>
              <button type="button" className={styles.iconButton} onClick={closeEditor} aria-label="关闭">
                ×
              </button>
            </div>

            <div className={styles.formGrid}>
              <Input
                label="专属代理"
                value={editForm.proxyUrl}
                onChange={(event) => setEditForm({ ...editForm, proxyUrl: event.target.value })}
                placeholder="socks5://user:pass@host:port 或 direct"
                hint="支持 http://、https://、socks5://、socks5h://；留空使用全局代理，direct/none 强制该账号直连。"
              />
              <Input
                label="路径前缀"
                value={editForm.prefix}
                onChange={(event) => setEditForm({ ...editForm, prefix: event.target.value })}
                placeholder="例如 claude01，可留空"
              />
              <Input
                label="优先级"
                type="number"
                value={editForm.priority}
                onChange={(event) => setEditForm({ ...editForm, priority: event.target.value })}
                placeholder="0"
              />
              <div className={styles.selectField}>
                <label>伪装模式</label>
                <Select
                  value={editForm.cloakMode}
                  options={CLOAK_MODE_OPTIONS}
                  onChange={(cloakMode) => setEditForm({ ...editForm, cloakMode })}
                />
              </div>
            </div>

            <div className={styles.toggleGrid}>
              <ToggleSwitch
                checked={editForm.cloakCacheUserId}
                onChange={(cloakCacheUserId) => setEditForm({ ...editForm, cloakCacheUserId })}
                label="稳定 Claude Code user_id"
              />
              <ToggleSwitch
                checked={editForm.cloakStrictMode}
                onChange={(cloakStrictMode) => setEditForm({ ...editForm, cloakStrictMode })}
                label="严格处理敏感词"
              />
            </div>

            <label className={styles.textareaField}>
              <span>敏感词替换</span>
              <textarea
                value={editForm.cloakSensitiveWords}
                onChange={(event) =>
                  setEditForm({ ...editForm, cloakSensitiveWords: event.target.value })
                }
                placeholder="每行一个词，或用逗号分隔"
              />
            </label>
            <label className={styles.textareaField}>
              <span>账号备注</span>
              <textarea
                value={editForm.note}
                onChange={(event) => setEditForm({ ...editForm, note: event.target.value })}
                placeholder="例如地区、套餐、代理来源"
              />
            </label>

            <div className={styles.modalActions}>
              <Button variant="ghost" onClick={closeEditor}>
                取消
              </Button>
              <Button onClick={handleSaveAccount} loading={savingAccount}>
                保存账号策略
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
