import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { parseDocument } from 'yaml';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ProxyPicker } from '@/components/proxy/ProxyPicker';
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
  claudeMimicryApi,
  claudeSessionImportApi,
  configFileApi,
  getApiCallErrorMessage,
  proxyPoolApi,
  type ApiCallResult,
  type ClaudeMimicryAuditResponse,
  type ClaudeMimicryEventsResponse,
  type ClaudeMimicryEvent,
  type ClaudeMimicryStatus,
  type ClaudeSessionImportJob,
  type ProxyPoolEntry,
} from '@/services/api';
import { authFilesApi, type AuthFileFieldsPatch, type ClaudeProbeJob } from '@/services/api/authFiles';
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
import { sanitizeSensitiveText } from '@/utils/displaySanitizer';
import styles from './DashboardPage.module.scss';

type AccountState =
  | 'active'
  | 'cooling'
  | 'quotaCooling'
  | 'rpmCooling'
  | 'sessionFull'
  | 'authExpired'
  | 'subscriptionIssue'
  | 'requestError'
  | 'disabled'
  | 'unavailable';

type AccountStateFilter = AccountState | 'all' | 'banned';
type AccountProxyFilter = 'all' | 'withProxy' | 'defaultProxy' | 'direct';
type AccountAuthFilter = 'all' | 'claude_code_cli' | 'claude_platform' | 'claude_setup_token' | 'unknown';
type AccountViewMode = 'table' | 'cards';
type AccountImportSource = 'manual' | 'bulk_session_import';

interface AccountSection {
  key: AccountImportSource;
  title: string;
  detail: string;
  emptyText: string;
  accounts: AuthFileItem[];
}

const ACCOUNT_VIEW_MODE_STORAGE_KEY = 'claude-account-view-mode-v2';

interface AccountEditForm {
  proxyUrl: string;
  prefix: string;
  priority: string;
  rpmLimit: string;
  maxSessions: string;
  note: string;
  cloakMode: string;
  cloakStrictMode: boolean;
  cloakCacheUserId: boolean;
  cloakSensitiveWords: string;
}

interface BatchEditForm {
  applyProxy: boolean;
  proxyUrl: string;
  applyPriority: boolean;
  priority: string;
  applyLimits: boolean;
  rpmLimit: string;
  maxSessions: string;
  applyCloakMode: boolean;
  cloakMode: string;
  applyCacheUserId: boolean;
  cloakCacheUserId: boolean;
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
  note?: string;
  error?: string;
}

type AccountPlanTone = 'max' | 'pro' | 'team' | 'free' | 'unknown';

interface AccountPlanBadge {
  label: string;
  tone: AccountPlanTone;
  detail?: string;
}

const CLOAK_MODE_OPTIONS = [
  { value: 'always', label: '始终使用 CLI 形态' },
  { value: 'auto', label: '自动伪装：真实 CLI 不重写' },
  { value: 'never', label: '关闭伪装' },
];

const ACCOUNT_STATE_FILTER_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'banned', label: '封禁/组织禁用' },
  { value: 'authExpired', label: '认证过期' },
  { value: 'quotaCooling', label: '限额冷却' },
  { value: 'rpmCooling', label: 'RPM 冷却' },
  { value: 'sessionFull', label: '新会话已满' },
  { value: 'requestError', label: '请求异常' },
  { value: 'subscriptionIssue', label: '订阅异常' },
  { value: 'unavailable', label: '不可用' },
  { value: 'disabled', label: '已停用' },
  { value: 'active', label: '可用' },
];

const ACCOUNT_PROXY_FILTER_OPTIONS = [
  { value: 'all', label: '全部代理' },
  { value: 'withProxy', label: '已配置代理' },
  { value: 'defaultProxy', label: '未配置代理' },
  { value: 'direct', label: '直连账号' },
];

const ACCOUNT_AUTH_FILTER_OPTIONS = [
  { value: 'all', label: '全部认证' },
  { value: 'claude_code_cli', label: 'CLI OAuth' },
  { value: 'claude_platform', label: 'Platform OAuth' },
  { value: 'claude_setup_token', label: 'Setup Token' },
  { value: 'unknown', label: '未知认证' },
];

const parsePositiveInteger = (value: string, fallback: number): number => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const sessionImportStatusLabel = (status?: string): string => {
  switch (status) {
    case 'running':
      return '运行中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'canceled':
      return '已取消';
    default:
      return '未开始';
  }
};

const DEFAULT_BATCH_FORM: BatchEditForm = {
  applyProxy: false,
  proxyUrl: '',
  applyPriority: false,
  priority: '0',
  applyLimits: true,
  rpmLimit: '60',
  maxSessions: '5',
  applyCloakMode: true,
  cloakMode: 'always',
  applyCacheUserId: true,
  cloakCacheUserId: true,
};

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

function splitSessionKeyDraft(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/\r?\n/)
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

function readOptionalNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null || value === '') continue;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readStatusReason(record: Record<string, unknown>): string {
  return readString(record, ['status_reason', 'statusReason']).toLowerCase();
}

function readRuntimeStats(record: Record<string, unknown>) {
  return {
    rpmLimit: readNumber(record, ['rpm_limit', 'rpmLimit'], 60),
    currentRpm: readNumber(record, ['current_rpm', 'currentRpm'], 0),
    rpmResetAt: record.rpm_reset_at ?? record.rpmResetAt,
    maxSessions: readNumber(record, ['max_sessions', 'maxSessions'], 5),
    activeSessions: readNumber(record, ['active_sessions', 'activeSessions'], 0),
    sessionResetAt: record.session_reset_at ?? record.sessionResetAt,
    lastUsedAt: record.last_used_at ?? record.lastUsedAt,
  };
}

function readQuality24h(record: Record<string, unknown>) {
  const quality = readRecord(record.quality_24h ?? record.quality24h) ?? {};
  return {
    requests: readNumber(quality, ['requests'], 0),
    success: readNumber(quality, ['success'], 0),
    failed: readNumber(quality, ['failed'], 0),
    rateLimited: readNumber(quality, ['rate_limited', 'rateLimited'], 0),
    successRate: readNumber(quality, ['success_rate', 'successRate'], 100),
  };
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
  return sanitizeSensitiveText(
    readString(record, ['email', 'account', 'label']) ||
    readString(record, ['name']) ||
    '服务账号'
  );
}

function getAccountName(account: AuthFileItem): string {
  return String(account.name ?? '').trim();
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
  const safeMessage = sanitizeSensitiveText(upstreamMessage);

  if (combined.includes('account_banned')) {
    return { code: 'account_banned', message: safeMessage };
  }
  if (
    combined.includes('organization_disabled') ||
    combined.includes('organization has been disabled') ||
    combined.includes('this organization has been disabled')
  ) {
    return { code: 'organization_disabled', message: safeMessage };
  }
  if (
    combined.includes('account_disabled') ||
    combined.includes('account has been disabled') ||
    combined.includes('user account is disabled')
  ) {
    return { code: 'account_disabled', message: safeMessage };
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
  const statusReason = readStatusReason(record);
  if (
    statusReason === 'account_banned' ||
    statusReason === 'organization_disabled' ||
    statusReason === 'account_disabled'
  ) {
    return 'disabled';
  }
  if (statusReason === 'auth_expired') return 'authExpired';
  if (statusReason === 'quota_cooldown') return 'quotaCooling';
  if (statusReason === 'rpm_cooldown') return 'rpmCooling';
  if (statusReason === 'session_full') return 'sessionFull';
  if (statusReason === 'subscription_issue') return 'subscriptionIssue';
  if (statusReason === 'upstream_error') return 'requestError';
  if (statusReason === 'unavailable') return 'unavailable';
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

function isUpstreamDisabledAccount(record: Record<string, unknown>): boolean {
  const statusReason = readStatusReason(record);
  return (
    statusReason === 'account_banned' ||
    statusReason === 'organization_disabled' ||
    statusReason === 'account_disabled' ||
    claudePermanentAccountError(record) !== null
  );
}

function accountStateLabel(state: AccountState): string {
  switch (state) {
    case 'active':
      return '可用';
    case 'cooling':
      return '重试冷却';
    case 'quotaCooling':
      return '限额冷却';
    case 'rpmCooling':
      return 'RPM 冷却';
    case 'sessionFull':
      return '新会话已满';
    case 'authExpired':
      return '认证过期';
    case 'subscriptionIssue':
      return '订阅异常';
    case 'requestError':
      return '请求异常';
    case 'disabled':
      return '已停用';
    case 'unavailable':
      return '不可用';
  }
}

function accountMatchesStateFilter(
  account: AuthFileItem,
  state: AccountState,
  filter: AccountStateFilter
): boolean {
  if (filter === 'all') return true;
  const record = account as Record<string, unknown>;
  if (filter === 'banned') return isUpstreamDisabledAccount(record);
  return state === filter;
}

function accountAuthSource(record: Record<string, unknown>): string {
  const source = readString(record, ['auth_source', 'authSource']).toLowerCase();
  if (source) return source;
  const label = claudeAuthMethodText(record).toLowerCase();
  if (label.includes('cli')) return 'claude_code_cli';
  if (label.includes('platform')) return 'claude_platform';
  if (label.includes('setup token')) return 'claude_setup_token';
  return '';
}

function scopeIncludes(scope: string, value: string): boolean {
  return scope
    .toLowerCase()
    .split(/\s+/)
    .some((part) => part === value);
}

function isSetupTokenAccount(record: Record<string, unknown>): boolean {
  const metadata = readRecord(record.metadata);
  const source = accountAuthSource(record);
  const authKind =
    readString(record, ['auth_kind', 'authKind']).toLowerCase() ||
    readString(metadata ?? {}, ['auth_kind', 'authKind']).toLowerCase();
  if (source === 'claude_setup_token' || authKind === 'setup_token') return true;
  const scope =
    readString(record, ['scope']).toLowerCase() ||
    readString(metadata ?? {}, ['scope']).toLowerCase();
  return (
    scopeIncludes(scope, 'user:inference') &&
    !scopeIncludes(scope, 'user:profile') &&
    !scopeIncludes(scope, 'user:office')
  );
}

function setupTokenQuotaDetail(record: Record<string, unknown>): AccountQuotaDetail {
  const metadata = readRecord(record.metadata);
  const planLabel =
    readString(record, ['plan_type', 'planType']) ||
    readString(metadata ?? {}, ['plan_type', 'planType']) ||
    'Setup Token';
  const sessionStatus =
    readString(record, ['session_window_status', 'sessionWindowStatus']) ||
    readString(metadata ?? {}, ['session_window_status', 'sessionWindowStatus']);
  const fiveHourUtilization = setupTokenUtilizationPercent(
    readOptionalNumber(record, ['session_window_utilization', 'sessionWindowUtilization']) ??
      readOptionalNumber(metadata ?? {}, ['session_window_utilization', 'sessionWindowUtilization']),
    sessionStatus
  );
  const fiveHourResetMs =
    parseDateMs(record.session_window_end ?? record.sessionWindowEnd) ||
    parseDateMs(metadata?.session_window_end ?? metadata?.sessionWindowEnd);
  const sevenDayUtilization = setupTokenUtilizationPercent(
    readOptionalNumber(record, ['passive_usage_7d_utilization', 'passiveUsage7dUtilization']) ??
      readOptionalNumber(metadata ?? {}, ['passive_usage_7d_utilization', 'passiveUsage7dUtilization'])
  );
  const sevenDayResetMs =
    parseDateMs(record.passive_usage_7d_reset ?? record.passiveUsage7dReset) ||
    parseDateMs(metadata?.passive_usage_7d_reset ?? metadata?.passiveUsage7dReset);
  const windows: AccountQuotaWindow[] = [];
  if (fiveHourResetMs || fiveHourUtilization !== null || sessionStatus) {
    windows.push(setupTokenWindow('five-hour', '5 小时窗口', fiveHourUtilization, fiveHourResetMs));
  }
  if (sevenDayResetMs || sevenDayUtilization !== null) {
    windows.push(setupTokenWindow('seven-day', '7 天总额度（全模型合并）', sevenDayUtilization, sevenDayResetMs));
  }
  return {
    status: 'success',
    windows,
    planLabel,
    subscriptionStatus: windows.length > 0 ? '长期授权，被动额度采样' : '长期授权，等待额度采样',
    accountEmail:
      readString(record, ['email', 'account_email', 'accountEmail']) ||
      readString(metadata ?? {}, ['email']),
    note:
      windows.length > 0
        ? '额度来自上游响应头被动采样；7 天为全模型合并额度，被动头不区分 sonnet/opus，单模型额度仅在手动刷新额度时可见。'
        : 'Setup Token 长期授权有效；等待下一次请求后从上游响应头采样额度。',
  };
}

function setupTokenUtilizationPercent(value: number | null, status = ''): number | null {
  if (value !== null) {
    return clampPercent(value <= 1 ? value * 100 : value);
  }
  switch (status) {
    case 'rejected':
      return 100;
    case 'allowed_warning':
      return 80;
    case 'allowed':
      return 0;
    default:
      return null;
  }
}

function setupTokenWindow(
  id: string,
  label: string,
  usedPercent: number | null,
  resetMs: number
): AccountQuotaWindow {
  return {
    id,
    label,
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent)),
    resetLabel: resetMs ? formatQuotaResetTime(new Date(resetMs).toISOString()) : '-',
  };
}

