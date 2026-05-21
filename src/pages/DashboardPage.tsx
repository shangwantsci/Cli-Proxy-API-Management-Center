import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
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
} from '@/components/ui/icons';
import { useAuthStore, useConfigStore, useNotificationStore } from '@/stores';
import { authFilesApi, type AuthFileFieldsPatch } from '@/services/api/authFiles';
import { oauthApi } from '@/services/api/oauth';
import type { AuthFileItem } from '@/types/authFile';
import {
  normalizeRecentRequestBuckets,
  normalizeUsageTotal,
  statusBarDataFromRecentRequests,
} from '@/utils/recentRequests';
import styles from './DashboardPage.module.scss';

type AccountState = 'active' | 'cooling' | 'disabled' | 'unavailable';

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

const CLOAK_MODE_OPTIONS = [
  { value: 'auto', label: '自动识别并补齐' },
  { value: 'always', label: '始终伪装为 Claude Code' },
  { value: 'never', label: '关闭伪装' },
];

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

function getAccountState(account: AuthFileItem): AccountState {
  const record = account as Record<string, unknown>;
  if (account.disabled) return 'disabled';
  const nextRetryAt = parseDateMs(record.next_retry_after ?? record.nextRetryAfter);
  if (nextRetryAt > Date.now()) return 'cooling';
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
      return '冷却中';
    case 'disabled':
      return '已停用';
    case 'unavailable':
      return '不可用';
  }
}

function accountStateDetail(account: AuthFileItem): string {
  const record = account as Record<string, unknown>;
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
    cloakMode: readString(record, ['cloak_mode', 'cloakMode']) || 'auto',
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

function configText(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  return fallback;
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
  const [editingAccount, setEditingAccount] = useState<AuthFileItem | null>(null);
  const [editForm, setEditForm] = useState<AccountEditForm | null>(null);
  const [savingAccount, setSavingAccount] = useState(false);
  const [togglingName, setTogglingName] = useState('');

  const loadAccounts = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      setAccounts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [authFiles] = await Promise.all([
        authFilesApi.list(),
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

  const stats = useMemo(() => {
    const states = accounts.map(getAccountState);
    const success = accounts.reduce((sum, account) => sum + normalizeUsageTotal(account.success), 0);
    const failed = accounts.reduce((sum, account) => sum + normalizeUsageTotal(account.failed), 0);
    const total = success + failed;
    const proxyCount = accounts.filter((account) =>
      readString(account as Record<string, unknown>, ['proxy_url', 'proxyUrl'])
    ).length;

    return {
      total: accounts.length,
      active: states.filter((state) => state === 'active').length,
      cooling: states.filter((state) => state === 'cooling').length,
      unavailable: states.filter((state) => state === 'unavailable').length,
      disabled: states.filter((state) => state === 'disabled').length,
      proxyCount,
      successRate: total > 0 ? Math.round((success / total) * 100) : 100,
    };
  }, [accounts]);

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
        value: configText(claudeHeaders['user-agent'], 'claude-cli/2.1.92'),
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
              const state = getAccountState(account);
              const recent = normalizeRecentRequestBuckets(
                account.recent_requests ?? account.recentRequests
              );
              const bar = statusBarDataFromRecentRequests(recent);
              const proxyUrl = readString(record, ['proxy_url', 'proxyUrl']);
              const prefix = readString(record, ['prefix']) || '默认';
              const priority = readNumber(record, ['priority'], 0);
              const cloakMode = readString(record, ['cloak_mode', 'cloakMode']) || 'auto';
              const cacheUserId = readBool(record, ['cloak_cache_user_id', 'cloakCacheUserId'], true);

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
                    <span>{accountStateDetail(account)}</span>
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
                  </dl>
                  <div className={styles.accountActions}>
                    <Button variant="secondary" size="sm" onClick={() => openEditor(account)}>
                      <IconSettings size={15} />
                      设置
                    </Button>
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
