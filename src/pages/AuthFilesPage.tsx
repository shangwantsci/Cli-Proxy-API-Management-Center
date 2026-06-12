import {
  useCallback,
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { animate } from 'motion/mini';
import type { AnimationPlaybackControlsWithThen } from 'motion-dom';
import { useInterval } from '@/hooks/useInterval';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { CLAUDE_CONFIG } from '@/components/quota';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import {
  IconDownload,
  IconFilterAll,
  IconInfo,
  IconRefreshCw,
  IconSearch,
  IconSettings,
  IconTrash2,
  IconX,
} from '@/components/ui/icons';
import { EmptyState } from '@/components/ui/EmptyState';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { copyToClipboard } from '@/utils/clipboard';
import { getStatusFromError } from '@/utils/quota';
import {
  MAX_CARD_PAGE_SIZE,
  MIN_CARD_PAGE_SIZE,
  QUOTA_PROVIDER_TYPES,
  clampCardPageSize,
  formatModified,
  getAuthFileIcon,
  getAuthFileStatusMessage,
  getTypeColor,
  getTypeLabel,
  hasAuthFileStatusMessage,
  isRuntimeOnlyAuthFile,
  normalizeProviderKey,
  parsePriorityValue,
  type QuotaProviderType,
  type ResolvedTheme,
} from '@/features/authFiles/constants';
import { AuthFileCard } from '@/features/authFiles/components/AuthFileCard';
import { AuthFileModelsModal } from '@/features/authFiles/components/AuthFileModelsModal';
import { AuthFilesPrefixProxyEditorModal } from '@/features/authFiles/components/AuthFilesPrefixProxyEditorModal';
import { OAuthExcludedCard } from '@/features/authFiles/components/OAuthExcludedCard';
import { OAuthModelAliasCard } from '@/features/authFiles/components/OAuthModelAliasCard';
import { useAuthFilesData } from '@/features/authFiles/hooks/useAuthFilesData';
import { useAuthFilesModels } from '@/features/authFiles/hooks/useAuthFilesModels';
import { useAuthFilesOauth } from '@/features/authFiles/hooks/useAuthFilesOauth';
import { useAuthFilesPrefixProxyEditor } from '@/features/authFiles/hooks/useAuthFilesPrefixProxyEditor';
import { useAuthFilesStatusBarCache } from '@/features/authFiles/hooks/useAuthFilesStatusBarCache';
import {
  isAuthFilesSortMode,
  readAuthFilesUiState,
  readPersistedAuthFilesCompactMode,
  writeAuthFilesUiState,
  writePersistedAuthFilesCompactMode,
  type AuthFilesSortMode,
} from '@/features/authFiles/uiState';
import { useAuthStore, useNotificationStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ClaudeQuotaState } from '@/types';
import styles from './AuthFilesPage.module.scss';

const easePower3Out = (progress: number) => 1 - (1 - progress) ** 4;
const easePower2In = (progress: number) => progress ** 3;
const BATCH_BAR_BASE_TRANSFORM = 'translateX(-50%)';
const BATCH_BAR_HIDDEN_TRANSFORM = 'translateX(-50%) translateY(56px)';
const DEFAULT_REGULAR_PAGE_SIZE = 9;
const DEFAULT_COMPACT_PAGE_SIZE = 12;
const DEFAULT_TABLE_PAGE_SIZE = 100;
const MIN_TABLE_PAGE_SIZE = 20;
const MAX_TABLE_PAGE_SIZE = 200;

type AccountViewMode = 'table' | 'cards';
type AccountStatusFilter =
  | 'all'
  | 'available'
  | 'problem'
  | 'disabled'
  | 'quota'
  | 'auth'
  | 'banned'
  | 'session';
type SubscriptionFilter = 'all' | 'max' | 'pro' | 'team' | 'free' | 'unknown';
type ProxyFilter = 'all' | 'proxy' | 'direct';

const escapeWildcardSearchSegment = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildWildcardSearch = (value: string): RegExp | null => {
  if (!value.includes('*')) return null;
  const pattern = value.split('*').map(escapeWildcardSearchSegment).join('.*');
  return new RegExp(pattern, 'i');
};

const isAccountViewMode = (value: unknown): value is AccountViewMode =>
  value === 'table' || value === 'cards';

const clampAccountPageSize = (value: number, viewMode: AccountViewMode, compactMode: boolean) => {
  if (viewMode === 'table') {
    return Math.min(MAX_TABLE_PAGE_SIZE, Math.max(MIN_TABLE_PAGE_SIZE, Math.round(value)));
  }
  return clampCardPageSize(value || (compactMode ? DEFAULT_COMPACT_PAGE_SIZE : DEFAULT_REGULAR_PAGE_SIZE));
};

const readTextField = (file: AuthFileItem, ...keys: string[]): string => {
  for (const key of keys) {
    const value = file[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
};

const readNumberField = (file: AuthFileItem, ...keys: string[]): number | null => {
  for (const key of keys) {
    const value = file[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
};

const readRecordField = (file: AuthFileItem, ...keys: string[]): Record<string, unknown> | null => {
  for (const key of keys) {
    const value = file[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
};

const getClaudeQuotaRemaining = (
  quota: ClaudeQuotaState | undefined,
  windowID: 'five-hour' | 'seven-day'
): number | null => {
  if (!quota || quota.status !== 'success') return null;
  const window = quota.windows.find((item) => item.id === windowID);
  if (!window || typeof window.usedPercent !== 'number') return null;
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
};

const planFilterFromQuota = (quota: ClaudeQuotaState | undefined): SubscriptionFilter => {
  const plan = String(quota?.planType ?? '').toLowerCase();
  if (plan.includes('max')) return 'max';
  if (plan.includes('pro')) return 'pro';
  if (plan.includes('team')) return 'team';
  if (plan.includes('free')) return 'free';
  return 'unknown';
};

const planLabelFromQuota = (quota: ClaudeQuotaState | undefined): string => {
  const plan = planFilterFromQuota(quota);
  if (plan === 'max') return 'Claude Max';
  if (plan === 'pro') return 'Claude Pro';
  if (plan === 'team') return 'Team';
  if (plan === 'free') return 'Free';
  return '未知';
};

const statusReasonOf = (file: AuthFileItem): string =>
  readTextField(file, 'status_reason', 'statusReason').toLowerCase();

const statusLabelOf = (file: AuthFileItem): string =>
  readTextField(file, 'status_reason_label', 'statusReasonLabel') ||
  readTextField(file, 'health_status', 'healthStatus') ||
  (file.disabled ? '已停用' : '正常');

const statusToneOf = (file: AuthFileItem): 'good' | 'warning' | 'danger' | 'muted' => {
  const reason = statusReasonOf(file);
  if (file.disabled || reason === 'disabled' || reason === 'auth_expired') return 'danger';
  if (
    reason === 'account_banned' ||
    reason === 'organization_disabled' ||
    reason === 'account_disabled'
  ) {
    return 'danger';
  }
  if (file.unavailable || reason === 'quota_cooldown' || reason === 'session_full') {
    return 'warning';
  }
  if (reason && reason !== 'healthy') return 'warning';
  if (hasAuthFileStatusMessage(file)) return 'warning';
  return 'good';
};

const matchesStatusFilter = (file: AuthFileItem, filter: AccountStatusFilter): boolean => {
  if (filter === 'all') return true;
  const reason = statusReasonOf(file);
  if (filter === 'available') {
    return !file.disabled && !file.unavailable && (!reason || reason === 'healthy');
  }
  if (filter === 'problem') {
    return Boolean(
      file.disabled ||
        file.unavailable ||
        (reason && reason !== 'healthy') ||
        hasAuthFileStatusMessage(file)
    );
  }
  if (filter === 'disabled') return file.disabled === true || reason === 'disabled';
  if (filter === 'quota') return reason === 'quota_cooldown';
  if (filter === 'auth') return reason === 'auth_expired';
  if (filter === 'banned') {
    return reason === 'account_banned' || reason === 'organization_disabled' || reason === 'account_disabled';
  }
  if (filter === 'session') return reason === 'session_full';
  return true;
};

const formatTimeValue = (value: unknown): string => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value).toLocaleString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value.trim());
    return Number.isNaN(parsed) ? value.trim() : new Date(parsed).toLocaleString();
  }
  return '-';
};

const getQualityNumber = (quality: Record<string, unknown> | null, key: string): number => {
  const value = quality?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

const getQuotaRemainingLabel = (
  quota: ClaudeQuotaState | undefined,
  windowID: 'five-hour' | 'seven-day'
): string => {
  const remaining = getClaudeQuotaRemaining(quota, windowID);
  return remaining === null ? '-' : `${Math.round(remaining)}%`;
};

const getAccountDisplayName = (file: AuthFileItem): string =>
  readTextField(file, 'email', 'account', 'account_email') || file.name;

export function AuthFilesPage() {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.status === 'current' : true;
  const navigate = useNavigate();

  const [filter, setFilter] = useState<'all' | string>('all');
  const [problemOnly, setProblemOnly] = useState(false);
  const [disabledOnly, setDisabledOnly] = useState(false);
  const [accountStatusFilter, setAccountStatusFilter] = useState<AccountStatusFilter>('all');
  const [subscriptionFilter, setSubscriptionFilter] = useState<SubscriptionFilter>('all');
  const [proxyFilter, setProxyFilter] = useState<ProxyFilter>('all');
  const [lowQuotaOnly, setLowQuotaOnly] = useState(false);
  const [accountViewMode, setAccountViewMode] = useState<AccountViewMode>('table');
  const [compactMode, setCompactMode] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSizeByMode, setPageSizeByMode] = useState({
    regular: DEFAULT_REGULAR_PAGE_SIZE,
    compact: DEFAULT_COMPACT_PAGE_SIZE,
    table: DEFAULT_TABLE_PAGE_SIZE,
  });
  const [pageSizeInput, setPageSizeInput] = useState(String(DEFAULT_TABLE_PAGE_SIZE));
  const [viewMode, setViewMode] = useState<'diagram' | 'list'>('list');
  const [sortMode, setSortMode] = useState<AuthFilesSortMode>('default');
  const [detailFileName, setDetailFileName] = useState<string | null>(null);
  const [quotaRefreshing, setQuotaRefreshing] = useState<Record<string, boolean>>({});
  const [batchActionBarVisible, setBatchActionBarVisible] = useState(false);
  const [uiStateHydrated, setUiStateHydrated] = useState(false);
  const floatingBatchActionsRef = useRef<HTMLDivElement>(null);
  const batchActionAnimationRef = useRef<AnimationPlaybackControlsWithThen | null>(null);
  const previousSelectionCountRef = useRef(0);
  const selectionCountRef = useRef(0);

  const {
    files,
    selectedFiles,
    selectionCount,
    loading,
    error,
    uploading,
    deleting,
    deletingAll,
    statusUpdating,
    batchStatusUpdating,
    clearingRuntimeSessions,
    claudeProbeJob,
    claudeProbeRunning,
    fileInputRef,
    loadFiles,
    handleUploadClick,
    handleFileChange,
    handleDelete,
    handleDeleteAll,
    handleDownload,
    handleStatusToggle,
    toggleSelect,
    selectAllVisible,
    invertVisibleSelection,
    deselectAll,
    batchDownload,
    batchSetStatus,
    batchDelete,
    probeClaudeAccounts,
    cancelClaudeProbe,
    clearClaudeRuntimeSessions,
    refreshClaudeHealthForFiles,
  } = useAuthFilesData();

  const statusBarCache = useAuthFilesStatusBarCache(files);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const setClaudeQuota = useQuotaStore((state) => state.setClaudeQuota);

  const {
    excluded,
    excludedError,
    modelAlias,
    modelAliasError,
    allProviderModels,
    loadExcluded,
    loadModelAlias,
    deleteExcluded,
    deleteModelAlias,
    handleMappingUpdate,
    handleDeleteLink,
    handleToggleFork,
    handleRenameAlias,
    handleDeleteAlias,
  } = useAuthFilesOauth({ viewMode, files });

  const {
    modelsModalOpen,
    modelsLoading,
    modelsList,
    modelsFileName,
    modelsFileType,
    modelsError,
    showModels,
    closeModelsModal,
  } = useAuthFilesModels();

  const {
    prefixProxyEditor,
    prefixProxyUpdatedText,
    prefixProxyDirty,
    openPrefixProxyEditor,
    closePrefixProxyEditor,
    handlePrefixProxyChange,
    handlePrefixProxySave,
  } = useAuthFilesPrefixProxyEditor({
    disableControls: connectionStatus !== 'connected',
    loadFiles,
  });

  const disableControls = connectionStatus !== 'connected';
  const normalizedFilter = normalizeProviderKey(String(filter));
  const quotaFilterType: QuotaProviderType | null = QUOTA_PROVIDER_TYPES.has(
    normalizedFilter as QuotaProviderType
  )
    ? (normalizedFilter as QuotaProviderType)
    : null;
  const pageSize =
    accountViewMode === 'table'
      ? pageSizeByMode.table
      : compactMode
        ? pageSizeByMode.compact
        : pageSizeByMode.regular;

  useEffect(() => {
    const persistedCompactMode = readPersistedAuthFilesCompactMode();
    if (typeof persistedCompactMode === 'boolean') {
      setCompactMode(persistedCompactMode);
    }

    const persisted = readAuthFilesUiState();
    if (persisted) {
      if (typeof persisted.filter === 'string' && persisted.filter.trim()) {
        setFilter(normalizeProviderKey(persisted.filter));
      }
      if (typeof persisted.problemOnly === 'boolean') {
        setProblemOnly(persisted.problemOnly);
      }
      if (typeof persisted.disabledOnly === 'boolean') {
        setDisabledOnly(persisted.disabledOnly);
      }
      if (isAccountViewMode(persisted.accountViewMode)) {
        setAccountViewMode(persisted.accountViewMode);
      }
      if (typeof persisted.accountStatusFilter === 'string') {
        const next = persisted.accountStatusFilter as AccountStatusFilter;
        if (['all', 'available', 'problem', 'disabled', 'quota', 'auth', 'banned', 'session'].includes(next)) {
          setAccountStatusFilter(next);
        }
      }
      if (typeof persisted.subscriptionFilter === 'string') {
        const next = persisted.subscriptionFilter as SubscriptionFilter;
        if (['all', 'max', 'pro', 'team', 'free', 'unknown'].includes(next)) {
          setSubscriptionFilter(next);
        }
      }
      if (typeof persisted.proxyFilter === 'string') {
        const next = persisted.proxyFilter as ProxyFilter;
        if (['all', 'proxy', 'direct'].includes(next)) {
          setProxyFilter(next);
        }
      }
      if (typeof persisted.lowQuotaOnly === 'boolean') {
        setLowQuotaOnly(persisted.lowQuotaOnly);
      }
      if (
        typeof persistedCompactMode !== 'boolean' &&
        typeof persisted.compactMode === 'boolean'
      ) {
        setCompactMode(persisted.compactMode);
      }
      if (typeof persisted.search === 'string') {
        setSearch(persisted.search);
      }
      if (typeof persisted.page === 'number' && Number.isFinite(persisted.page)) {
        setPage(Math.max(1, Math.round(persisted.page)));
      }
      const legacyPageSize =
        typeof persisted.pageSize === 'number' && Number.isFinite(persisted.pageSize)
          ? clampCardPageSize(persisted.pageSize)
          : null;
      const regularPageSize =
        typeof persisted.regularPageSize === 'number' && Number.isFinite(persisted.regularPageSize)
          ? clampCardPageSize(persisted.regularPageSize)
          : legacyPageSize ?? DEFAULT_REGULAR_PAGE_SIZE;
      const compactPageSize =
        typeof persisted.compactPageSize === 'number' && Number.isFinite(persisted.compactPageSize)
          ? clampCardPageSize(persisted.compactPageSize)
          : legacyPageSize ?? DEFAULT_COMPACT_PAGE_SIZE;
      const tablePageSize =
        typeof persisted.tablePageSize === 'number' && Number.isFinite(persisted.tablePageSize)
          ? clampAccountPageSize(persisted.tablePageSize, 'table', false)
          : DEFAULT_TABLE_PAGE_SIZE;
      setPageSizeByMode({
        regular: regularPageSize,
        compact: compactPageSize,
        table: tablePageSize,
      });
      if (isAuthFilesSortMode(persisted.sortMode)) {
        setSortMode(persisted.sortMode);
      }
    }

    setUiStateHydrated(true);
  }, []);

  useEffect(() => {
    if (!uiStateHydrated) return;

    writeAuthFilesUiState({
      filter,
      problemOnly,
      disabledOnly,
      accountStatusFilter,
      subscriptionFilter,
      proxyFilter,
      lowQuotaOnly,
      accountViewMode,
      compactMode,
      search,
      page,
      pageSize,
      regularPageSize: pageSizeByMode.regular,
      compactPageSize: pageSizeByMode.compact,
      tablePageSize: pageSizeByMode.table,
      sortMode,
    });
    writePersistedAuthFilesCompactMode(compactMode);
  }, [
    compactMode,
    accountStatusFilter,
    accountViewMode,
    disabledOnly,
    filter,
    lowQuotaOnly,
    page,
    pageSize,
    pageSizeByMode,
    problemOnly,
    proxyFilter,
    search,
    sortMode,
    subscriptionFilter,
    uiStateHydrated,
  ]);

  useEffect(() => {
    setPageSizeInput(String(pageSize));
  }, [pageSize]);

  const setCurrentModePageSize = useCallback(
    (next: number) => {
      setPageSizeByMode((current) => {
        if (accountViewMode === 'table') return { ...current, table: next };
        return compactMode ? { ...current, compact: next } : { ...current, regular: next };
      });
    },
    [accountViewMode, compactMode]
  );

  const commitPageSizeInput = (rawValue: string) => {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      setPageSizeInput(String(pageSize));
      return;
    }

    const value = Number(trimmed);
    if (!Number.isFinite(value)) {
      setPageSizeInput(String(pageSize));
      return;
    }

    const next = clampAccountPageSize(value, accountViewMode, compactMode);
    setCurrentModePageSize(next);
    setPageSizeInput(String(next));
    setPage(1);
  };

  const handlePageSizeChange = (event: ChangeEvent<HTMLInputElement>) => {
    const rawValue = event.currentTarget.value;
    setPageSizeInput(rawValue);

    const trimmed = rawValue.trim();
    if (!trimmed) return;

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;

    const rounded = Math.round(parsed);
    const min = accountViewMode === 'table' ? MIN_TABLE_PAGE_SIZE : MIN_CARD_PAGE_SIZE;
    const max = accountViewMode === 'table' ? MAX_TABLE_PAGE_SIZE : MAX_CARD_PAGE_SIZE;
    if (rounded < min || rounded > max) return;

    setCurrentModePageSize(rounded);
    setPage(1);
  };

  const handleSortModeChange = useCallback(
    (value: string) => {
      if (!isAuthFilesSortMode(value) || value === sortMode) return;
      setSortMode(value);
      setPage(1);
      void loadFiles().catch(() => {});
    },
    [loadFiles, sortMode]
  );

  const handleHeaderRefresh = useCallback(async () => {
    await Promise.all([loadFiles(), loadExcluded(), loadModelAlias()]);
  }, [loadFiles, loadExcluded, loadModelAlias]);

  useHeaderRefresh(handleHeaderRefresh);

  useEffect(() => {
    if (!isCurrentLayer) return;
    loadFiles();
    loadExcluded();
    loadModelAlias();
  }, [isCurrentLayer, loadFiles, loadExcluded, loadModelAlias]);

  useInterval(
    () => {
      void loadFiles().catch(() => {});
    },
    isCurrentLayer ? 240_000 : null
  );

  const existingTypes = useMemo(() => {
    const types = new Set<string>(['all']);
    files.forEach((file) => {
      const type = normalizeProviderKey(String(file.type ?? file.provider ?? ''));
      if (type) types.add(type);
    });
    return Array.from(types);
  }, [files]);

  const filesMatchingStatusFilters = useMemo(
    () =>
      files.filter((file) => {
        if (problemOnly && !hasAuthFileStatusMessage(file)) return false;
        if (disabledOnly && file.disabled !== true) return false;
        if (!matchesStatusFilter(file, accountStatusFilter)) return false;
        const quota = claudeQuota[file.name];
        if (subscriptionFilter !== 'all' && planFilterFromQuota(quota) !== subscriptionFilter) {
          return false;
        }
        if (proxyFilter === 'proxy' && !readTextField(file, 'proxy_url', 'proxyUrl')) return false;
        if (proxyFilter === 'direct' && readTextField(file, 'proxy_url', 'proxyUrl')) return false;
        if (lowQuotaOnly) {
          const fiveHour = getClaudeQuotaRemaining(quota, 'five-hour');
          const weekly = getClaudeQuotaRemaining(quota, 'seven-day');
          if (!((fiveHour !== null && fiveHour <= 20) || (weekly !== null && weekly <= 20))) {
            return false;
          }
        }
        return true;
      }),
    [
      accountStatusFilter,
      claudeQuota,
      disabledOnly,
      files,
      lowQuotaOnly,
      problemOnly,
      proxyFilter,
      subscriptionFilter,
    ]
  );

  const sortOptions = useMemo(
    () => [
      { value: 'default', label: t('auth_files.sort_default') },
      { value: 'az', label: t('auth_files.sort_az') },
      { value: 'priority', label: t('auth_files.sort_priority') },
    ],
    [t]
  );

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: filesMatchingStatusFilters.length };
    filesMatchingStatusFilters.forEach((file) => {
      const type = normalizeProviderKey(String(file.type ?? file.provider ?? ''));
      if (!type) return;
      counts[type] = (counts[type] || 0) + 1;
    });
    return counts;
  }, [filesMatchingStatusFilters]);

  const normalizedSearch = search.trim();
  const wildcardSearch = useMemo(() => buildWildcardSearch(normalizedSearch), [normalizedSearch]);

  const filtered = useMemo(() => {
    const normalizedTerm = normalizedSearch.toLowerCase();

    return filesMatchingStatusFilters.filter((item) => {
      const type = normalizeProviderKey(String(item.type ?? item.provider ?? ''));
      const matchType = normalizedFilter === 'all' || type === normalizedFilter;
      const matchSearch =
        !normalizedSearch ||
        [
          item.name,
          item.type,
          item.provider,
          item.email,
          item.account,
          item.note,
          item['proxy_url'],
          item.proxyUrl,
          item['status_reason_label'],
          item.statusReasonLabel,
        ].some((value) => {
          const content = (value || '').toString();
          return wildcardSearch
            ? wildcardSearch.test(content)
            : content.toLowerCase().includes(normalizedTerm);
        });
      return matchType && matchSearch;
    });
  }, [filesMatchingStatusFilters, normalizedFilter, normalizedSearch, wildcardSearch]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    if (sortMode === 'default') {
      copy.sort((a, b) => {
        const providerA = normalizeProviderKey(String(a.provider ?? a.type ?? 'unknown'));
        const providerB = normalizeProviderKey(String(b.provider ?? b.type ?? 'unknown'));
        const providerCompare = providerA.localeCompare(providerB);
        if (providerCompare !== 0) return providerCompare;
        return a.name.localeCompare(b.name);
      });
    } else if (sortMode === 'az') {
      copy.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortMode === 'priority') {
      copy.sort((a, b) => {
        const pa = parsePriorityValue(a.priority ?? a['priority']) ?? 0;
        const pb = parsePriorityValue(b.priority ?? b['priority']) ?? 0;
        return pb - pa; // 高优先级排前面
      });
    }
    return copy;
  }, [filtered, sortMode]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageItems = sorted.slice(start, start + pageSize);
  const selectablePageItems = useMemo(
    () => pageItems.filter((file) => !isRuntimeOnlyAuthFile(file)),
    [pageItems]
  );
  const selectableFilteredItems = useMemo(
    () => sorted.filter((file) => !isRuntimeOnlyAuthFile(file)),
    [sorted]
  );
  const selectedNames = useMemo(() => Array.from(selectedFiles), [selectedFiles]);
  const selectedHasStatusUpdating = useMemo(
    () => selectedNames.some((name) => statusUpdating[name] === true),
    [selectedNames, statusUpdating]
  );
  const batchStatusButtonsDisabled =
    disableControls ||
    selectedNames.length === 0 ||
    batchStatusUpdating ||
    selectedHasStatusUpdating;
  const claudeProbeResults = claudeProbeJob?.results ?? [];
  const claudeProbeProblemResults = claudeProbeResults.filter((item) => item.status !== 'ok');
  const claudeProbePercent =
    claudeProbeJob && claudeProbeJob.total > 0
      ? Math.round((claudeProbeJob.completed / claudeProbeJob.total) * 100)
      : 0;
  const detailFile = useMemo(
    () => files.find((file) => file.name === detailFileName) ?? null,
    [detailFileName, files]
  );

  const accountSummary = useMemo(() => {
    const total = files.length;
    let available = 0;
    let disabled = 0;
    let quota = 0;
    let authExpired = 0;
    let sessionFull = 0;
    let proxied = 0;
    let successRateSum = 0;
    let successRateCount = 0;

    files.forEach((file) => {
      const reason = statusReasonOf(file);
      if (!file.disabled && !file.unavailable && (!reason || reason === 'healthy')) available += 1;
      if (file.disabled || reason === 'disabled') disabled += 1;
      if (reason === 'quota_cooldown') quota += 1;
      if (reason === 'auth_expired') authExpired += 1;
      if (reason === 'session_full') sessionFull += 1;
      if (readTextField(file, 'proxy_url', 'proxyUrl')) proxied += 1;

      const quality = readRecordField(file, 'quality_24h', 'quality24h');
      const successRate = Number(quality?.success_rate);
      if (Number.isFinite(successRate)) {
        successRateSum += successRate;
        successRateCount += 1;
      }
    });

    return {
      total,
      available,
      problem: Math.max(0, total - available),
      disabled,
      quota,
      authExpired,
      sessionFull,
      proxied,
      successRate:
        successRateCount > 0 ? Math.round((successRateSum / successRateCount) * 10) / 10 : null,
    };
  }, [files]);

  const accountStatusOptions = useMemo(
    () => [
      { value: 'all', label: '全部状态' },
      { value: 'available', label: '可用' },
      { value: 'problem', label: '异常' },
      { value: 'disabled', label: '已停用' },
      { value: 'quota', label: '限额冷却' },
      { value: 'auth', label: '认证失效' },
      { value: 'banned', label: '封禁/组织禁用' },
      { value: 'session', label: '新会话已满' },
    ],
    []
  );

  const subscriptionOptions = useMemo(
    () => [
      { value: 'all', label: '全部订阅' },
      { value: 'max', label: 'Claude Max' },
      { value: 'pro', label: 'Claude Pro' },
      { value: 'team', label: 'Team' },
      { value: 'free', label: 'Free' },
      { value: 'unknown', label: '未知' },
    ],
    []
  );

  const proxyOptions = useMemo(
    () => [
      { value: 'all', label: '全部代理' },
      { value: 'proxy', label: '有账号代理' },
      { value: 'direct', label: '未配置代理' },
    ],
    []
  );

  const refreshClaudeQuotaForFile = useCallback(
    async (file: AuthFileItem) => {
      if (disableControls || file.disabled || quotaRefreshing[file.name]) return;
      setQuotaRefreshing((prev) => ({ ...prev, [file.name]: true }));
      setClaudeQuota((prev) => ({
        ...prev,
        [file.name]: CLAUDE_CONFIG.buildLoadingState(),
      }));

      try {
        const data = await CLAUDE_CONFIG.fetchQuota(file, t);
        setClaudeQuota((prev) => ({
          ...prev,
          [file.name]: CLAUDE_CONFIG.buildSuccessState(data),
        }));
        await refreshClaudeHealthForFiles([file.name]);
        showNotification(t('auth_files.quota_refresh_success', { name: file.name }), 'success');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        const status = getStatusFromError(err);
        setClaudeQuota((prev) => ({
          ...prev,
          [file.name]: CLAUDE_CONFIG.buildErrorState(message, status),
        }));
        await refreshClaudeHealthForFiles([file.name]).catch(() => {});
        showNotification(t('auth_files.quota_refresh_failed', { name: file.name, message }), 'error');
      } finally {
        setQuotaRefreshing((prev) => {
          const next = { ...prev };
          delete next[file.name];
          return next;
        });
      }
    },
    [
      disableControls,
      quotaRefreshing,
      refreshClaudeHealthForFiles,
      setClaudeQuota,
      showNotification,
      t,
    ]
  );

  const copyTextWithNotification = useCallback(
    async (text: string) => {
      const copied = await copyToClipboard(text);
      showNotification(
        copied
          ? t('notification.link_copied', { defaultValue: 'Copied to clipboard' })
          : t('notification.copy_failed', { defaultValue: 'Copy failed' }),
        copied ? 'success' : 'error'
      );
    },
    [showNotification, t]
  );

  const renderStatusBadge = (file: AuthFileItem) => (
    <span className={`${styles.accountStatusBadge} ${styles[`accountStatusBadge_${statusToneOf(file)}`]}`}>
      {statusLabelOf(file)}
    </span>
  );

  const renderQuotaChip = (
    quota: ClaudeQuotaState | undefined,
    windowID: 'five-hour' | 'seven-day'
  ) => {
    const remaining = getClaudeQuotaRemaining(quota, windowID);
    const label = getQuotaRemainingLabel(quota, windowID);
    const tone =
      remaining === null ? 'muted' : remaining <= 20 ? 'danger' : remaining <= 40 ? 'warning' : 'good';
    return (
      <span className={`${styles.accountQuotaChip} ${styles[`accountQuotaChip_${tone}`]}`}>
        {label}
      </span>
    );
  };

  const renderAccountTable = () => (
    <div className={styles.accountTableShell}>
      <div className={styles.accountTableScroll}>
        <table className={styles.accountTable}>
          <thead>
            <tr>
              <th className={styles.accountTableSelectCell}>选择</th>
              <th>账号</th>
              <th>订阅</th>
              <th>状态</th>
              <th>RPM</th>
              <th>会话</th>
              <th>24h 质量</th>
              <th>代理</th>
              <th>最近使用</th>
              <th>5h</th>
              <th>周限</th>
              <th className={styles.accountTableActionsCell}>操作</th>
            </tr>
          </thead>
          <tbody>
            {pageItems.map((file) => {
              const providerKey = normalizeProviderKey(String(file.type ?? file.provider ?? 'unknown'));
              const providerIcon = getAuthFileIcon(providerKey, resolvedTheme);
              const quota = claudeQuota[file.name];
              const quality = readRecordField(file, 'quality_24h', 'quality24h');
              const requests = getQualityNumber(quality, 'requests');
              const successRate = getQualityNumber(quality, 'success_rate');
              const rateLimited = getQualityNumber(quality, 'rate_limited');
              const currentRpm = readNumberField(file, 'current_rpm', 'currentRpm') ?? 0;
              const rpmLimit = readNumberField(file, 'rpm_limit', 'rpmLimit') ?? 0;
              const activeSessions = readNumberField(file, 'active_sessions', 'activeSessions') ?? 0;
              const maxSessions = readNumberField(file, 'max_sessions', 'maxSessions') ?? 0;
              const proxyUrl = readTextField(file, 'proxy_url', 'proxyUrl');
              const lastUsed = formatTimeValue(file['last_used_at'] ?? file.lastRefresh ?? file.modified);
              const isRuntimeOnly = isRuntimeOnlyAuthFile(file);
              const quotaLoading = quotaRefreshing[file.name] === true || quota?.status === 'loading';

              return (
                <tr
                  key={file.name}
                  className={`${file.disabled ? styles.accountTableRowDisabled : ''}`}
                >
                  <td className={styles.accountTableSelectCell}>
                    <SelectionCheckbox
                      checked={selectedFiles.has(file.name)}
                      onChange={() => toggleSelect(file.name)}
                      disabled={isRuntimeOnly}
                      ariaLabel={`选择 ${file.name}`}
                    />
                  </td>
                  <td>
                    <div className={styles.accountIdentity}>
                      <span className={styles.accountAvatar}>
                        {providerIcon ? (
                          <img src={providerIcon} alt="" className={styles.accountAvatarIcon} />
                        ) : (
                          getTypeLabel(t, providerKey).slice(0, 1).toUpperCase()
                        )}
                      </span>
                      <span className={styles.accountIdentityText}>
                        <span className={styles.accountName}>{getAccountDisplayName(file)}</span>
                        <span className={styles.accountFileName}>{file.name}</span>
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className={styles.accountPlanBadge}>{planLabelFromQuota(quota)}</span>
                  </td>
                  <td>{renderStatusBadge(file)}</td>
                  <td className={styles.accountMetricCell}>
                    {currentRpm}/{rpmLimit > 0 ? rpmLimit : '不限'}
                  </td>
                  <td className={styles.accountMetricCell}>
                    {maxSessions > 0 ? `${activeSessions}/${maxSessions}` : '-'}
                  </td>
                  <td>
                    <div className={styles.accountQuality}>
                      <span>{requests} 请求</span>
                      <span>{requests > 0 ? `${Math.round(successRate)}%` : '-'}</span>
                      <span>429 {rateLimited}</span>
                    </div>
                  </td>
                  <td>
                    <span className={proxyUrl ? styles.accountProxyValue : styles.accountMutedValue}>
                      {proxyUrl || '默认'}
                    </span>
                  </td>
                  <td className={styles.accountMutedValue}>{lastUsed}</td>
                  <td>{renderQuotaChip(quota, 'five-hour')}</td>
                  <td>{renderQuotaChip(quota, 'seven-day')}</td>
                  <td className={styles.accountTableActionsCell}>
                    <div className={styles.accountTableActions}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={styles.accountIconButton}
                        onClick={() => setDetailFileName(file.name)}
                        title="查看详情"
                      >
                        <IconInfo size={15} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={styles.accountIconButton}
                        onClick={() => void refreshClaudeQuotaForFile(file)}
                        disabled={disableControls || file.disabled || quotaLoading}
                        loading={quotaLoading}
                        title="刷新额度"
                      >
                        {!quotaLoading && <IconRefreshCw size={15} />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={styles.accountIconButton}
                        onClick={() => openPrefixProxyEditor(file)}
                        disabled={disableControls || isRuntimeOnly}
                        title="账号设置"
                      >
                        <IconSettings size={15} />
                      </Button>
                      <Button
                        variant={file.disabled ? 'primary' : 'secondary'}
                        size="sm"
                        onClick={() => void handleStatusToggle(file, file.disabled === true)}
                        disabled={disableControls || statusUpdating[file.name] === true || isRuntimeOnly}
                        loading={statusUpdating[file.name] === true}
                      >
                        {file.disabled ? '启用' : '停用'}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderDetailDrawer = () => {
    if (!detailFile || typeof document === 'undefined') return null;

    const quota = claudeQuota[detailFile.name];
    const quality = readRecordField(detailFile, 'quality_24h', 'quality24h');
    const authMethod =
      readTextField(detailFile, 'auth_method_label', 'authMethodLabel') ||
      readTextField(detailFile, 'auth_source', 'authSource') ||
      '未知';
    const proxyUrl = readTextField(detailFile, 'proxy_url', 'proxyUrl') || '默认';
    const quotaLoading = quotaRefreshing[detailFile.name] === true || quota?.status === 'loading';
    const closeDrawer = () => setDetailFileName(null);

    return createPortal(
      <div className={styles.accountDrawerBackdrop} onMouseDown={closeDrawer}>
        <aside className={styles.accountDrawer} onMouseDown={(event) => event.stopPropagation()}>
          <div className={styles.accountDrawerHeader}>
            <div>
              <div className={styles.accountDrawerEyebrow}>账号详情</div>
              <h2>{getAccountDisplayName(detailFile)}</h2>
              <p>{detailFile.name}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className={styles.accountIconButton}
              onClick={closeDrawer}
              aria-label="关闭详情"
            >
              <IconX size={16} />
            </Button>
          </div>

          <div className={styles.accountDrawerBody}>
            <section className={styles.accountDrawerSection}>
              <div className={styles.accountDrawerSectionTitle}>运行状态</div>
              <div className={styles.accountDrawerGrid}>
                <div>
                  <span>状态</span>
                  {renderStatusBadge(detailFile)}
                </div>
                <div>
                  <span>认证方式</span>
                  <strong>{authMethod}</strong>
                </div>
                <div>
                  <span>代理</span>
                  <strong>{proxyUrl}</strong>
                </div>
                <div>
                  <span>有效期</span>
                  <strong>{formatTimeValue(detailFile['expires_at'] ?? detailFile.expiresAt)}</strong>
                </div>
                <div>
                  <span>最近使用</span>
                  <strong>{formatTimeValue(detailFile['last_used_at'] ?? detailFile.lastRefresh)}</strong>
                </div>
                <div>
                  <span>修改时间</span>
                  <strong>{formatModified(detailFile)}</strong>
                </div>
              </div>
              {getAuthFileStatusMessage(detailFile) && (
                <div className={styles.accountDrawerError}>
                  {getAuthFileStatusMessage(detailFile)}
                </div>
              )}
            </section>

            <section className={styles.accountDrawerSection}>
              <div className={styles.accountDrawerSectionHeader}>
                <div>
                  <div className={styles.accountDrawerSectionTitle}>订阅与额度</div>
                  <p>{quota?.status === 'success' ? planLabelFromQuota(quota) : '点击刷新后显示订阅和剩余额度'}</p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void refreshClaudeQuotaForFile(detailFile)}
                  disabled={disableControls || detailFile.disabled || quotaLoading}
                  loading={quotaLoading}
                >
                  刷新额度
                </Button>
              </div>
              {quota?.status === 'success' ? (
                <div className={styles.accountDrawerQuotaList}>
                  {quota.windows.map((item) => {
                    const remaining =
                      typeof item.usedPercent === 'number'
                        ? Math.max(0, Math.min(100, 100 - item.usedPercent))
                        : null;
                    return (
                      <div key={item.id} className={styles.accountDrawerQuotaRow}>
                        <span>{item.label}</span>
                        <strong>{remaining === null ? '-' : `${Math.round(remaining)}% 剩余`}</strong>
                        <small>{item.resetLabel || '重置时间未知'}</small>
                      </div>
                    );
                  })}
                </div>
              ) : quota?.status === 'error' ? (
                <div className={styles.accountDrawerError}>{quota.error || '额度刷新失败'}</div>
              ) : (
                <div className={styles.accountDrawerEmpty}>尚未刷新额度</div>
              )}
            </section>

            <section className={styles.accountDrawerSection}>
              <div className={styles.accountDrawerSectionTitle}>24h 质量</div>
              <div className={styles.accountDrawerGrid}>
                <div>
                  <span>请求</span>
                  <strong>{getQualityNumber(quality, 'requests')}</strong>
                </div>
                <div>
                  <span>成功</span>
                  <strong>{getQualityNumber(quality, 'success')}</strong>
                </div>
                <div>
                  <span>失败</span>
                  <strong>{getQualityNumber(quality, 'failed')}</strong>
                </div>
                <div>
                  <span>429</span>
                  <strong>{getQualityNumber(quality, 'rate_limited')}</strong>
                </div>
              </div>
            </section>

            <section className={styles.accountDrawerActions}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleDownload(detailFile.name)}
                disabled={disableControls}
              >
                <IconDownload size={15} />
                下载
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => openPrefixProxyEditor(detailFile)}
                disabled={disableControls || isRuntimeOnlyAuthFile(detailFile)}
              >
                <IconSettings size={15} />
                设置
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  closeDrawer();
                  void handleDelete(detailFile.name);
                }}
                disabled={disableControls || deleting === detailFile.name}
              >
                <IconTrash2 size={15} />
                删除
              </Button>
            </section>
          </div>
        </aside>
      </div>,
      document.body
    );
  };

  const openExcludedEditor = useCallback(
    (provider?: string) => {
      const providerValue = (provider || (filter !== 'all' ? String(filter) : '')).trim();
      const params = new URLSearchParams();
      if (providerValue) {
        params.set('provider', providerValue);
      }
      const nextSearch = params.toString();
      navigate(`/auth-files/oauth-excluded${nextSearch ? `?${nextSearch}` : ''}`, {
        state: { fromAuthFiles: true },
      });
    },
    [filter, navigate]
  );

  const openModelAliasEditor = useCallback(
    (provider?: string) => {
      const providerValue = (provider || (filter !== 'all' ? String(filter) : '')).trim();
      const params = new URLSearchParams();
      if (providerValue) {
        params.set('provider', providerValue);
      }
      const nextSearch = params.toString();
      navigate(`/auth-files/oauth-model-alias${nextSearch ? `?${nextSearch}` : ''}`, {
        state: { fromAuthFiles: true },
      });
    },
    [filter, navigate]
  );

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;

    const actionsEl = floatingBatchActionsRef.current;
    if (!actionsEl) {
      document.documentElement.style.removeProperty('--auth-files-action-bar-height');
      return;
    }

    const updatePadding = () => {
      const height = actionsEl.getBoundingClientRect().height;
      document.documentElement.style.setProperty('--auth-files-action-bar-height', `${height}px`);
    };

    updatePadding();
    window.addEventListener('resize', updatePadding);

    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePadding);
    ro?.observe(actionsEl);

    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', updatePadding);
      document.documentElement.style.removeProperty('--auth-files-action-bar-height');
    };
  }, [batchActionBarVisible, selectionCount]);

  useEffect(() => {
    selectionCountRef.current = selectionCount;
    if (selectionCount > 0) {
      setBatchActionBarVisible(true);
    }
  }, [selectionCount]);

  useLayoutEffect(() => {
    if (!batchActionBarVisible) return;
    const currentCount = selectionCount;
    const previousCount = previousSelectionCountRef.current;
    const actionsEl = floatingBatchActionsRef.current;
    if (!actionsEl) return;

    batchActionAnimationRef.current?.stop();
    batchActionAnimationRef.current = null;

    if (currentCount > 0 && previousCount === 0) {
      batchActionAnimationRef.current = animate(
        actionsEl,
        {
          transform: [BATCH_BAR_HIDDEN_TRANSFORM, BATCH_BAR_BASE_TRANSFORM],
          opacity: [0, 1],
        },
        {
          duration: 0.28,
          ease: easePower3Out,
          onComplete: () => {
            actionsEl.style.transform = BATCH_BAR_BASE_TRANSFORM;
            actionsEl.style.opacity = '1';
          },
        }
      );
    } else if (currentCount === 0 && previousCount > 0) {
      batchActionAnimationRef.current = animate(
        actionsEl,
        {
          transform: [BATCH_BAR_BASE_TRANSFORM, BATCH_BAR_HIDDEN_TRANSFORM],
          opacity: [1, 0],
        },
        {
          duration: 0.22,
          ease: easePower2In,
          onComplete: () => {
            if (selectionCountRef.current === 0) {
              setBatchActionBarVisible(false);
            }
          },
        }
      );
    }

    previousSelectionCountRef.current = currentCount;
  }, [batchActionBarVisible, selectionCount]);

  useEffect(
    () => () => {
      batchActionAnimationRef.current?.stop();
      batchActionAnimationRef.current = null;
    },
    []
  );

  const renderFilterTags = () => (
    <div className={styles.filterRail}>
      <div className={styles.filterTags}>
        {existingTypes.map((type) => {
          const isActive = normalizedFilter === type;
          const iconSrc = getAuthFileIcon(type, resolvedTheme);
          const color =
            type === 'all'
              ? { bg: 'var(--bg-tertiary)', text: 'var(--text-primary)' }
              : getTypeColor(type, resolvedTheme);
          const buttonStyle = {
            '--filter-color': color.text,
            '--filter-surface': color.bg,
            '--filter-active-text': resolvedTheme === 'dark' ? '#111827' : '#ffffff',
          } as CSSProperties;

          return (
            <button
              key={type}
              className={`${styles.filterTag} ${isActive ? styles.filterTagActive : ''}`}
              style={buttonStyle}
              onClick={() => {
                setFilter(type);
                setPage(1);
              }}
            >
              <span className={styles.filterTagLabel}>
                {type === 'all' ? (
                  <span className={`${styles.filterTagIconWrap} ${styles.filterAllIconWrap}`}>
                    <IconFilterAll className={styles.filterAllIcon} size={16} />
                  </span>
                ) : (
                  <span className={styles.filterTagIconWrap}>
                    {iconSrc ? (
                      <img src={iconSrc} alt="" className={styles.filterTagIcon} />
                    ) : (
                      <span className={styles.filterTagIconFallback}>
                        {getTypeLabel(t, type).slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </span>
                )}
                <span className={styles.filterTagText}>{getTypeLabel(t, type)}</span>
              </span>
              <span className={styles.filterTagCount}>{typeCounts[type] ?? 0}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const titleNode = (
    <div className={styles.titleWrapper}>
      <span>{t('auth_files.title_section')}</span>
      {files.length > 0 && <span className={styles.countBadge}>{files.length}</span>}
    </div>
  );

  const deleteAllButtonLabel = (() => {
    if (disabledOnly) {
      return t('auth_files.delete_filtered_result_button');
    }
    if (problemOnly) {
      return normalizedFilter === 'all'
        ? t('auth_files.delete_problem_button')
        : t('auth_files.delete_problem_button_with_type', {
            type: getTypeLabel(t, normalizedFilter),
          });
    }
    return normalizedFilter === 'all'
      ? t('auth_files.delete_all_button')
      : `${t('common.delete')} ${getTypeLabel(t, normalizedFilter)}`;
  })();

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>{t('auth_files.title')}</h1>
        <p className={styles.description}>{t('auth_files.description')}</p>
      </div>

      <Card
        title={titleNode}
        extra={
          <div className={styles.headerActions}>
            <Button variant="secondary" size="sm" onClick={handleHeaderRefresh} disabled={loading}>
              {t('common.refresh')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void probeClaudeAccounts()}
              disabled={disableControls || claudeProbeRunning}
              loading={claudeProbeRunning}
            >
              一键检测 Claude
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => clearClaudeRuntimeSessions()}
              disabled={disableControls || clearingRuntimeSessions}
              loading={clearingRuntimeSessions}
            >
              清会话
            </Button>
            <Button
              size="sm"
              onClick={handleUploadClick}
              disabled={disableControls || uploading}
              loading={uploading}
            >
              {t('auth_files.upload_button')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() =>
                handleDeleteAll({
                  filter,
                  problemOnly,
                  disabledOnly,
                  onResetFilterToAll: () => setFilter('all'),
                  onResetProblemOnly: () => setProblemOnly(false),
                  onResetDisabledOnly: () => setDisabledOnly(false),
                })
              }
              disabled={disableControls || loading || deletingAll}
              loading={deletingAll}
            >
              {deleteAllButtonLabel}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
          </div>
        }
      >
        {error && <div className={styles.errorBox}>{error}</div>}
        {claudeProbeJob && (
          <div className={styles.claudeProbePanel}>
            <div className={styles.claudeProbeHeader}>
              <div>
                <div className={styles.claudeProbeTitle}>Claude 账号可用性检测</div>
                <div className={styles.claudeProbeSubtitle}>
                  {claudeProbeJob.status === 'running' || claudeProbeJob.status === 'canceling'
                    ? `正在检测 ${claudeProbeJob.completed}/${claudeProbeJob.total}`
                    : `检测结束 ${claudeProbeJob.completed}/${claudeProbeJob.total}`}
                </div>
              </div>
              {claudeProbeRunning && (
                <Button variant="ghost" size="sm" onClick={() => void cancelClaudeProbe()}>
                  取消
                </Button>
              )}
            </div>
            <div className={styles.claudeProbeProgress}>
              <div
                className={styles.claudeProbeProgressFill}
                style={{ width: `${claudeProbePercent}%` }}
              />
            </div>
            <div className={styles.claudeProbeStats}>
              <span>可用 {claudeProbeJob.ok}</span>
              <span>异常 {claudeProbeJob.failed}</span>
              <span>封禁/停用 {claudeProbeJob.disabled}</span>
              <span>认证失效 {claudeProbeJob.auth_expired}</span>
              <span>限额冷却 {claudeProbeJob.quota_cooldown}</span>
              <span>429 {claudeProbeJob.rate_limited}</span>
            </div>
            {claudeProbeProblemResults.length > 0 && (
              <div className={styles.claudeProbeProblems}>
                {claudeProbeProblemResults.slice(0, 6).map((item) => (
                  <div key={`${item.name}-${item.status}`} className={styles.claudeProbeProblem}>
                    <span className={styles.claudeProbeProblemName}>{item.name}</span>
                    <span className={styles.claudeProbeProblemStatus}>{item.status}</span>
                    {item.message && (
                      <span className={styles.claudeProbeProblemMessage}>{item.message}</span>
                    )}
                  </div>
                ))}
                {claudeProbeProblemResults.length > 6 && (
                  <div className={styles.claudeProbeMore}>
                    还有 {claudeProbeProblemResults.length - 6} 个异常账号，检测结束后可用筛选查看。
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className={styles.filterSection}>
          <div className={styles.accountOpsStrip}>
            <div className={styles.accountOpsCard}>
              <span>账号总数</span>
              <strong>{accountSummary.total}</strong>
              <small>当前筛选 {sorted.length}</small>
            </div>
            <div className={styles.accountOpsCard}>
              <span>可用账号</span>
              <strong>{accountSummary.available}</strong>
              <small>异常 {accountSummary.problem}</small>
            </div>
            <div className={styles.accountOpsCard}>
              <span>限额/会话</span>
              <strong>{accountSummary.quota + accountSummary.sessionFull}</strong>
              <small>
                限额 {accountSummary.quota} · 新会话满 {accountSummary.sessionFull}
              </small>
            </div>
            <div className={styles.accountOpsCard}>
              <span>认证风险</span>
              <strong>{accountSummary.authExpired + accountSummary.disabled}</strong>
              <small>
                认证失效 {accountSummary.authExpired} · 停用 {accountSummary.disabled}
              </small>
            </div>
            <div className={styles.accountOpsCard}>
              <span>代理覆盖</span>
              <strong>
                {accountSummary.total > 0
                  ? `${Math.round((accountSummary.proxied / accountSummary.total) * 100)}%`
                  : '-'}
              </strong>
              <small>{accountSummary.proxied} 个账号配置代理</small>
            </div>
            <div className={styles.accountOpsCard}>
              <span>24h 成功率</span>
              <strong>
                {accountSummary.successRate === null ? '-' : `${accountSummary.successRate}%`}
              </strong>
              <small>按已有请求样本统计</small>
            </div>
          </div>

          {renderFilterTags()}

          <div className={styles.filterContent}>
            <div className={styles.filterControlsPanel}>
              <div className={styles.filterControls}>
                <div className={`${styles.filterItem} ${styles.filterSearchItem}`}>
                  <label>{t('auth_files.search_label')}</label>
                  <Input
                    className={styles.searchInput}
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(1);
                    }}
                    placeholder={t('auth_files.search_placeholder')}
                    rightElement={<IconSearch className={styles.searchIcon} size={18} />}
                  />
                </div>
                <div className={styles.filterItem}>
                  <label>{t('auth_files.page_size_label')}</label>
                  <input
                    className={styles.pageSizeSelect}
                    type="number"
                    min={accountViewMode === 'table' ? MIN_TABLE_PAGE_SIZE : MIN_CARD_PAGE_SIZE}
                    max={accountViewMode === 'table' ? MAX_TABLE_PAGE_SIZE : MAX_CARD_PAGE_SIZE}
                    step={1}
                    value={pageSizeInput}
                    onChange={handlePageSizeChange}
                    onBlur={(e) => commitPageSizeInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.currentTarget.blur();
                      }
                    }}
                  />
                </div>
                <div className={styles.filterItem}>
                  <label>{t('auth_files.sort_label')}</label>
                  <Select
                    className={styles.sortSelect}
                    value={sortMode}
                    options={sortOptions}
                    onChange={handleSortModeChange}
                    ariaLabel={t('auth_files.sort_label')}
                    fullWidth
                  />
                </div>
                <div className={styles.filterItem}>
                  <label>账号状态</label>
                  <Select
                    className={styles.sortSelect}
                    value={accountStatusFilter}
                    options={accountStatusOptions}
                    onChange={(value) => {
                      setAccountStatusFilter(value as AccountStatusFilter);
                      setPage(1);
                    }}
                    ariaLabel="账号状态"
                    fullWidth
                  />
                </div>
                <div className={styles.filterItem}>
                  <label>订阅</label>
                  <Select
                    className={styles.sortSelect}
                    value={subscriptionFilter}
                    options={subscriptionOptions}
                    onChange={(value) => {
                      setSubscriptionFilter(value as SubscriptionFilter);
                      setPage(1);
                    }}
                    ariaLabel="订阅筛选"
                    fullWidth
                  />
                </div>
                <div className={styles.filterItem}>
                  <label>代理</label>
                  <Select
                    className={styles.sortSelect}
                    value={proxyFilter}
                    options={proxyOptions}
                    onChange={(value) => {
                      setProxyFilter(value as ProxyFilter);
                      setPage(1);
                    }}
                    ariaLabel="代理筛选"
                    fullWidth
                  />
                </div>
                <div className={styles.filterItem}>
                  <label>视图</label>
                  <div className={styles.accountViewSwitch}>
                    <Button
                      variant={accountViewMode === 'table' ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() => {
                        setAccountViewMode('table');
                        setPage(1);
                      }}
                    >
                      列表
                    </Button>
                    <Button
                      variant={accountViewMode === 'cards' ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() => {
                        setAccountViewMode('cards');
                        setPage(1);
                      }}
                    >
                      卡片
                    </Button>
                  </div>
                </div>
                <div className={`${styles.filterItem} ${styles.filterToggleItem}`}>
                  <label>{t('auth_files.display_options_label')}</label>
                  <div className={styles.filterToggleGroup}>
                    <div className={styles.filterToggleCard}>
                      <ToggleSwitch
                        checked={problemOnly}
                        onChange={(value) => {
                          setProblemOnly(value);
                          setPage(1);
                        }}
                        ariaLabel={t('auth_files.problem_filter_only')}
                        label={
                          <span className={styles.filterToggleLabel}>
                            {t('auth_files.problem_filter_only')}
                          </span>
                        }
                      />
                    </div>
                    <div className={styles.filterToggleCard}>
                      <ToggleSwitch
                        checked={disabledOnly}
                        onChange={(value) => {
                          setDisabledOnly(value);
                          setPage(1);
                        }}
                        ariaLabel={t('auth_files.disabled_filter_only')}
                        label={
                          <span className={styles.filterToggleLabel}>
                            {t('auth_files.disabled_filter_only')}
                          </span>
                        }
                      />
                    </div>
                    <div className={styles.filterToggleCard}>
                      <ToggleSwitch
                        checked={lowQuotaOnly}
                        onChange={(value) => {
                          setLowQuotaOnly(value);
                          setPage(1);
                        }}
                        ariaLabel="只看低余量账号"
                        label={<span className={styles.filterToggleLabel}>只看低余量</span>}
                      />
                    </div>
                    <div className={styles.filterToggleCard}>
                      <ToggleSwitch
                        checked={compactMode}
                        onChange={(value) => setCompactMode(value)}
                        ariaLabel={t('auth_files.compact_mode_label')}
                        label={
                          <span className={styles.filterToggleLabel}>
                            {t('auth_files.compact_mode_label')}
                          </span>
                        }
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {loading ? (
              <div className={styles.hint}>{t('common.loading')}</div>
            ) : pageItems.length === 0 ? (
              <EmptyState
                title={t('auth_files.search_empty_title')}
                description={t('auth_files.search_empty_desc')}
              />
            ) : accountViewMode === 'table' ? (
              renderAccountTable()
            ) : (
              <div
                className={`${styles.fileGrid} ${quotaFilterType ? styles.fileGridQuotaManaged : ''} ${compactMode ? styles.fileGridCompact : ''}`}
              >
                {pageItems.map((file) => (
                  <AuthFileCard
                    key={file.name}
                    file={file}
                    compact={compactMode}
                    selected={selectedFiles.has(file.name)}
                    resolvedTheme={resolvedTheme}
                    disableControls={disableControls}
                    deleting={deleting}
                    statusUpdating={statusUpdating}
                    quotaFilterType={quotaFilterType}
                    statusBarCache={statusBarCache}
                    onShowModels={showModels}
                    onDownload={handleDownload}
                    onOpenPrefixProxyEditor={openPrefixProxyEditor}
                    onDelete={handleDelete}
                    onToggleStatus={handleStatusToggle}
                    onToggleSelect={toggleSelect}
                  />
                ))}
              </div>
            )}

            {!loading && sorted.length > pageSize && (
              <div className={styles.pagination}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage <= 1}
                >
                  {t('auth_files.pagination_prev')}
                </Button>
                <div className={styles.pageInfo}>
                  {t('auth_files.pagination_info', {
                    current: currentPage,
                    total: totalPages,
                    count: sorted.length,
                  })}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
                  disabled={currentPage >= totalPages}
                >
                  {t('auth_files.pagination_next')}
                </Button>
              </div>
            )}
          </div>
        </div>
      </Card>

      <OAuthExcludedCard
        disableControls={disableControls}
        excludedError={excludedError}
        excluded={excluded}
        onAdd={() => openExcludedEditor()}
        onEdit={openExcludedEditor}
        onDelete={deleteExcluded}
      />

      <OAuthModelAliasCard
        disableControls={disableControls}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onAdd={() => openModelAliasEditor()}
        onEditProvider={openModelAliasEditor}
        onDeleteProvider={deleteModelAlias}
        modelAliasError={modelAliasError}
        modelAlias={modelAlias}
        allProviderModels={allProviderModels}
        onUpdate={handleMappingUpdate}
        onDeleteLink={handleDeleteLink}
        onToggleFork={handleToggleFork}
        onRenameAlias={handleRenameAlias}
        onDeleteAlias={handleDeleteAlias}
      />

      <AuthFileModelsModal
        open={modelsModalOpen}
        fileName={modelsFileName}
        fileType={modelsFileType}
        loading={modelsLoading}
        error={modelsError}
        models={modelsList}
        excluded={excluded}
        onClose={closeModelsModal}
        onCopyText={copyTextWithNotification}
      />

      <AuthFilesPrefixProxyEditorModal
        disableControls={disableControls}
        editor={prefixProxyEditor}
        updatedText={prefixProxyUpdatedText}
        dirty={prefixProxyDirty}
        onClose={closePrefixProxyEditor}
        onCopyText={copyTextWithNotification}
        onSave={handlePrefixProxySave}
        onChange={handlePrefixProxyChange}
      />

      {renderDetailDrawer()}

      {batchActionBarVisible && typeof document !== 'undefined'
        ? createPortal(
            <div className={styles.batchActionContainer} ref={floatingBatchActionsRef}>
              <div className={styles.batchActionBar}>
                <div className={styles.batchActionLeft}>
                  <span className={styles.batchSelectionText}>
                    {t('auth_files.batch_selected', { count: selectionCount })}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => selectAllVisible(pageItems)}
                    disabled={selectablePageItems.length === 0}
                  >
                    {t('auth_files.batch_select_page')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => selectAllVisible(sorted)}
                    disabled={selectableFilteredItems.length === 0}
                  >
                    {t('auth_files.batch_select_filtered')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => invertVisibleSelection(pageItems)}
                    disabled={selectablePageItems.length === 0}
                  >
                    {t('auth_files.batch_invert_page')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={deselectAll}>
                    {t('auth_files.batch_deselect')}
                  </Button>
                </div>
                <div className={styles.batchActionRight}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void probeClaudeAccounts(selectedNames)}
                    disabled={disableControls || selectedNames.length === 0 || claudeProbeRunning}
                  >
                    检测选中
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => clearClaudeRuntimeSessions(selectedNames)}
                    disabled={
                      disableControls ||
                      selectedNames.length === 0 ||
                      clearingRuntimeSessions
                    }
                    loading={clearingRuntimeSessions}
                  >
                    清选中会话
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void batchDownload(selectedNames)}
                    disabled={disableControls || selectedNames.length === 0}
                  >
                    {t('auth_files.batch_download')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => batchSetStatus(selectedNames, true)}
                    disabled={batchStatusButtonsDisabled}
                  >
                    {t('auth_files.batch_enable')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => batchSetStatus(selectedNames, false)}
                    disabled={batchStatusButtonsDisabled}
                  >
                    {t('auth_files.batch_disable')}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => batchDelete(selectedNames)}
                    disabled={disableControls || selectedNames.length === 0}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