function accountQuotaDetail(
  account: AuthFileItem,
  existing?: AccountQuotaDetail
): AccountQuotaDetail | undefined {
  const record = account as Record<string, unknown>;
  if (isSetupTokenAccount(record) && existing?.status !== 'loading') {
    return setupTokenQuotaDetail(record);
  }
  return existing;
}

function accountImportSource(record: Record<string, unknown>): AccountImportSource {
  const source = readString(record, ['import_source', 'importSource']).toLowerCase();
  if (source === 'bulk_session_import' || source === 'bulk' || source === 'batch') {
    return 'bulk_session_import';
  }
  return 'manual';
}

function accountMatchesAuthFilter(
  record: Record<string, unknown>,
  filter: AccountAuthFilter
): boolean {
  if (filter === 'all') return true;
  const source = accountAuthSource(record);
  if (filter === 'unknown') return source === '';
  return source === filter;
}

function accountMatchesProxyFilter(
  record: Record<string, unknown>,
  filter: AccountProxyFilter
): boolean {
  if (filter === 'all') return true;
  const proxyUrl = readString(record, ['proxy_url', 'proxyUrl']);
  const normalized = proxyUrl.toLowerCase();
  if (filter === 'withProxy') return proxyUrl !== '';
  if (filter === 'defaultProxy') return proxyUrl === '';
  return normalized === 'direct' || normalized === 'none';
}

function accountSearchText(account: AuthFileItem): string {
  const record = account as Record<string, unknown>;
  const runtime = readRuntimeStats(record);
  return [
    getAccountTitle(account),
    getAccountName(account),
    readString(record, ['email', 'account', 'label']),
    readString(record, ['proxy_url', 'proxyUrl']),
    readString(record, ['prefix']),
    readString(record, ['status_reason', 'statusReason']),
    readString(record, ['status_reason_label', 'statusReasonLabel']),
    accountImportSource(record) === 'bulk_session_import' ? '批量一键导入' : '手动导入',
    claudeAuthMethodText(record),
    accountStateDetail(account),
    lastErrorText(record),
    runtime.currentRpm,
    runtime.maxSessions,
  ]
    .filter((item) => item !== '' && item !== undefined && item !== null)
    .join(' ')
    .toLowerCase();
}

function accountStateDetail(account: AuthFileItem): string {
  const record = account as Record<string, unknown>;
  const statusReasonLabel = readString(record, ['status_reason_label', 'statusReasonLabel']);
  const statusReason = readStatusReason(record);
  const runtime = readRuntimeStats(record);
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
  if (statusReason === 'rpm_cooldown') {
    return `RPM 达到 ${runtime.currentRpm}/${runtime.rpmLimit}，恢复 ${formatDate(runtime.rpmResetAt)}`;
  }
  if (statusReason === 'session_full') {
    return `已有会话可继续，无会话 ID 请求不受影响，新会话释放 ${formatDate(runtime.sessionResetAt)}`;
  }
  if (statusReason === 'subscription_issue') {
    return statusReasonLabel || '订阅、退款或账单状态异常';
  }
  if (isAccountRequestBodyError(record)) {
    return '请求体或工具调用需要处理';
  }
  const retryAt = record.next_retry_after ?? record.nextRetryAfter;
  if (parseDateMs(retryAt) > Date.now()) {
    return `下次重试 ${formatDate(retryAt)}`;
  }
  return sanitizeSensitiveText(
    statusReasonLabel ||
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
    rpmLimit: readString(record, ['rpm_limit', 'rpmLimit']) || '60',
    maxSessions: readString(record, ['max_sessions', 'maxSessions']) || '5',
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
  const safeMessage = sanitizeSensitiveText(message);
  const status = result.statusCode;
  if (code === 'account_banned' || message.toLowerCase().includes('account_banned')) {
    return `账号已被上游标记为封禁/停用（account_banned，来自 ${source}）`;
  }
  if (status === 401) {
    return `认证已失效或被撤销（401，来自 ${source}）：${safeMessage}`;
  }
  if (status === 403) {
    return `账号无权访问该接口（403，来自 ${source}）：${safeMessage}`;
  }
  if (status === 429) {
    return `额度接口被限流（429，来自 ${source}）：${safeMessage}`;
  }
  return sanitizeSensitiveText(getApiCallErrorMessage(result));
}

function isClaudeAccountBlockingStatus(statusCode: number): boolean {
  return statusCode === 401 || statusCode === 403 || statusCode === 429;
}

function resolveClaudePlanLabel(profile: ClaudeProfileResponse | null): string {
  if (!profile) return '未知套餐';
  if (normalizeFlagValue(profile.account?.has_claude_max)) return 'Max';
  if (normalizeFlagValue(profile.account?.has_claude_pro)) return 'Pro';
  const organizationType = String(profile.organization?.organization_type ?? '').toLowerCase();
  const subscriptionStatus = String(profile.organization?.subscription_status ?? '').toLowerCase();
  if (organizationType === 'claude_team' && subscriptionStatus === 'active') return 'Team';
  if (
    normalizeFlagValue(profile.account?.has_claude_max) === false &&
    normalizeFlagValue(profile.account?.has_claude_pro) === false
  ) {
    return 'Free';
  }
  return '未知套餐';
}

function normalizePlanBadge(rawPlan: string, detail?: string): AccountPlanBadge {
  const normalized = rawPlan.trim().toLowerCase();
  switch (normalized) {
    case 'max':
    case 'plan_max':
      return { label: 'Max', tone: 'max', detail };
    case 'pro':
    case 'plan_pro':
      return { label: 'Pro', tone: 'pro', detail };
    case 'team':
    case 'business':
    case 'go':
    case 'plan_team':
      return { label: 'Team', tone: 'team', detail };
    case 'free':
    case 'plan_free':
      return { label: 'Free', tone: 'free', detail };
    default:
      return { label: rawPlan.trim() || '待刷新', tone: 'unknown', detail };
  }
}

function accountPlanBadge(
  record: Record<string, unknown>,
  quotaDetail?: AccountQuotaDetail
): AccountPlanBadge {
  if (quotaDetail?.status === 'loading') {
    return { label: '查询中', tone: 'unknown' };
  }
  if (quotaDetail?.status === 'error') {
    return { label: '刷新失败', tone: 'unknown' };
  }
  if (quotaDetail?.status === 'success') {
    return normalizePlanBadge(
      quotaDetail.planLabel || '未知套餐',
      quotaDetail.subscriptionStatus || undefined
    );
  }

  const metadata = readRecord(record.metadata);
  const attributes = readRecord(record.attributes);
  const rawPlan =
    readString(record, ['plan_type', 'planType']) ||
    readString(metadata ?? {}, ['plan_type', 'planType']) ||
    readString(attributes ?? {}, ['plan_type', 'planType']);
  const persistedDetail =
    readString(record, ['subscription_status', 'subscriptionStatus']) ||
    readString(metadata ?? {}, ['subscription_status', 'subscriptionStatus']) ||
    readString(record, ['subscription_tier', 'subscriptionTier']) ||
    readString(metadata ?? {}, ['subscription_tier', 'subscriptionTier']) ||
    readString(record, ['organization_name', 'organizationName']) ||
    readString(metadata ?? {}, ['organization_name', 'organizationName']);

  if (rawPlan) return normalizePlanBadge(rawPlan, persistedDetail || undefined);
  return { label: '待刷新', tone: 'unknown' };
}

function accountPlanToneClass(tone: AccountPlanTone): string {
  switch (tone) {
    case 'max':
      return styles.accountPlanMax;
    case 'pro':
      return styles.accountPlanPro;
    case 'team':
      return styles.accountPlanTeam;
    case 'free':
      return styles.accountPlanFree;
    default:
      return styles.accountPlanUnknown;
  }
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
  if (isSetupTokenAccount(record)) {
    return setupTokenQuotaDetail(record);
  }
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
    throw new Error('额度响应为空或格式异常');
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

function claudeAuthMethodText(record: Record<string, unknown>): string {
  const explicitLabel = readString(record, ['auth_method_label', 'authMethodLabel']);
  if (explicitLabel) return sanitizeSensitiveText(explicitLabel);
  const source = readString(record, ['auth_source', 'authSource']);
  switch (source) {
    case 'claude_code_cli':
      return 'CLI OAuth';
    case 'claude_platform':
      return 'Platform OAuth';
    case 'claude_setup_token':
      return 'Setup Token OAuth';
    default:
      return '未知';
  }
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
  const body = sanitizeSensitiveText([status, code, message].filter(Boolean).join(' / ') || '有错误记录');
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

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / total) * 100)));
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function mimicryStatusLabel(status?: ClaudeMimicryStatus): string {
  switch (status) {
    case 'aligned':
      return '已对齐';
    case 'warning':
      return '需关注';
    case 'failed':
      return '未对齐';
    case 'waiting':
      return '等待请求';
    default:
      return '未校验';
  }
}

function mimicryGuardActionLabel(action?: ClaudeMimicryEvent['action']): string {
  switch (action) {
    case 'allow':
      return '放行';
    case 'degrade':
      return '修复后放行';
    case 'block':
      return '已阻断';
    default:
      return '未知';
  }
}

function mimicryClientSourceLabel(source?: string): string {
  switch ((source ?? '').toLowerCase()) {
    case 'claude-code':
      return 'CLI';
    case 'cherrystudio':
      return 'Cherry Studio';
    case 'hermes':
      return 'Hermes';
    case 'openclaw':
      return 'OpenClaw';
    case 'opencode':
      return 'OpenCode';
    case 'openai-compatible':
      return 'OpenAI 兼容';
    default:
      return sanitizeSensitiveText(source || '未知客户端');
  }
}

function mimicryScoreFromStatus(status?: ClaudeMimicryStatus, fallback = 0): number {
  switch (status) {
    case 'aligned':
      return 100;
    case 'warning':
      return 76;
    case 'failed':
      return 35;
    case 'waiting':
      return fallback;
    default:
      return fallback;
  }
}

function compactList(values: unknown, fallback = '无'): string {
  if (!Array.isArray(values) || values.length === 0) return fallback;
  const list = values.map((item) => String(item ?? '').trim()).filter(Boolean);
  if (list.length === 0) return fallback;
  if (list.length <= 3) return list.join(' / ');
  return `${list.slice(0, 3).join(' / ')} +${list.length - 3}`;
}

function auditIssueCount(values: unknown): number {
  return Array.isArray(values) ? values.length : 0;
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
  const [manualSessionImportOpen, setManualSessionImportOpen] = useState(false);
  const [manualSessionKeyDraft, setManualSessionKeyDraft] = useState('');
  const [startingManualSessionImport, setStartingManualSessionImport] = useState(false);
  const [sessionImportConcurrency, setSessionImportConcurrency] = useState('10');
  const [sessionImportDelayMin, setSessionImportDelayMin] = useState('200');
  const [sessionImportDelayMax, setSessionImportDelayMax] = useState('800');
  const [sessionImportJob, setSessionImportJob] = useState<ClaudeSessionImportJob | null>(null);
  const [sessionImportTotal, setSessionImportTotal] = useState(0);
  const [proxyPool, setProxyPool] = useState<ProxyPoolEntry[]>([]);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [adminPasswordDraft, setAdminPasswordDraft] = useState('');
  const [savingAccessSettings, setSavingAccessSettings] = useState(false);
  const [editingAccount, setEditingAccount] = useState<AuthFileItem | null>(null);
  const [editForm, setEditForm] = useState<AccountEditForm | null>(null);
  const [savingAccount, setSavingAccount] = useState(false);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [batchForm, setBatchForm] = useState<BatchEditForm | null>(null);
  const [savingBatch, setSavingBatch] = useState(false);
  const [accountSearch, setAccountSearch] = useState('');
  const [accountStateFilter, setAccountStateFilter] = useState<AccountStateFilter>('all');
  const [accountProxyFilter, setAccountProxyFilter] = useState<AccountProxyFilter>('all');
  const [accountAuthFilter, setAccountAuthFilter] = useState<AccountAuthFilter>('all');
  const [accountViewMode, setAccountViewMode] = useState<AccountViewMode>(() =>
    typeof window === 'undefined'
      ? 'table'
      : window.localStorage.getItem(ACCOUNT_VIEW_MODE_STORAGE_KEY) === 'cards'
        ? 'cards'
        : 'table'
  );
  const [detailAccountName, setDetailAccountName] = useState<string | null>(null);
  const [togglingName, setTogglingName] = useState('');
  const [deletingName, setDeletingName] = useState('');
  const [reauthenticatingName, setReauthenticatingName] = useState('');
  const [quotaByAccount, setQuotaByAccount] = useState<Record<string, AccountQuotaDetail>>({});
  const [claudeProbeJob, setClaudeProbeJob] = useState<ClaudeProbeJob | null>(null);
  const [mimicryAudit, setMimicryAudit] = useState<ClaudeMimicryAuditResponse | null>(null);
  const [loadingMimicryAudit, setLoadingMimicryAudit] = useState(false);
  const [mimicryEvents, setMimicryEvents] = useState<ClaudeMimicryEventsResponse | null>(null);
  const [loadingMimicryEvents, setLoadingMimicryEvents] = useState(false);
  const claudeProbeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const refreshSingleAccountSnapshot = useCallback(
    async (name: string) => {
      if (!name || connectionStatus !== 'connected') return;
      const files = await authFilesApi.listClaudeHealth();
      const updated = files.find((file) => getAccountName(file) === name);
      if (!updated) return;
      setAccounts((current) =>
        current.map((account) => (getAccountName(account) === name ? { ...account, ...updated } : account))
      );
    },
    [connectionStatus]
  );

  const loadProxyPool = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      setProxyPool([]);
      return;
    }
    try {
      setProxyPool(await proxyPoolApi.list());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '代理池加载失败';
      showNotification(message, 'error');
    }
  }, [connectionStatus, showNotification]);

  const loadMimicryAudit = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      setMimicryAudit(null);
      setMimicryEvents(null);
      return;
    }
    setLoadingMimicryAudit(true);
    try {
      setMimicryAudit(await claudeMimicryApi.getAudit());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'CLI 对齐状态加载失败';
      showNotification(sanitizeSensitiveText(message), 'error');
    } finally {
      setLoadingMimicryAudit(false);
    }
  }, [connectionStatus, showNotification]);

  const loadMimicryEvents = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      setMimicryEvents(null);
      return;
    }
    setLoadingMimicryEvents(true);
    try {
      setMimicryEvents(await claudeMimicryApi.getEvents(80));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'CLI 守卫事件加载失败';
      showNotification(sanitizeSensitiveText(message), 'error');
    } finally {
      setLoadingMimicryEvents(false);
    }
  }, [connectionStatus, showNotification]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    loadProxyPool();
  }, [loadProxyPool]);

  useEffect(() => {
    loadMimicryAudit();
    loadMimicryEvents();
  }, [loadMimicryAudit, loadMimicryEvents]);

  useEffect(() => {
    setSelectedNames((current) => {
      if (current.length === 0) return current;
      const available = new Set(accounts.map(getAccountName).filter(Boolean));
      const next = current.filter((name) => available.has(name));
      return next.length === current.length ? current : next;
    });
  }, [accounts]);

  useEffect(() => {
    if (!detailAccountName) return;
    if (accounts.some((account) => getAccountName(account) === detailAccountName)) return;
    setDetailAccountName(null);
  }, [accounts, detailAccountName]);

  useEffect(() => {
    loadAccessSettings();
  }, [loadAccessSettings]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(ACCOUNT_VIEW_MODE_STORAGE_KEY, accountViewMode);
  }, [accountViewMode]);

  const stats = useMemo(() => {
    const states = accounts.map((account) => {
      const name = String(account.name ?? '').trim();
      return quotaDetailCoolingWindow(accountQuotaDetail(account, name ? quotaByAccount[name] : undefined))
        ? 'quotaCooling'
        : getAccountState(account);
    });
    const success = accounts.reduce((sum, account) => sum + normalizeUsageTotal(account.success), 0);
    const failed = accounts.reduce((sum, account) => sum + normalizeUsageTotal(account.failed), 0);
    const total = success + failed;
    const proxyCount = accounts.filter((account) =>
      readString(account as Record<string, unknown>, ['proxy_url', 'proxyUrl'])
    ).length;
    const runtimeTotals = accounts.reduce(
      (totals, account) => {
        const runtime = readRuntimeStats(account as Record<string, unknown>);
        totals.currentRpm += runtime.currentRpm;
        totals.rpmLimit += runtime.rpmLimit;
        totals.activeSessions += runtime.activeSessions;
        totals.maxSessions += runtime.maxSessions;
        return totals;
      },
      { currentRpm: 0, rpmLimit: 0, activeSessions: 0, maxSessions: 0 }
    );
    const quality24h = accounts.reduce(
      (totals, account) => {
        const quality = readQuality24h(account as Record<string, unknown>);
        totals.requests += quality.requests;
        totals.success += quality.success;
        totals.rateLimited += quality.rateLimited;
        return totals;
      },
      { requests: 0, success: 0, rateLimited: 0 }
    );

    return {
      total: accounts.length,
      active: states.filter((state) => state === 'active').length,
      cooling: states.filter(
        (state) => state === 'cooling' || state === 'quotaCooling' || state === 'rpmCooling'
      ).length,
      unavailable: states.filter(
        (state) =>
          state === 'unavailable' ||
          state === 'authExpired' ||
          state === 'requestError' ||
          state === 'subscriptionIssue' ||
          state === 'sessionFull'
      ).length,
      disabled: states.filter((state) => state === 'disabled').length,
      proxyCount,
      successRate: total > 0 ? Math.round((success / total) * 100) : 100,
      qualitySuccessRate:
        quality24h.requests > 0 ? Math.round((quality24h.success / quality24h.requests) * 100) : 100,
      runtimeTotals,
      quality24h,
    };
  }, [accounts, quotaByAccount]);

  const selectedNameSet = useMemo(() => new Set(selectedNames), [selectedNames]);
  const detailAccount = useMemo(
    () =>
      detailAccountName
        ? accounts.find((account) => getAccountName(account) === detailAccountName) ?? null
        : null,
    [accounts, detailAccountName]
  );
  const filteredAccounts = useMemo(() => {
    const query = accountSearch.trim().toLowerCase();
    return accounts.filter((account) => {
      const record = account as Record<string, unknown>;
      const name = getAccountName(account);
      const quotaCoolingWindow = quotaDetailCoolingWindow(
        accountQuotaDetail(account, name ? quotaByAccount[name] : undefined)
      );
      const state = quotaCoolingWindow ? 'quotaCooling' : getAccountState(account);
      if (!accountMatchesStateFilter(account, state, accountStateFilter)) return false;
      if (!accountMatchesProxyFilter(record, accountProxyFilter)) return false;
      if (!accountMatchesAuthFilter(record, accountAuthFilter)) return false;
      if (query && !accountSearchText(account).includes(query)) return false;
      return true;
    });
  }, [accountAuthFilter, accountProxyFilter, accountSearch, accountStateFilter, accounts, quotaByAccount]);
  const accountSections = useMemo<AccountSection[]>(() => {
    const manual: AuthFileItem[] = [];
    const bulk: AuthFileItem[] = [];
    filteredAccounts.forEach((account) => {
      const source = accountImportSource(account as Record<string, unknown>);
      if (source === 'bulk_session_import') {
        bulk.push(account);
      } else {
        manual.push(account);
      }
    });
    return [
      {
        key: 'manual',
        title: '手动导入账号',
        detail: 'OAuth、单个 Cookie / sessionKey、批量粘贴 sessionKey 导入；旧账号默认归入这里',
        emptyText: '当前筛选下没有手动导入账号',
        accounts: manual,
      },
      {
        key: 'bulk_session_import',
        title: '批量一键导入账号',
        detail: '通过批量验证并导入流程加入的账号',
        emptyText: '当前筛选下没有批量一键导入账号',
        accounts: bulk,
      },
    ];
  }, [filteredAccounts]);
  const filteredAccountNames = useMemo(
    () => filteredAccounts.map(getAccountName).filter(Boolean),
    [filteredAccounts]
  );
  const allFilteredAccountsSelected =
    filteredAccountNames.length > 0 &&
    filteredAccountNames.every((name) => selectedNameSet.has(name));
  const someFilteredAccountsSelected = filteredAccountNames.some((name) => selectedNameSet.has(name));
  const hasAccountFilters =
    accountSearch.trim() !== '' ||
    accountStateFilter !== 'all' ||
    accountProxyFilter !== 'all' ||
    accountAuthFilter !== 'all';
  const claudeProbeRunning =
    claudeProbeJob?.status === 'running' || claudeProbeJob?.status === 'canceling';
  const claudeProbePercent =
    claudeProbeJob && claudeProbeJob.total > 0
      ? Math.round((claudeProbeJob.completed / claudeProbeJob.total) * 100)
      : 0;

  const operationsOverview = useMemo(() => {
    const stateCounts = accounts.reduce<Record<AccountState, number>>(
      (counts, account) => {
        const name = getAccountName(account);
        const state = quotaDetailCoolingWindow(accountQuotaDetail(account, name ? quotaByAccount[name] : undefined))
          ? 'quotaCooling'
          : getAccountState(account);
        counts[state] += 1;
        return counts;
      },
      {
        active: 0,
        cooling: 0,
        quotaCooling: 0,
        rpmCooling: 0,
        sessionFull: 0,
        authExpired: 0,
        subscriptionIssue: 0,
        requestError: 0,
        disabled: 0,
        unavailable: 0,
      }
    );

    const riskAccounts = accounts
      .map((account) => {
        const record = account as Record<string, unknown>;
        const runtime = readRuntimeStats(record);
        const quality = readQuality24h(record);
        const name = getAccountName(account);
        const quotaCoolingWindow = quotaDetailCoolingWindow(
          accountQuotaDetail(account, name ? quotaByAccount[name] : undefined)
        );
        const state = quotaCoolingWindow ? 'quotaCooling' : getAccountState(account);
        const rpmPressure = runtime.rpmLimit > 0 ? runtime.currentRpm / runtime.rpmLimit : 0;
        const sessionPressure =
          runtime.maxSessions > 0 ? runtime.activeSessions / runtime.maxSessions : 0;
        const qualityPenalty = quality.requests > 0 ? (100 - quality.successRate) / 100 : 0;
        const score =
          (state === 'active' ? 0 : 2) +
          rpmPressure +
          sessionPressure +
          qualityPenalty +
          (quality.rateLimited > 0 ? 1 : 0);
        return { account, state, score };
      })
      .filter((item) => item.score > 0.65 || item.state !== 'active')
      .sort((left, right) => right.score - left.score)
      .slice(0, 5);

    return {
      stateCounts,
      rpmPressure: pct(stats.runtimeTotals.currentRpm, stats.runtimeTotals.rpmLimit),
      sessionPressure: pct(stats.runtimeTotals.activeSessions, stats.runtimeTotals.maxSessions),
      proxyCoverage: pct(stats.proxyCount, stats.total),
      riskAccounts,
    };
  }, [accounts, quotaByAccount, stats]);

  const mimicryCoverage = useMemo(() => {
    const raw = config?.raw ?? {};
    const claudeHeaders = readRecord(raw['claude-header-defaults']) ?? {};
    const ua = configText(claudeHeaders['user-agent'], 'claude-cli/2.1.148');
    const packageVersion = configText(claudeHeaders['package-version'], '0.98.0');
    const runtimeVersion = configText(claudeHeaders['runtime-version'], 'v24.13.0');
    const stableDevice = readBool(claudeHeaders, ['stabilize-device-profile'], true);

    const counts = accounts.reduce(
      (result, account) => {
        const record = account as Record<string, unknown>;
        const cloakMode = readString(record, ['cloak_mode', 'cloakMode']) || 'always';
        if (cloakMode === 'always') result.always += 1;
        if (cloakMode === 'auto') result.auto += 1;
        if (cloakMode === 'never') result.never += 1;
        if (readBool(record, ['cloak_cache_user_id', 'cloakCacheUserId'], true)) {
          result.cacheUserId += 1;
        }
        if (readBool(record, ['has_device_profile', 'hasDeviceProfile'], false)) {
          result.deviceProfile += 1;
        }
        if (readString(record, ['auth_source', 'authSource']) === 'claude_code_cli') {
          result.cliOAuth += 1;
        }
        return result;
      },
      { always: 0, auto: 0, never: 0, cacheUserId: 0, deviceProfile: 0, cliOAuth: 0 }
    );

    const total = accounts.length;
    const score = Math.round(
      (ua.includes('claude-cli/') ? 22 : 0) +
        (stableDevice ? 18 : 0) +
        pct(counts.always + counts.auto, total) * 0.2 +
        pct(counts.cacheUserId, total) * 0.2 +
        pct(counts.cliOAuth, total) * 0.2
    );

    return {
      ua,
      packageVersion,
      runtimeVersion,
      stableDevice,
      counts,
      score: clampPercent(score),
    };
  }, [accounts, config]);

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
        label: 'CLI 指纹',
        value: configText(claudeHeaders['user-agent'], 'claude-cli/2.1.148'),
        detail: readBool(claudeHeaders, ['stabilize-device-profile'], true)
          ? '设备画像稳定'
          : '跟随请求动态变化',
      },
    ];
  }, [config]);

  const currentMimicryAudit = mimicryAudit?.audit;
  const mimicryAuditScore = mimicryScoreFromStatus(currentMimicryAudit?.status, mimicryCoverage.score);
  const mimicryIssueTotal =
    (currentMimicryAudit?.failures?.length ?? 0) + (currentMimicryAudit?.warnings?.length ?? 0);
  const recentMimicryEvents = mimicryEvents?.events ?? [];
  const mimicryClientStats = Object.values(mimicryEvents?.client_stats ?? {}).sort(
    (left, right) => right.total - left.total
  );
  const mimicryGuardRaw = readRecord((config?.raw ?? {})['claude-mimicry-guard']) ?? {};
  const mimicryGuardMode = configText(
    config?.claudeMimicryGuard?.mode ?? mimicryGuardRaw.mode,
    'degrade'
  );
  const refreshMimicryDiagnostics = useCallback(() => {
    loadMimicryAudit();
    loadMimicryEvents();
  }, [loadMimicryAudit, loadMimicryEvents]);

  const handleCookieImport = async () => {
    if (!sessionKey.trim()) {
      showNotification('请先填写 sessionKey', 'error');
      return;
    }
    setImporting(true);
    try {
      const result = await oauthApi.cookieAuthClaude({
        sessionKey: sessionKey.trim(),
        proxyUrl: importProxyUrl.trim() || undefined,
      });
      setSessionKey('');
      showNotification(`账号导入成功：${sanitizeSensitiveText(result.email || result.auth_file || '账号')}`, 'success');
      await loadAccounts();
      await loadProxyPool();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Cookie 换授权失败';
      showNotification(sanitizeSensitiveText(message), 'error');
    } finally {
      setImporting(false);
    }
  };

  const refreshSessionImportJob = useCallback(async (jobId: string) => {
    const job = await claudeSessionImportApi.get(jobId);
    setSessionImportJob(job);
    if (job.status === 'completed') {
      await loadAccounts();
      await loadProxyPool();
    }
    return job;
  }, [loadAccounts, loadProxyPool]);

  const handleStartManualSessionImport = async () => {
    const sessionKeys = splitSessionKeyDraft(manualSessionKeyDraft);
    if (sessionKeys.length === 0) {
      showNotification('请先粘贴至少一个 sessionKey', 'error');
      return;
    }
    setStartingManualSessionImport(true);
    try {
      const response = await claudeSessionImportApi.start({
        sessionKeys,
        concurrency: parsePositiveInteger(sessionImportConcurrency, 10),
        delayMinMs: parsePositiveInteger(sessionImportDelayMin, 200),
        delayMaxMs: parsePositiveInteger(sessionImportDelayMax, 800),
      });
      setSessionImportJob(response.job);
      setSessionImportTotal(sessionKeys.length);
      setManualSessionImportOpen(false);
      setManualSessionKeyDraft('');
      showNotification(`批量粘贴导入任务已启动：${sessionKeys.length} 个账号`, 'success');
      void refreshSessionImportJob(response.job_id);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '批量粘贴导入任务启动失败';
      showNotification(sanitizeSensitiveText(message), 'error');
    } finally {
      setStartingManualSessionImport(false);
    }
  };

  useEffect(() => {
    if (!sessionImportJob || sessionImportJob.status !== 'running') return undefined;
    let disposed = false;
    const timer = window.setInterval(() => {
      void claudeSessionImportApi
        .get(sessionImportJob.id)
        .then((job) => {
          if (disposed) return;
          setSessionImportJob(job);
          if (job.status === 'completed') {
            void loadAccounts();
            void loadProxyPool();
          }
        })
        .catch(() => {});
    }, 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [loadAccounts, loadProxyPool, sessionImportJob]);

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

  const toggleSelectedAccount = (name: string, selected: boolean) => {
    if (!name) return;
    setSelectedNames((current) => {
      const set = new Set(current);
      if (selected) {
        set.add(name);
      } else {
        set.delete(name);
      }
      return Array.from(set);
    });
  };

  const selectAllAccounts = () => {
    if (filteredAccountNames.length === 0) return;
    setSelectedNames((current) => {
      const visible = new Set(filteredAccountNames);
      const allVisibleSelected = filteredAccountNames.every((name) => current.includes(name));
      if (allVisibleSelected) {
        return current.filter((name) => !visible.has(name));
      }
      return Array.from(new Set([...current, ...filteredAccountNames]));
    });
  };

  const clearAccountFilters = () => {
    setAccountSearch('');
    setAccountStateFilter('all');
    setAccountProxyFilter('all');
    setAccountAuthFilter('all');
  };

  const clearClaudeProbeTimer = useCallback(() => {
    if (!claudeProbeTimerRef.current) return;
    clearTimeout(claudeProbeTimerRef.current);
    claudeProbeTimerRef.current = null;
  }, []);

  const pollClaudeProbeJob = useCallback(
    async (id: string) => {
      clearClaudeProbeTimer();
      try {
        const job = await authFilesApi.getClaudeProbeJob(id);
        setClaudeProbeJob(job);
        if (job.status === 'running' || job.status === 'canceling') {
          claudeProbeTimerRef.current = setTimeout(() => {
            void pollClaudeProbeJob(id);
          }, 1500);
          return;
        }
        await loadAccounts();
        const type = job.failed > 0 ? 'warning' : 'success';
        showNotification(
          `账号检测${job.status === 'canceled' ? '已取消' : '完成'}：可用 ${job.ok}，异常 ${job.failed}`,
          type
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : '检测任务查询失败';
        showNotification(message, 'error');
      }
    },
    [clearClaudeProbeTimer, loadAccounts, showNotification]
  );

  useEffect(
    () => () => {
      clearClaudeProbeTimer();
    },
    [clearClaudeProbeTimer]
  );

  const startClaudeProbe = useCallback(
    async (names?: string[]) => {
      if (claudeProbeRunning) return;
      const normalizedNames = Array.from(new Set((names || []).map((name) => name.trim()).filter(Boolean)));
      clearClaudeProbeTimer();
      setClaudeProbeJob(null);
      try {
        const job = await authFilesApi.startClaudeProbeJob(
          normalizedNames.length > 0 ? { names: normalizedNames, concurrency: 8 } : { concurrency: 8 }
        );
        setClaudeProbeJob(job);
        if (job.total === 0 || job.status !== 'running') {
          await loadAccounts();
          showNotification('没有需要检测的账号', 'info');
          return;
        }
        showNotification(`账号检测已开始：${job.total} 个账号`, 'info');
        void pollClaudeProbeJob(job.id);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : '检测任务启动失败';
        showNotification(message, 'error');
      }
    },
    [claudeProbeRunning, clearClaudeProbeTimer, loadAccounts, pollClaudeProbeJob, showNotification]
  );

  const cancelClaudeProbe = useCallback(async () => {
    if (!claudeProbeJob?.id) return;
    try {
      const job = await authFilesApi.cancelClaudeProbeJob(claudeProbeJob.id);
      setClaudeProbeJob(job);
      showNotification('账号检测正在取消', 'info');
      void pollClaudeProbeJob(claudeProbeJob.id);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '取消检测失败';
      showNotification(message, 'error');
    }
  }, [claudeProbeJob?.id, pollClaudeProbeJob, showNotification]);

  const openBatchEditor = () => {
    if (selectedNames.length === 0) {
      showNotification('请先选择要批量修改的账号', 'error');
      return;
    }
    setBatchForm(DEFAULT_BATCH_FORM);
  };

  const closeBatchEditor = () => {
    setBatchForm(null);
  };

  const buildBatchPatch = (form: BatchEditForm): AuthFileFieldsPatch | null => {
    const patch: AuthFileFieldsPatch = {};
    if (form.applyProxy) {
      patch.proxy_url = form.proxyUrl.trim();
    }
    if (form.applyPriority) {
      const priority = form.priority.trim() ? Number(form.priority.trim()) : 0;
      if (!Number.isFinite(priority)) {
        showNotification('批量优先级必须是数字', 'error');
        return null;
      }
      patch.priority = Math.floor(priority);
    }
    if (form.applyLimits) {
      const rpmLimit = form.rpmLimit.trim() ? Number(form.rpmLimit.trim()) : 0;
      const maxSessions = form.maxSessions.trim() ? Number(form.maxSessions.trim()) : 0;
      if (!Number.isFinite(rpmLimit) || rpmLimit < 0) {
        showNotification('批量 RPM 上限必须是大于等于 0 的数字', 'error');
        return null;
      }
      if (!Number.isFinite(maxSessions) || maxSessions < 0) {
        showNotification('批量会话上限必须是大于等于 0 的数字', 'error');
        return null;
      }
      patch.rpm_limit = Math.floor(rpmLimit);
      patch.max_sessions = Math.floor(maxSessions);
    }
    if (form.applyCloakMode) {
      patch.cloak_mode = form.cloakMode;
    }
    if (form.applyCacheUserId) {
      patch.cloak_cache_user_id = form.cloakCacheUserId;
    }
    if (Object.keys(patch).length === 0) {
      showNotification('请至少选择一个要批量修改的字段', 'error');
      return null;
    }
    return patch;
  };

  const handleBatchSave = async () => {
    if (!batchForm || selectedNames.length === 0) return;
    const patch = buildBatchPatch(batchForm);
    if (!patch) {
      return;
    }
    setSavingBatch(true);
    let success = 0;
    const failures: string[] = [];
    for (const name of selectedNames) {
      try {
        await authFilesApi.patchFields(name, patch);
        success += 1;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : '保存失败';
        failures.push(`${name}: ${message}`);
      }
    }
    try {
      await loadAccounts();
      await loadProxyPool();
    } finally {
      setSavingBatch(false);
    }
    if (failures.length > 0) {
      showNotification(`批量保存完成：成功 ${success} 个，失败 ${failures.length} 个`, 'error');
      return;
    }
    showNotification(`批量保存完成：${success} 个账号已更新`, 'success');
    setSelectedNames([]);
    closeBatchEditor();
  };

  const handleBatchSetStatus = async (disabled: boolean) => {
    if (selectedNames.length === 0) {
      showNotification('请先选择账号', 'error');
      return;
    }
    const action = disabled ? '停用' : '启用';
    if (!window.confirm(`确定要批量${action} ${selectedNames.length} 个账号吗？`)) {
      return;
    }
    setSavingBatch(true);
    let success = 0;
    let skipped = 0;
    for (const name of selectedNames) {
      // When enabling, skip accounts the upstream has permanently disabled — toggling them
      // back on has no effect and would only churn the health state.
      if (!disabled) {
        const account = accounts.find((item) => getAccountName(item) === name);
        if (account && isUpstreamDisabledAccount(account as Record<string, unknown>)) {
          skipped += 1;
          continue;
        }
      }
      try {
        await authFilesApi.setStatus(name, disabled);
        success += 1;
      } catch {
        /* report aggregate below */
      }
    }
    try {
      await loadAccounts();
    } finally {
      setSavingBatch(false);
    }
    const skippedSuffix = skipped > 0 ? `，跳过 ${skipped} 个上游已禁用账号` : '';
    showNotification(
      `批量${action}完成：成功 ${success}/${selectedNames.length} 个${skippedSuffix}`,
      success + skipped === selectedNames.length ? 'success' : 'error'
    );
  };

  const handleBatchDeleteAccounts = async () => {
    const names = Array.from(new Set(selectedNames.map((name) => name.trim()).filter(Boolean)));
    if (names.length === 0) {
      showNotification('请先选择要删除的账号', 'error');
      return;
    }
    if (
      !window.confirm(
        `确定要永久删除 ${names.length} 个账号吗？此操作会移除账号授权文件，不能通过启用恢复。`
      )
    ) {
      return;
    }

    setSavingBatch(true);
    try {
      const result = await authFilesApi.deleteFiles(names);
      const failedNames = new Set(result.failed.map((item) => item.name).filter(Boolean));
      const deletedNames = new Set(
        result.files.length > 0 ? result.files : names.filter((name) => !failedNames.has(name))
      );
      const deletedCount = deletedNames.size;
      setQuotaByAccount((prev) => {
        const next = { ...prev };
        deletedNames.forEach((name) => {
          delete next[name];
        });
        return next;
      });
      setSelectedNames((current) => current.filter((name) => !deletedNames.has(name)));
      if (detailAccountName && deletedNames.has(detailAccountName)) {
        setDetailAccountName(null);
      }
      await loadAccounts();
      if (result.failed.length > 0) {
        showNotification(`批量删除完成：成功 ${deletedCount} 个，失败 ${result.failed.length} 个`, 'error');
        return;
      }
      showNotification(`批量删除完成：${deletedCount} 个账号已删除`, 'success');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '批量删除失败';
      showNotification(message, 'error');
    } finally {
      setSavingBatch(false);
    }
  };

  const handleToggleAccount = async (account: AuthFileItem) => {
    const name = String(account.name ?? '').trim();
    if (!name) return;
    const permanentError = claudePermanentAccountError(account as Record<string, unknown>);
    if (permanentError) {
      showNotification(`该账号已被上游禁用，无法启用/停用：${permanentError.message}`, 'error');
      return;
    }
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
    if (!window.confirm(`确定要删除账号 ${getAccountTitle(account)} 吗？此操作会移除该账号授权文件。`)) {
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
      showNotification('账号已删除', 'success');
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
      showNotification('账号认证已刷新并恢复', 'success');
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
      showNotification(detail.note || '订阅与额度信息已刷新', 'success');
      void refreshSingleAccountSnapshot(name).catch(() => {});
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '订阅与额度查询失败';
      const safeMessage = sanitizeSensitiveText(message);
      setQuotaByAccount((prev) => ({
        ...prev,
        [name]: { status: 'error', windows: [], error: safeMessage },
      }));
      showNotification(safeMessage, 'error');
      void refreshSingleAccountSnapshot(name).catch(() => {});
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
    const rpmLimit = editForm.rpmLimit.trim() ? Number(editForm.rpmLimit.trim()) : 0;
    if (!Number.isFinite(rpmLimit) || rpmLimit < 0) {
      showNotification('RPM 上限必须是大于等于 0 的数字', 'error');
      return;
    }
    const maxSessions = editForm.maxSessions.trim() ? Number(editForm.maxSessions.trim()) : 0;
    if (!Number.isFinite(maxSessions) || maxSessions < 0) {
      showNotification('会话上限必须是大于等于 0 的数字', 'error');
      return;
    }

    const patch: AuthFileFieldsPatch = {
      proxy_url: editForm.proxyUrl.trim(),
      prefix: editForm.prefix.trim(),
      priority,
      rpm_limit: Math.floor(rpmLimit),
      max_sessions: Math.floor(maxSessions),
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
      await refreshSingleAccountSnapshot(name);
      await loadProxyPool();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '账号策略保存失败';
      showNotification(message, 'error');
    } finally {
      setSavingAccount(false);
    }
  };

  const sessionImportRunning = sessionImportJob?.status === 'running';
  const sessionImportProgress =
    sessionImportJob && sessionImportTotal > 0
      ? Math.round((sessionImportJob.total_processed / sessionImportTotal) * 100)
      : 0;
  const sessionImportFailures = Object.entries(sessionImportJob?.failure_reasons ?? {})
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6);
  const recentSessionImportResults = (sessionImportJob?.results ?? []).slice(-6).reverse();
  const manualSessionKeys = useMemo(() => splitSessionKeyDraft(manualSessionKeyDraft), [manualSessionKeyDraft]);
  const renderPortal = (content: ReactNode) =>
    typeof document === 'undefined' ? null : createPortal(content, document.body);

  const renderAccountDetailDrawer = (account: AuthFileItem) => {
    const record = account as Record<string, unknown>;
    const name = getAccountName(account);
    const passiveQuotaAccount = isSetupTokenAccount(record);
    const quotaDetail = accountQuotaDetail(account, name ? quotaByAccount[name] : undefined);
    const quotaCoolingWindow = quotaDetailCoolingWindow(quotaDetail);
    const state = quotaCoolingWindow ? 'quotaCooling' : getAccountState(account);
    const recent = normalizeRecentRequestBuckets(account.recent_requests ?? account.recentRequests);
    const bar = statusBarDataFromRecentRequests(recent);
    const proxyUrl = readString(record, ['proxy_url', 'proxyUrl']);
    const prefix = readString(record, ['prefix']) || '默认';
    const priority = readNumber(record, ['priority'], 0);
    const runtime = readRuntimeStats(record);
    const quality = readQuality24h(record);
    const qualityRate = quality.requests > 0 ? Math.round((quality.success / quality.requests) * 100) : 100;
    const cloakMode = readString(record, ['cloak_mode', 'cloakMode']) || 'always';
    const cacheUserId = readBool(record, ['cloak_cache_user_id', 'cloakCacheUserId'], true);
    const permanentError = claudePermanentAccountError(record);
    const stateDetail = quotaCoolingWindow
      ? `${quotaCoolingWindow.label} 额度已用完，恢复 ${quotaCoolingWindow.resetLabel}`
      : accountStateDetail(account);
    const runtimeQuotaText = quotaCoolingWindow
      ? `${quotaCoolingWindow.label} 额度已用完，恢复 ${quotaCoolingWindow.resetLabel}`
      : quotaRuntimeText(record);
    const closeDetail = () => setDetailAccountName(null);

    return (
      <div className={styles.drawerBackdrop} role="presentation" onClick={closeDetail}>
        <aside
          className={styles.accountDetailDrawer}
          role="dialog"
          aria-modal="true"
          aria-label="账号详情"
          onClick={(event) => event.stopPropagation()}
        >
          <div className={styles.drawerHeader}>
            <div>
              <span className={styles.drawerEyebrow}>账号详情</span>
              <h2>{getAccountTitle(account)}</h2>
              <p>{name}</p>
            </div>
            <button type="button" className={styles.iconButton} onClick={closeDetail} aria-label="关闭详情">
              ×
            </button>
          </div>

          <div className={styles.drawerStatusRow}>
            <span className={`${styles.statusPill} ${styles[state]}`}>{accountStateLabel(state)}</span>
            <span>{stateDetail}</span>
          </div>

          <div className={styles.healthBar} aria-label="最近请求状态">
            {bar.blocks.map((block, index) => (
              <span key={`${name}-drawer-block-${index}`} className={styles[`block${block}`]} />
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
              <dt>RPM</dt>
              <dd>
                {runtime.currentRpm}/{runtime.rpmLimit || '不限'}
                {runtime.rpmResetAt ? ` · ${formatDate(runtime.rpmResetAt)}` : ''}
              </dd>
            </div>
            <div>
              <dt>会话</dt>
              <dd>
                {runtime.activeSessions}/{runtime.maxSessions || '不限'}
                {runtime.sessionResetAt ? ` · ${formatDate(runtime.sessionResetAt)}` : ''}
              </dd>
            </div>
            <div>
              <dt>24h 质量</dt>
              <dd>
                {quality.requests} 请求 / {qualityRate}% / 429 {quality.rateLimited}
              </dd>
            </div>
            <div>
              <dt>认证方式</dt>
              <dd>{claudeAuthMethodText(record)}</dd>
            </div>
            <div>
              <dt>伪装</dt>
              <dd>
                {cloakMode}
                {cacheUserId ? ' / 稳定 user_id' : ' / 每次生成 user_id'}
              </dd>
            </div>
            <div>
              <dt>最近使用</dt>
              <dd>{formatDate(runtime.lastUsedAt)}</dd>
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
                      : passiveQuotaAccount
                        ? '被动采样额度'
                        : '按需查询上游用量'}
                </span>
              </div>
              {!passiveQuotaAccount ? (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={quotaDetail?.status === 'loading'}
                  disabled={Boolean(permanentError)}
                  onClick={() => handleRefreshAccountQuota(account)}
                >
                  刷新额度
                </Button>
              ) : null}
            </div>
            {permanentError ? (
              <div className={styles.quotaError}>
                {permanentError.message}。该账号已从生产轮询中隔离，已有额度信息只表示 OAuth 资料接口曾经可读。
              </div>
            ) : null}
            {quotaDetail?.status === 'success' ? (
              <div className={styles.quotaContent}>
                <div className={styles.quotaSummary}>
                  <span>{quotaDetail.accountEmail || getAccountTitle(account)}</span>
                  <span>{quotaDetail.organizationName || '个人/默认组织'}</span>
                </div>
                {quotaDetail.windows.length > 0 ? (
                  quotaDetail.windows.map((window) => (
                    <div key={`${name}-drawer-${window.id}`} className={styles.quotaWindow}>
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
                  <div className={styles.quotaEmpty}>{quotaDetail.note || '上游没有返回可展示的额度窗口'}</div>
                )}
              </div>
            ) : quotaDetail?.status === 'error' && !permanentError ? (
              <div className={styles.quotaError}>{quotaDetail.error || '额度查询失败'}</div>
            ) : permanentError ? null : (
              <div className={styles.quotaEmpty}>
                {passiveQuotaAccount
                  ? '等待下一次请求后显示被动额度。'
                  : '点击刷新额度后显示订阅、剩余额度和重置时间。'}
              </div>
            )}
          </div>

          <div className={styles.drawerActions}>
            <Button variant="secondary" onClick={() => openEditor(account)}>
              <IconSettings size={15} />
              设置
            </Button>
            {!permanentError && (
              <Button
                variant="secondary"
                loading={reauthenticatingName === name}
                onClick={() => handleReauthenticateAccount(account)}
              >
                <IconRefreshCw size={15} />
                重认证
              </Button>
            )}
            <Button
              variant={account.disabled ? 'primary' : 'ghost'}
              loading={togglingName === name}
              disabled={Boolean(permanentError)}
              title={permanentError ? '上游已禁用，不可恢复' : undefined}
              onClick={() => handleToggleAccount(account)}
            >
              {account.disabled ? '启用' : '停用'}
            </Button>
            <Button variant="danger" loading={deletingName === name} onClick={() => handleDeleteAccount(account)}>
              <IconTrash2 size={15} />
              删除
            </Button>
          </div>
        </aside>
      </div>
    );
  };

  return (
    <div className={styles.dashboard}>
      <section className={styles.hero}>
        <div>
          <div className={styles.kicker}>OpenStar Admin</div>
          <h1>账号池与反代控制台</h1>
          <p>
            集中管理 OAuth 账号、Cookie 换授权、每账号代理、请求重试、账号切换与 CLI 兼容策略。
          </p>
        </div>
        <div className={styles.heroActions}>
          <Button
            variant="secondary"
            onClick={() => {
              void loadAccounts();
              void loadMimicryAudit();
            }}
            loading={loading || loadingMimicryAudit}
          >
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
          label="服务账号"
          value={stats.total}
          detail={`${stats.active} 个可用，${stats.disabled} 个停用`}
          tone="neutral"
        />
        <StatCard
          icon={<IconCheck size={22} />}
          label="可用账号"
          value={stats.active}
          detail={`会话 ${stats.runtimeTotals.activeSessions}/${stats.runtimeTotals.maxSessions}`}
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
          label="24h 质量"
          value={`${stats.quality24h.requests}`}
          detail={`成功率 ${stats.qualitySuccessRate}% / 429 ${stats.quality24h.rateLimited} 次 / RPM ${stats.runtimeTotals.currentRpm}/${stats.runtimeTotals.rpmLimit}`}
          tone={stats.quality24h.rateLimited > 0 ? 'warn' : 'neutral'}
        />
      </section>

      <section className={styles.opsPanel}>
        <div className={styles.panelHeader}>
          <div>
            <h2>运营总览</h2>
            <p>从账号状态、请求质量、容量压力和风险队列快速判断账号池是否适合继续承载流量。</p>
          </div>
        </div>
        <div className={styles.opsGrid}>
          <div className={styles.opsColumn}>
            <span>状态分布</span>
            <div className={styles.statusMatrix}>
              <strong>可用 {operationsOverview.stateCounts.active}</strong>
              <strong>限额 {operationsOverview.stateCounts.quotaCooling}</strong>
              <strong>RPM {operationsOverview.stateCounts.rpmCooling}</strong>
              <strong>新会话已满 {operationsOverview.stateCounts.sessionFull}</strong>
              <strong>认证异常 {operationsOverview.stateCounts.authExpired}</strong>
              <strong>停用 {operationsOverview.stateCounts.disabled}</strong>
            </div>
          </div>
          <div className={styles.opsColumn}>
            <span>容量压力</span>
            <div className={styles.pressureItem}>
              <div>
                <strong>RPM</strong>
                <small>
                  {stats.runtimeTotals.currentRpm}/{stats.runtimeTotals.rpmLimit || '不限'}
                </small>
              </div>
              <div className={styles.pressureTrack}>
                <i style={{ width: `${operationsOverview.rpmPressure}%` }} />
              </div>
            </div>
            <div className={styles.pressureItem}>
              <div>
                <strong>会话</strong>
                <small>
                  {stats.runtimeTotals.activeSessions}/{stats.runtimeTotals.maxSessions || '不限'}
                </small>
              </div>
              <div className={styles.pressureTrack}>
                <i style={{ width: `${operationsOverview.sessionPressure}%` }} />
              </div>
            </div>
            <div className={styles.pressureItem}>
              <div>
                <strong>代理覆盖</strong>
                <small>
                  {stats.proxyCount}/{stats.total}
                </small>
              </div>
              <div className={styles.pressureTrack}>
                <i style={{ width: `${operationsOverview.proxyCoverage}%` }} />
              </div>
            </div>
          </div>
          <div className={styles.opsColumn}>
            <span>风险队列</span>
            {operationsOverview.riskAccounts.length === 0 ? (
              <div className={styles.opsEmpty}>暂无需要优先处理的账号</div>
            ) : (
              <div className={styles.riskList}>
                {operationsOverview.riskAccounts.map(({ account, state }) => {
                  const name = getAccountName(account);
                  return (
                    <button key={name} type="button" onClick={() => openEditor(account)}>
                      <strong>{getAccountTitle(account)}</strong>
                      <span>{accountStateLabel(state)} · {accountStateDetail(account)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className={styles.mimicryPanel}>
        <div className={styles.panelHeader}>
          <div>
            <h2>CLI 对齐状态</h2>
            <p>直接校验最近一次真实出站请求的 system、CCH、beta、thinking、tools 与 Header。</p>
          </div>
          <div className={styles.mimicryHeaderActions}>
            <span className={`${styles.mimicryBadge} ${styles[`mimicry${currentMimicryAudit?.status ?? 'waiting'}`]}`}>
              {mimicryStatusLabel(currentMimicryAudit?.status)}
            </span>
            <span className={styles.coverageScore}>{mimicryAuditScore}%</span>
            <Button
              variant="secondary"
              onClick={refreshMimicryDiagnostics}
              loading={loadingMimicryAudit || loadingMimicryEvents}
            >
              <IconRefreshCw size={15} />
              校验
            </Button>
          </div>
        </div>
        <div className={styles.mimicryGrid}>
          <div className={styles.fingerprintBlock}>
            <span>全局指纹</span>
            <strong>{currentMimicryAudit?.headers?.user_agent || mimicryCoverage.ua}</strong>
            <small>
              package {currentMimicryAudit?.headers?.package_version || mimicryCoverage.packageVersion} · runtime{' '}
              {currentMimicryAudit?.headers?.runtime_version || mimicryCoverage.runtimeVersion}
            </small>
          </div>
          <div className={styles.coverageCheck}>
            <span>真实出站请求</span>
            <strong>{mimicryAudit?.has_recent_request ? currentMimicryAudit?.request_path : '等待第一条请求'}</strong>
            <small>
              {currentMimicryAudit?.model || 'claude-sonnet-4-6'} · {formatDate(currentMimicryAudit?.checked_at)}
            </small>
          </div>
          <div className={styles.coverageCheck}>
            <span>伪装守卫</span>
            <strong>
              {mimicryGuardMode === 'strict'
                ? '严格阻断'
                : mimicryGuardMode === 'observe'
                  ? '仅记录'
                  : '自动修复并保护'}
            </strong>
            <small>
              最近 {recentMimicryEvents.length} 条 · 阻断{' '}
              {recentMimicryEvents.filter((event) => event.action === 'block').length} · 修复后放行{' '}
              {recentMimicryEvents.filter((event) => event.action === 'degrade').length}
            </small>
          </div>
          <div className={styles.coverageCheck}>
            <span>CCH 签名</span>
            <strong>{mimicryStatusLabel(currentMimicryAudit?.cch?.status)}</strong>
            <small>
              seed {currentMimicryAudit?.cch?.seed || currentMimicryAudit?.baseline?.cch_seed || '未记录'} · actual{' '}
              {currentMimicryAudit?.cch?.actual || '-'}
            </small>
          </div>
          <div className={styles.coverageCheck}>
            <span>System 哈希</span>
            <strong>
              {mimicryStatusLabel(currentMimicryAudit?.system?.status)} ·{' '}
              {currentMimicryAudit?.system?.blocks?.length ?? 0} blocks
            </strong>
            <small>
              {compactList(
                currentMimicryAudit?.system?.blocks?.map((block) => `${block.label}:${block.hash || '-'}`)
              )}
            </small>
          </div>
          <div className={styles.coverageCheck}>
            <span>Beta 基线</span>
            <strong>
              {currentMimicryAudit?.betas?.count ?? 0}/{currentMimicryAudit?.betas?.expected_count ?? 0}
            </strong>
            <small>
              missing {auditIssueCount(currentMimicryAudit?.betas?.missing)} · unexpected{' '}
              {auditIssueCount(currentMimicryAudit?.betas?.unexpected)}
            </small>
          </div>
          <div className={styles.coverageCheck}>
            <span>Thinking / top fields</span>
            <strong>
              {currentMimicryAudit?.thinking?.type || 'none'} · {currentMimicryAudit?.thinking?.effort || 'default'}
            </strong>
            <small>{compactList(currentMimicryAudit?.thinking?.top_fields)}</small>
          </div>
          <div className={styles.coverageCheck}>
            <span>Tools / schema</span>
            <strong>
              {currentMimicryAudit?.tools?.count ?? 0} tools · {currentMimicryAudit?.tools?.schema_signature || '-'}
            </strong>
            <small>
              leaky {auditIssueCount(currentMimicryAudit?.tools?.leaky_names)} · schema{' '}
              {auditIssueCount(currentMimicryAudit?.tools?.schema_warnings)}
            </small>
          </div>
          <div className={styles.coverageCheck}>
            <span>Header 白名单</span>
            <strong>{mimicryStatusLabel(currentMimicryAudit?.headers?.status)}</strong>
            <small>
              blocked {auditIssueCount(currentMimicryAudit?.headers?.blocked)} · unexpected{' '}
              {auditIssueCount(currentMimicryAudit?.headers?.unexpected)}
            </small>
          </div>
          <div className={styles.coverageCheck}>
            <span>账号覆盖</span>
            <strong>
              CLI OAuth {mimicryCoverage.counts.cliOAuth}/{stats.total} · stable user_id{' '}
              {mimicryCoverage.counts.cacheUserId}/{stats.total}
            </strong>
            <small>
              设备画像 {mimicryCoverage.counts.deviceProfile}/{stats.total} · 模式 always{' '}
              {mimicryCoverage.counts.always}
            </small>
          </div>
        </div>
        {mimicryIssueTotal > 0 && currentMimicryAudit && (
          <div className={styles.mimicryIssues}>
            <strong>最近问题</strong>
            <span>{compactList([...(currentMimicryAudit.failures ?? []), ...(currentMimicryAudit.warnings ?? [])], '无')}</span>
          </div>
        )}
        <div className={styles.mimicryDiagnostics}>
          <div className={styles.mimicryDiagnosticsColumn}>
            <div className={styles.mimicryDiagnosticsHeader}>
              <strong>客户端来源</strong>
              <span>{mimicryClientStats.length || 0} 类</span>
            </div>
            {mimicryClientStats.length === 0 ? (
              <div className={styles.mimicryEmpty}>暂无请求来源统计</div>
            ) : (
              <div className={styles.mimicryClientList}>
                {mimicryClientStats.slice(0, 6).map((stat) => (
                  <div key={stat.client_source} className={styles.mimicryClientItem}>
                    <strong>{mimicryClientSourceLabel(stat.client_source)}</strong>
                    <span>
                      {stat.total} 次 · 放行 {stat.allowed} · 修复 {stat.degraded} · 阻断 {stat.blocked}
                    </span>
                    <small>{stat.last_reason || formatDate(stat.last_seen)}</small>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className={styles.mimicryDiagnosticsColumn}>
            <div className={styles.mimicryDiagnosticsHeader}>
              <strong>最近守卫事件</strong>
              <span>{loadingMimicryEvents ? '加载中' : `${recentMimicryEvents.length} 条`}</span>
            </div>
            {recentMimicryEvents.length === 0 ? (
              <div className={styles.mimicryEmpty}>暂无可定位的守卫事件</div>
            ) : (
              <div className={styles.mimicryEventList}>
                {recentMimicryEvents.slice(0, 8).map((event) => (
                  <div key={event.id} className={styles.mimicryEventItem}>
                    <div className={styles.mimicryEventMain}>
                      <span
                        className={`${styles.mimicryActionBadge} ${
                          styles[`mimicryAction${event.action}`]
                        }`}
                      >
                        {mimicryGuardActionLabel(event.action)}
                      </span>
                      <strong>{event.request_id || event.id}</strong>
                      <small>{formatDate(event.at)}</small>
                    </div>
                    <div className={styles.mimicryEventMeta}>
                      <span>{mimicryClientSourceLabel(event.client_source)}</span>
                      <span>{event.auth_label || event.auth_id || '未绑定账号'}</span>
                      <span>{event.upstream_attempted ? event.upstream_status || '上游无状态' : '未发往上游'}</span>
                    </div>
                    <small>
                      {event.upstream_error ||
                        compactList([...(event.reasons ?? []), ...(event.failures ?? []), ...(event.warnings ?? [])])}
                    </small>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
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
              <h2>导入服务账号</h2>
              <p>支持 OAuth 授权，也支持使用官方站点的 sessionKey 换取 CLI OAuth 授权。</p>
            </div>
            <Link to="/oauth" className={styles.textLink}>
              OAuth 导入页
              <IconExternalLink size={14} />
            </Link>
          </div>
          <Input
            label="sessionKey"
            type="password"
            value={sessionKey}
            onChange={(event) => setSessionKey(event.target.value)}
            placeholder="粘贴官方站点 Cookie 中的 sessionKey"
          />
          <ProxyPicker
            label="该账号专属代理"
            value={importProxyUrl}
            proxies={proxyPool}
            onChange={setImportProxyUrl}
            placeholder="socks5://user:pass@host:port 或 direct，可留空"
            hint="支持 http://、https://、socks5://、socks5h://；留空使用全局代理，direct/none 强制该账号直连。"
          />
          <div className={styles.importButtonStack}>
            <Button onClick={handleCookieImport} loading={importing} fullWidth>
              Cookie 换授权并加入账号池
            </Button>
            <Button
              variant="secondary"
              onClick={() => setManualSessionImportOpen(true)}
              disabled={sessionImportRunning}
              fullWidth
            >
              <IconFileText size={16} />
              批量粘贴 sessionKey 导入
            </Button>
          </div>

          <div className={styles.sessionImportBox}>
            <div className={styles.sessionImportHeader}>
              <div>
                <strong>批量导入配置与进度</strong>
                <span>设置批量粘贴导入的并发与延迟，并查看导入任务进度。</span>
              </div>
              {sessionImportJob && (
                <em className={styles[`sessionImport${sessionImportJob.status}`]}>
                  {sessionImportStatusLabel(sessionImportJob.status)}
                </em>
              )}
            </div>
            <div className={styles.sessionImportGrid}>
              <Input
                label="并发"
                type="number"
                min={1}
                max={20}
                value={sessionImportConcurrency}
                onChange={(event) => setSessionImportConcurrency(event.target.value)}
              />
              <Input
                label="最小延迟 ms"
                type="number"
                min={0}
                value={sessionImportDelayMin}
                onChange={(event) => setSessionImportDelayMin(event.target.value)}
              />
              <Input
                label="最大延迟 ms"
                type="number"
                min={0}
                value={sessionImportDelayMax}
                onChange={(event) => setSessionImportDelayMax(event.target.value)}
              />
            </div>

            {sessionImportJob && (
              <div className={styles.sessionImportStatus}>
                <div className={styles.sessionImportProgress}>
                  <span style={{ width: `${Math.min(100, Math.max(0, sessionImportProgress))}%` }} />
                </div>
                <div className={styles.sessionImportStats}>
                  <span>处理 {sessionImportJob.total_processed}</span>
                  <span>导入 {sessionImportJob.imported}</span>
                  <span>失败 {sessionImportJob.failed}</span>
                  <span>重复 {sessionImportJob.duplicate}</span>
                  {sessionImportJob.rejected > 0 && (
                    <span>已拒绝（上游不可用） {sessionImportJob.rejected}</span>
                  )}
                </div>
                {sessionImportJob.error && <div className={styles.sessionImportError}>{sessionImportJob.error}</div>}
                {sessionImportFailures.length > 0 && (
                  <div className={styles.sessionImportReasons}>
                    {sessionImportFailures.map(([reason, count]) => (
                      <span key={reason}>
                        {reason} · {count}
                      </span>
                    ))}
                  </div>
                )}
                {sessionImportJob.rejected > 0 && sessionImportJob.rejected_reasons && (
                  <div className={styles.sessionImportReasons}>
                    {Object.entries(sessionImportJob.rejected_reasons).map(([reason, count]) => (
                      <span key={reason}>
                        {reason} · {count}
                      </span>
                    ))}
                  </div>
                )}
                {recentSessionImportResults.length > 0 && (
                  <div className={styles.sessionImportResults}>
                    {recentSessionImportResults.map((result) => (
                      <div key={`${result.session_key_hash}-${result.status}-${result.auth_file || result.reason}`}>
                        <strong>{result.status === 'imported' ? '已导入' : '失败'}</strong>
                        <span>{result.email || result.reason || result.auth_file || result.session_key_hash}</span>
                        {result.auth_method_label && <small>{result.auth_method_label}</small>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className={styles.strategyPanel}>
          <div className={styles.panelHeader}>
            <div>
              <h2>伪装与切换策略</h2>
              <p>默认策略已按 CLI 兼容、稳定会话与高缓存命中率配置。</p>
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
            <p>每个账号都可以独立配置代理 IP、优先级、路径前缀和 CLI 伪装方式。</p>
          </div>
          <span className={styles.connectionBadge}>
            {connectionStatus === 'connected' ? apiBase || '已连接' : '未连接'}
          </span>
        </div>

        <div className={styles.accountFilters}>
          <Input
            label="搜索账号"
            value={accountSearch}
            onChange={(event) => setAccountSearch(event.target.value)}
            placeholder="邮箱、文件名、代理、错误信息"
          />
          <div className={styles.filterField}>
            <span>状态</span>
            <Select
              value={accountStateFilter}
              options={ACCOUNT_STATE_FILTER_OPTIONS}
              onChange={(value) => setAccountStateFilter(value as AccountStateFilter)}
            />
          </div>
          <div className={styles.filterField}>
            <span>代理</span>
            <Select
              value={accountProxyFilter}
              options={ACCOUNT_PROXY_FILTER_OPTIONS}
              onChange={(value) => setAccountProxyFilter(value as AccountProxyFilter)}
            />
          </div>
          <div className={styles.filterField}>
            <span>认证方式</span>
            <Select
              value={accountAuthFilter}
              options={ACCOUNT_AUTH_FILTER_OPTIONS}
              onChange={(value) => setAccountAuthFilter(value as AccountAuthFilter)}
            />
          </div>
          <Button variant="ghost" size="sm" onClick={clearAccountFilters} disabled={!hasAccountFilters}>
            重置筛选
          </Button>
        </div>

        <div className={styles.accountToolbar}>
          <div>
            <strong>已选 {selectedNames.length}</strong>
            <span>
              当前显示 {filteredAccounts.length}/{accounts.length}；批量修改会逐个账号保存，失败账号不会影响其他账号。
            </span>
          </div>
          <div>
            <div className={styles.accountViewToggle} aria-label="账号池视图">
              <button
                type="button"
                className={accountViewMode === 'table' ? styles.accountViewToggleActive : ''}
                onClick={() => setAccountViewMode('table')}
              >
                列表
              </button>
              <button
                type="button"
                className={accountViewMode === 'cards' ? styles.accountViewToggleActive : ''}
                onClick={() => setAccountViewMode('cards')}
              >
                卡片
              </button>
            </div>
            <Button
              variant="secondary"
              size="sm"
              loading={claudeProbeRunning}
              onClick={() => void startClaudeProbe(accounts.map(getAccountName).filter(Boolean))}
              disabled={connectionStatus !== 'connected' || accounts.length === 0 || claudeProbeRunning}
            >
              一键检测
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void startClaudeProbe(selectedNames)}
              disabled={selectedNames.length === 0 || claudeProbeRunning}
            >
              检测选中
            </Button>
            {claudeProbeRunning && (
              <Button variant="ghost" size="sm" onClick={() => void cancelClaudeProbe()}>
                取消检测
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={selectAllAccounts} disabled={filteredAccountNames.length === 0}>
              {allFilteredAccountsSelected ? '取消全选' : `全选当前筛选 ${filteredAccountNames.length}`}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={openBatchEditor}
              disabled={selectedNames.length === 0 || savingBatch}
            >
              <IconSettings size={14} />
              批量策略
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleBatchSetStatus(false)}
              disabled={selectedNames.length === 0 || savingBatch}
            >
              批量启用
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => handleBatchSetStatus(true)}
              disabled={selectedNames.length === 0 || savingBatch}
            >
              批量停用
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => void handleBatchDeleteAccounts()}
              disabled={selectedNames.length === 0 || savingBatch}
            >
              <IconTrash2 size={14} />
              批量删除
            </Button>
          </div>
        </div>

        {claudeProbeJob && (
          <div className={styles.accountProbePanel}>
            <div className={styles.accountProbeHeader}>
              <div>
                <strong>账号可用性检测</strong>
                <span>
                  {claudeProbeRunning
                    ? `正在检测 ${claudeProbeJob.completed}/${claudeProbeJob.total}`
                    : `检测结束 ${claudeProbeJob.completed}/${claudeProbeJob.total}`}
                </span>
              </div>
              <span>{claudeProbePercent}%</span>
            </div>
            <div className={styles.accountProbeTrack}>
              <span style={{ width: `${claudeProbePercent}%` }} />
            </div>
            <div className={styles.accountProbeStats}>
              <span>可用 {claudeProbeJob.ok}</span>
              <span>异常 {claudeProbeJob.failed}</span>
              <span>封禁/停用 {claudeProbeJob.disabled}</span>
              <span>认证失效 {claudeProbeJob.auth_expired}</span>
              <span>限额冷却 {claudeProbeJob.quota_cooldown}</span>
              <span>429 {claudeProbeJob.rate_limited}</span>
            </div>
            {(claudeProbeJob.results || []).filter((item) => item.status !== 'ok').length > 0 && (
              <div className={styles.accountProbeProblems}>
                {(claudeProbeJob.results || [])
                  .filter((item) => item.status !== 'ok')
                  .slice(0, 5)
                  .map((item) => (
                    <span key={`${item.name}-${item.status}`}>
                      <strong>{item.name}</strong>
                      {item.status}
                      {item.message ? ` · ${sanitizeSensitiveText(item.message)}` : ''}
                    </span>
                  ))}
              </div>
            )}
          </div>
        )}

        {loading ? (
          <div className={styles.emptyState}>正在加载账号池...</div>
        ) : accounts.length === 0 ? (
          <div className={styles.emptyState}>还没有账号。先用 OAuth 或 Cookie 换授权导入一个账号。</div>
        ) : filteredAccounts.length === 0 ? (
          <div className={styles.emptyState}>没有符合当前筛选条件的账号。</div>
        ) : accountViewMode === 'table' ? (
          <div className={styles.accountTableShell}>
            <table className={styles.accountTable}>
              <colgroup>
                <col className={styles.accountSelectColumn} />
                <col className={styles.accountIdentityColumn} />
                <col className={styles.accountStatusColumn} />
                <col className={styles.accountLoadColumn} />
                <col className={styles.accountQualityColumn} />
                <col className={styles.accountProxyColumn} />
                <col className={styles.accountAuthColumn} />
                <col className={styles.accountQuotaColumn} />
                <col className={styles.accountActionsColumn} />
              </colgroup>
              <thead>
                <tr>
                  <th>
                    <label className={styles.accountSelectCompact} title="全选当前筛选结果">
                      <input
                        type="checkbox"
                        checked={allFilteredAccountsSelected}
                        ref={(input) => {
                          if (input) {
                            input.indeterminate =
                              someFilteredAccountsSelected && !allFilteredAccountsSelected;
                          }
                        }}
                        onChange={selectAllAccounts}
                        disabled={filteredAccountNames.length === 0}
                        aria-label="全选当前筛选结果"
                      />
                    </label>
                  </th>
                  <th>账号 / 套餐</th>
                  <th>状态</th>
                  <th>负载</th>
                  <th>24h / 最近</th>
                  <th>代理</th>
                  <th>认证 / 有效期</th>
                  <th>额度</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {accountSections.map((section) => (
                  <Fragment key={section.key}>
                    <tr className={styles.accountSectionRow}>
                      <td colSpan={9}>
                        <div className={styles.accountSectionHeader}>
                          <div>
                            <strong>{section.title}</strong>
                            <span>{section.detail}</span>
                          </div>
                          <em>{section.accounts.length}</em>
                        </div>
                      </td>
                    </tr>
                    {section.accounts.length === 0 ? (
                      <tr className={styles.accountSectionEmptyRow}>
                        <td colSpan={9}>{section.emptyText}</td>
                      </tr>
                    ) : (
                      section.accounts.map((account) => {
                  const record = account as Record<string, unknown>;
                  const name = String(account.name ?? '').trim();
                  const passiveQuotaAccount = isSetupTokenAccount(record);
                  const quotaDetail = accountQuotaDetail(account, name ? quotaByAccount[name] : undefined);
                  const quotaCoolingWindow = quotaDetailCoolingWindow(quotaDetail);
                  const state = quotaCoolingWindow ? 'quotaCooling' : getAccountState(account);
                  const proxyUrl = readString(record, ['proxy_url', 'proxyUrl']);
                  const runtime = readRuntimeStats(record);
                  const quality = readQuality24h(record);
                  const qualityRate =
                    quality.requests > 0 ? Math.round((quality.success / quality.requests) * 100) : 100;
                  const permanentError = claudePermanentAccountError(record);
                  const planBadge = accountPlanBadge(record, quotaDetail);
                  const quotaText =
                    quotaDetail?.status === 'success'
                      ? quotaDetail.windows
                          .slice(0, 2)
                          .map((window) => `${window.label} ${formatQuotaPercent(window.remainingPercent)}`)
                          .join(' / ') || quotaDetail.note || '无窗口'
                      : quotaDetail?.status === 'error'
                        ? '刷新失败'
                        : quotaRuntimeText(record);

                  return (
                    <tr
                      key={name || getAccountTitle(account)}
                      className={`${styles.accountTableRow} ${account.disabled ? styles.accountTableDisabled : ''}`}
                      tabIndex={0}
                      onClick={() => {
                        if (name) setDetailAccountName(name);
                      }}
                      onKeyDown={(event) => {
                        if (!name || (event.key !== 'Enter' && event.key !== ' ')) return;
                        event.preventDefault();
                        setDetailAccountName(name);
                      }}
                    >
                      <td onClick={(event) => event.stopPropagation()}>
                        <label className={styles.accountSelectCompact}>
                          <input
                            type="checkbox"
                            checked={selectedNameSet.has(name)}
                            onChange={(event) => toggleSelectedAccount(name, event.target.checked)}
                          />
                        </label>
                      </td>
                      <td>
                        <div className={styles.accountTableIdentity}>
                          <strong>{getAccountTitle(account)}</strong>
                          <span>{name}</span>
                          <span className={styles.accountPlanLine}>
                            <span
                              className={`${styles.accountPlanBadge} ${accountPlanToneClass(planBadge.tone)}`}
                              title={planBadge.detail ? `${planBadge.label} / ${planBadge.detail}` : planBadge.label}
                            >
                              {planBadge.label}
                            </span>
                            {planBadge.detail ? (
                              <span className={styles.accountPlanDetail}>{planBadge.detail}</span>
                            ) : null}
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className={`${styles.statusPill} ${styles[state]}`}>
                          {accountStateLabel(state)}
                        </span>
                      </td>
                      <td>
                        <span className={styles.accountTableStack}>
                          <strong>
                            RPM {runtime.currentRpm}/{runtime.rpmLimit || '不限'}
                          </strong>
                          <span>
                            会话 {runtime.activeSessions}/{runtime.maxSessions || '不限'}
                          </span>
                        </span>
                      </td>
                      <td>
                        <span className={styles.accountTableStack}>
                          <strong>{quality.requests} 请求</strong>
                          <span>
                            {qualityRate}% / 429 {quality.rateLimited} / {formatDate(runtime.lastUsedAt)}
                          </span>
                        </span>
                      </td>
                      <td>
                        <span className={proxyUrl ? styles.accountTableProxy : styles.accountTableMuted}>
                          {proxyUrl || '默认'}
                        </span>
                      </td>
                      <td>
                        <span className={styles.accountTableStack}>
                          <strong>{claudeAuthMethodText(record)}</strong>
                          <span>{formatDate(record.expires_at ?? record.expiresAt)}</span>
                        </span>
                      </td>
                      <td>
                        <span className={styles.accountTableQuota}>{quotaText}</span>
                      </td>
                      <td>
                        <div className={styles.accountTableActions} onClick={(event) => event.stopPropagation()}>
                          {!passiveQuotaAccount ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={quotaDetail?.status === 'loading'}
                              disabled={Boolean(permanentError)}
                              onClick={() => handleRefreshAccountQuota(account)}
                            >
                              额度
                            </Button>
                          ) : null}
                          <Button variant="secondary" size="sm" onClick={() => openEditor(account)}>
                            设置
                          </Button>
                          <Button
                            variant={account.disabled ? 'primary' : 'ghost'}
                            size="sm"
                            loading={togglingName === name}
                            disabled={Boolean(permanentError)}
                            title={permanentError ? '上游已禁用，不可恢复' : undefined}
                            onClick={() => handleToggleAccount(account)}
                          >
                            {account.disabled ? '启用' : '停用'}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={styles.accountSectionStack}>
            {accountSections.map((section) => (
              <section key={section.key} className={styles.accountGroup}>
                <div className={styles.accountGroupHeader}>
                  <div>
                    <h3>{section.title}</h3>
                    <span>{section.detail}</span>
                  </div>
                  <em>{section.accounts.length}</em>
                </div>
                {section.accounts.length === 0 ? (
                  <div className={styles.accountGroupEmpty}>{section.emptyText}</div>
                ) : (
                  <div className={styles.accountGrid}>
                    {section.accounts.map((account) => {
              const record = account as Record<string, unknown>;
              const name = String(account.name ?? '').trim();
              const passiveQuotaAccount = isSetupTokenAccount(record);
              const quotaDetail = accountQuotaDetail(account, name ? quotaByAccount[name] : undefined);
              const quotaCoolingWindow = quotaDetailCoolingWindow(quotaDetail);
              const state = quotaCoolingWindow ? 'quotaCooling' : getAccountState(account);
              const recent = normalizeRecentRequestBuckets(
                account.recent_requests ?? account.recentRequests
              );
              const bar = statusBarDataFromRecentRequests(recent);
              const proxyUrl = readString(record, ['proxy_url', 'proxyUrl']);
              const prefix = readString(record, ['prefix']) || '默认';
              const priority = readNumber(record, ['priority'], 0);
              const runtime = readRuntimeStats(record);
              const quality = readQuality24h(record);
              const cloakMode = readString(record, ['cloak_mode', 'cloakMode']) || 'always';
              const cacheUserId = readBool(record, ['cloak_cache_user_id', 'cloakCacheUserId'], true);
              const permanentError = claudePermanentAccountError(record);
              const statusReasonLabel = readString(record, ['status_reason_label', 'statusReasonLabel']);
              const stateDetail = quotaCoolingWindow
                ? `${quotaCoolingWindow.label} 额度已用完，恢复 ${quotaCoolingWindow.resetLabel}`
                : accountStateDetail(account);
              const runtimeQuotaText = quotaCoolingWindow
                ? `${quotaCoolingWindow.label} 额度已用完，恢复 ${quotaCoolingWindow.resetLabel}`
                : quotaRuntimeText(record);
              const healthLabel = permanentError
                ? '上游已禁用'
                : state === 'active'
                  ? statusReasonLabel || healthStatusLabel(record.health_status ?? record.healthStatus)
                  : accountStateLabel(state);
              const qualityRate =
                quality.requests > 0 ? Math.round((quality.success / quality.requests) * 100) : 100;

              return (
                <article
                  key={name || getAccountTitle(account)}
                  className={`${styles.accountCard} ${selectedNameSet.has(name) ? styles.accountCardSelected : ''}`}
                >
                  <div className={styles.accountTop}>
                    <div>
                      <h3>{getAccountTitle(account)}</h3>
                      <span className={styles.fileName}>{name}</span>
                    </div>
                    <div className={styles.accountTopActions}>
                      <label className={styles.accountSelect}>
                        <input
                          type="checkbox"
                          checked={selectedNameSet.has(name)}
                          onChange={(event) => toggleSelectedAccount(name, event.target.checked)}
                        />
                        <span>选择</span>
                      </label>
                      <span className={`${styles.statusPill} ${styles[state]}`}>
                        {accountStateLabel(state)}
                      </span>
                    </div>
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
                      <dt>RPM</dt>
                      <dd>
                        {runtime.currentRpm}/{runtime.rpmLimit || '不限'}
                        {runtime.rpmResetAt ? ` · ${formatDate(runtime.rpmResetAt)}` : ''}
                      </dd>
                    </div>
                    <div>
                      <dt>会话</dt>
                      <dd>
                        {runtime.activeSessions}/{runtime.maxSessions || '不限'}
                        {runtime.sessionResetAt ? ` · ${formatDate(runtime.sessionResetAt)}` : ''}
                      </dd>
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
                      <dt>24h 质量</dt>
                      <dd>
                        {quality.requests} 请求 / {qualityRate}% / 429 {quality.rateLimited}
                      </dd>
                    </div>
                    <div>
                      <dt>认证方式</dt>
                      <dd>{claudeAuthMethodText(record)}</dd>
                    </div>
                    <div>
                      <dt>最近使用</dt>
                      <dd>{formatDate(runtime.lastUsedAt)}</dd>
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
                            : passiveQuotaAccount
                              ? '被动采样额度'
                              : '按需查询上游用量'}
                        </span>
                      </div>
                      {!passiveQuotaAccount ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={quotaDetail?.status === 'loading'}
                          disabled={Boolean(permanentError)}
                          onClick={() => handleRefreshAccountQuota(account)}
                        >
                          刷新额度
                        </Button>
                      ) : null}
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
                          <div className={styles.quotaEmpty}>
                            {quotaDetail.note || '上游没有返回可展示的额度窗口'}
                          </div>
                        )}
                      </div>
                    ) : quotaDetail?.status === 'error' && !permanentError ? (
                      <div className={styles.quotaError}>{quotaDetail.error || '额度查询失败'}</div>
                    ) : permanentError ? null : (
                      <div className={styles.quotaEmpty}>
                        {passiveQuotaAccount
                          ? '等待下一次请求后显示被动额度。'
                          : '点击刷新额度后显示订阅、剩余额度和重置时间。'}
                      </div>
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
                      disabled={Boolean(permanentError)}
                      title={permanentError ? '上游已禁用，不可恢复' : undefined}
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
            ))}
          </div>
        )}
      </section>

      {detailAccount && renderPortal(renderAccountDetailDrawer(detailAccount))}

      {manualSessionImportOpen &&
        renderPortal(
          <div className={styles.modalBackdrop} role="presentation">
            <div className={styles.modal} role="dialog" aria-modal="true" aria-label="批量粘贴导入">
              <div className={styles.modalHeader}>
                <div>
                  <h2>批量粘贴导入</h2>
                  <p>每行一个 sessionKey；空行和重复项会自动忽略，导入账号归入手动导入分组。</p>
                </div>
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() => setManualSessionImportOpen(false)}
                  aria-label="关闭"
                  disabled={startingManualSessionImport}
                >
                  ×
                </button>
              </div>

              <div className={styles.textareaField}>
                <label>sessionKey 列表</label>
                <textarea
                  className={styles.sessionKeyTextarea}
                  value={manualSessionKeyDraft}
                  onChange={(event) => setManualSessionKeyDraft(event.target.value)}
                  placeholder="每行粘贴一个 sessionKey"
                  spellCheck={false}
                />
                <span>已识别 {manualSessionKeys.length} 个；导入时会随机使用已启用代理池。</span>
              </div>

              <div className={styles.modalActions}>
                <Button
                  variant="ghost"
                  onClick={() => setManualSessionImportOpen(false)}
                  disabled={startingManualSessionImport}
                >
                  取消
                </Button>
                <Button
                  onClick={handleStartManualSessionImport}
                  loading={startingManualSessionImport}
                  disabled={sessionImportRunning || manualSessionKeys.length === 0}
                >
                  开始导入
                </Button>
              </div>
            </div>
          </div>
        )}

      {batchForm &&
        renderPortal(
        <div className={styles.modalBackdrop} role="presentation">
          <div className={styles.modal} role="dialog" aria-modal="true" aria-label="批量账号策略">
            <div className={styles.modalHeader}>
              <div>
                <h2>批量账号策略</h2>
                <p>将选中的字段写入 {selectedNames.length} 个账号；未勾选的字段保持原样。</p>
              </div>
              <button type="button" className={styles.iconButton} onClick={closeBatchEditor} aria-label="关闭">
                ×
              </button>
            </div>

            <div className={styles.batchGrid}>
              <section className={styles.batchGroup}>
                <ToggleSwitch
                  checked={batchForm.applyLimits}
                  onChange={(applyLimits) => setBatchForm({ ...batchForm, applyLimits })}
                  label="更新 RPM 与会话上限"
                />
                <div className={styles.formGrid}>
                  <Input
                    label="RPM 上限"
                    type="number"
                    value={batchForm.rpmLimit}
                    disabled={!batchForm.applyLimits}
                    onChange={(event) => setBatchForm({ ...batchForm, rpmLimit: event.target.value })}
                    placeholder="60"
                  />
                  <Input
                    label="会话上限"
                    type="number"
                    value={batchForm.maxSessions}
                    disabled={!batchForm.applyLimits}
                    onChange={(event) =>
                      setBatchForm({ ...batchForm, maxSessions: event.target.value })
                    }
                    placeholder="5"
                  />
                </div>
              </section>

              <section className={styles.batchGroup}>
                <ToggleSwitch
                  checked={batchForm.applyCloakMode}
                  onChange={(applyCloakMode) => setBatchForm({ ...batchForm, applyCloakMode })}
                  label="更新伪装模式"
                />
                <div className={styles.selectField}>
                  <label>伪装模式</label>
                  <Select
                    value={batchForm.cloakMode}
                    options={CLOAK_MODE_OPTIONS}
                    disabled={!batchForm.applyCloakMode}
                    onChange={(cloakMode) => setBatchForm({ ...batchForm, cloakMode })}
                  />
                </div>
              </section>

              <section className={styles.batchGroup}>
                <ToggleSwitch
                  checked={batchForm.applyCacheUserId}
                  onChange={(applyCacheUserId) =>
                    setBatchForm({ ...batchForm, applyCacheUserId })
                  }
                  label="更新稳定 user_id"
                />
                <ToggleSwitch
                  checked={batchForm.cloakCacheUserId}
                  disabled={!batchForm.applyCacheUserId}
                  onChange={(cloakCacheUserId) =>
                    setBatchForm({ ...batchForm, cloakCacheUserId })
                  }
                  label="稳定 CLI user_id"
                />
              </section>

              <section className={styles.batchGroup}>
                <ToggleSwitch
                  checked={batchForm.applyProxy}
                  onChange={(applyProxy) => setBatchForm({ ...batchForm, applyProxy })}
                  label="更新专属代理"
                />
                <ProxyPicker
                  label="专属代理"
                  value={batchForm.proxyUrl}
                  disabled={!batchForm.applyProxy}
                  proxies={proxyPool}
                  onChange={(proxyUrl) => setBatchForm({ ...batchForm, proxyUrl })}
                  placeholder="留空表示回到全局代理，direct/none 表示直连"
                />
              </section>

              <section className={styles.batchGroup}>
                <ToggleSwitch
                  checked={batchForm.applyPriority}
                  onChange={(applyPriority) => setBatchForm({ ...batchForm, applyPriority })}
                  label="更新优先级"
                />
                <Input
                  label="优先级"
                  type="number"
                  value={batchForm.priority}
                  disabled={!batchForm.applyPriority}
                  onChange={(event) => setBatchForm({ ...batchForm, priority: event.target.value })}
                  placeholder="0"
                />
              </section>
            </div>

            <div className={styles.modalActions}>
              <Button variant="ghost" onClick={closeBatchEditor}>
                取消
              </Button>
              <Button onClick={handleBatchSave} loading={savingBatch}>
                保存批量策略
              </Button>
            </div>
          </div>
        </div>
        )}

      {editingAccount && editForm &&
        renderPortal(
        <div className={styles.modalBackdrop} role="presentation">
          <div className={styles.modal} role="dialog" aria-modal="true" aria-label="账号策略设置">
            <div className={styles.modalHeader}>
              <div>
                <h2>{getAccountTitle(editingAccount)}</h2>
                <p>配置该账号的路由、代理与 CLI 兼容策略。</p>
              </div>
              <button type="button" className={styles.iconButton} onClick={closeEditor} aria-label="关闭">
                ×
              </button>
            </div>

            <div className={styles.formGrid}>
              <ProxyPicker
                label="专属代理"
                value={editForm.proxyUrl}
                proxies={proxyPool}
                onChange={(proxyUrl) => setEditForm({ ...editForm, proxyUrl })}
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
              <Input
                label="RPM 上限"
                type="number"
                value={editForm.rpmLimit}
                onChange={(event) => setEditForm({ ...editForm, rpmLimit: event.target.value })}
                placeholder="60"
                hint="每分钟最多请求数，0 表示不限制；建议生产账号保持 60 或更低。"
              />
              <Input
                label="会话上限"
                type="number"
                value={editForm.maxSessions}
                onChange={(event) => setEditForm({ ...editForm, maxSessions: event.target.value })}
                placeholder="5"
                hint="同一时间可绑定的真实下游会话数，0 表示不限制；无会话 ID 请求只做 5 分钟软粘滞，不占用会话槽。"
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
                label="稳定 CLI user_id"
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
