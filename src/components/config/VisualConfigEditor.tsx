import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconBot,
  IconChartLine,
  IconKey,
  IconSatellite,
  IconShield,
  type IconProps,
} from '@/components/ui/icons';
import { ConfigSection } from '@/components/config/ConfigSection';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import type {
  VisualConfigFieldPath,
  VisualConfigValidationErrorCode,
  VisualConfigValidationErrors,
  VisualConfigValues,
} from '@/types/visualConfig';
import styles from './VisualConfigEditor.module.scss';

type VisualSectionId = 'cloak' | 'cache' | 'retry' | 'routing' | 'transport';

type VisualSection = {
  id: VisualSectionId;
  title: string;
  icon: ComponentType<IconProps>;
  errorCount: number;
};

interface VisualConfigEditorProps {
  values: VisualConfigValues;
  validationErrors?: VisualConfigValidationErrors;
  hasPayloadValidationErrors?: boolean;
  disabled?: boolean;
  onChange: (values: Partial<VisualConfigValues>) => void;
}

function getValidationMessage(
  t: ReturnType<typeof useTranslation>['t'],
  errorCode?: VisualConfigValidationErrorCode
) {
  if (!errorCode) return undefined;
  return t(`config_management.visual.validation.${errorCode}`);
}

type ToggleRowProps = {
  title: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
};

function ToggleRow({ title, description, checked, disabled, onChange }: ToggleRowProps) {
  return (
    <div className={styles.toggleRow}>
      <div className={styles.toggleCopy}>
        <div className={styles.toggleTitle}>{title}</div>
        {description ? <div className={styles.toggleDescription}>{description}</div> : null}
      </div>
      <ToggleSwitch checked={checked} onChange={onChange} disabled={disabled} ariaLabel={title} />
    </div>
  );
}

function SectionGrid({ children }: { children: ReactNode }) {
  return <div className={styles.sectionGrid}>{children}</div>;
}

function SectionStack({ children }: { children: ReactNode }) {
  return <div className={styles.sectionStack}>{children}</div>;
}

function SectionSubsection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.subsection}>
      <div className={styles.subsectionHeader}>
        <h3 className={styles.subsectionTitle}>{title}</h3>
        {description ? <p className={styles.subsectionDescription}>{description}</p> : null}
      </div>
      {children}
    </div>
  );
}

function FieldShell({
  label,
  labelId,
  hint,
  hintId,
  children,
}: {
  label: string;
  labelId?: string;
  hint?: string;
  hintId?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.fieldShell}>
      <label id={labelId} className={styles.fieldLabel}>
        {label}
      </label>
      {children}
      {hint ? (
        <div id={hintId} className={styles.fieldHint}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

function StrategyMetric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'good' | 'warn';
}) {
  return (
    <div className={`${styles.strategyMetric} ${styles[`strategyMetric_${tone}`]}`}>
      <span className={styles.strategyMetricLabel}>{label}</span>
      <strong className={styles.strategyMetricValue}>{value}</strong>
    </div>
  );
}

function StatusList({ items }: { items: Array<{ label: string; active: boolean }> }) {
  return (
    <div className={styles.statusList}>
      {items.map((item) => (
        <span
          key={item.label}
          className={`${styles.statusChip} ${item.active ? styles.statusChipActive : ''}`}
        >
          {item.label}
        </span>
      ))}
    </div>
  );
}

function retryCredentialText(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '0') return '全部可用账号';
  return `${trimmed} 个账号`;
}

function disabledText(value: string) {
  const trimmed = value.trim();
  return !trimmed || trimmed === '0' ? '关闭' : `${trimmed} 秒`;
}

function quotaThresholdText(fiveHour: string, weekly: string) {
  const fiveHourText = fiveHour.trim() || '20';
  const weeklyText = weekly.trim() || '10';
  return `5h ${fiveHourText}% / 周 ${weeklyText}%`;
}

export function VisualConfigEditor({
  values,
  validationErrors,
  disabled = false,
  onChange,
}: VisualConfigEditorProps) {
  const { t } = useTranslation();
  const isMobile = useMediaQuery('(max-width: 768px)');
  const routingStrategyLabelId = useId();
  const routingStrategyHintId = `${routingStrategyLabelId}-hint`;
  const disableImageGenerationLabelId = useId();
  const disableImageGenerationHintId = `${disableImageGenerationLabelId}-hint`;
  const [activeSectionId, setActiveSectionId] = useState<VisualSectionId>('cloak');
  const sectionRefs = useRef<Partial<Record<VisualSectionId, HTMLElement | null>>>({});
  const mobileNavScrollerRef = useRef<HTMLDivElement | null>(null);
  const mobileNavButtonRefs = useRef<Partial<Record<VisualSectionId, HTMLButtonElement | null>>>(
    {}
  );

  const requestRetryError = getValidationMessage(t, validationErrors?.requestRetry);
  const claudeMimicryGuardEventsLimitError = getValidationMessage(
    t,
    validationErrors?.claudeMimicryGuardEventsLimit
  );
  const maxRetryCredentialsError = getValidationMessage(t, validationErrors?.maxRetryCredentials);
  const maxRetryIntervalError = getValidationMessage(t, validationErrors?.maxRetryInterval);
  const claudeQuotaFiveHourError = getValidationMessage(
    t,
    validationErrors?.claudeQuotaFiveHourRemainingPercent
  );
  const claudeQuotaWeeklyError = getValidationMessage(
    t,
    validationErrors?.claudeQuotaWeeklyRemainingPercent
  );
  const authAutoRefreshWorkersError = getValidationMessage(
    t,
    validationErrors?.authAutoRefreshWorkers
  );
  const keepaliveError = getValidationMessage(t, validationErrors?.['streaming.keepaliveSeconds']);
  const bootstrapRetriesError = getValidationMessage(
    t,
    validationErrors?.['streaming.bootstrapRetries']
  );
  const nonstreamKeepaliveError = getValidationMessage(
    t,
    validationErrors?.['streaming.nonstreamKeepaliveInterval']
  );

  const countErrors = useCallback(
    (fields: VisualConfigFieldPath[]) =>
      fields.reduce((total, field) => total + (validationErrors?.[field] ? 1 : 0), 0),
    [validationErrors]
  );

  const sections = useMemo<VisualSection[]>(
    () => [
      {
        id: 'cloak',
        title: 'Claude Code 伪装',
        icon: IconBot,
        errorCount: countErrors(['claudeMimicryGuardEventsLimit']),
      },
      {
        id: 'cache',
        title: '缓存命中',
        icon: IconChartLine,
        errorCount: 0,
      },
      {
        id: 'retry',
        title: '失败重试',
        icon: IconShield,
        errorCount: countErrors([
          'requestRetry',
          'maxRetryCredentials',
          'maxRetryInterval',
          'claudeQuotaFiveHourRemainingPercent',
          'claudeQuotaWeeklyRemainingPercent',
          'authAutoRefreshWorkers',
        ]),
      },
      {
        id: 'routing',
        title: '账号切换',
        icon: IconKey,
        errorCount: 0,
      },
      {
        id: 'transport',
        title: '请求适配',
        icon: IconSatellite,
        errorCount: countErrors([
          'streaming.keepaliveSeconds',
          'streaming.bootstrapRetries',
          'streaming.nonstreamKeepaliveInterval',
        ]),
      },
    ],
    [countErrors]
  );

  const activeSection = sections.find((section) => section.id === activeSectionId) ?? sections[0];
  const hasValidationIssues = sections.some((section) => section.errorCount > 0);
  const routingStrategyLabel =
    values.routingStrategy === 'fill-first' ? '填满优先' : '轮询均衡';
  const coolingEnabled = !values.disableCooling;
  const stableFingerprintEnabled = values.claudeHeaderStabilizeDeviceProfile;
  const affinityEnabled = values.routingSessionAffinity;

  const disableImageGenerationOptions = useMemo(
    () => [
      { value: 'false', label: '允许图像请求' },
      { value: 'true', label: '拦截全部图像请求' },
      { value: 'chat', label: '仅拦截聊天端点注入' },
    ],
    []
  );
  const mimicryGuardModeOptions = useMemo(
    () => [
      { value: 'degrade', label: '自动修复并保护' },
      { value: 'strict', label: '严格阻断异常' },
      { value: 'observe', label: '仅记录不阻断' },
    ],
    []
  );

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleEntries = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => right.intersectionRatio - left.intersectionRatio);

        if (visibleEntries.length === 0) return;
        setActiveSectionId(visibleEntries[0].target.id as VisualSectionId);
      },
      {
        rootMargin: '-18% 0px -58% 0px',
        threshold: [0.12, 0.3, 0.55],
      }
    );

    for (const section of sections) {
      const element = sectionRefs.current[section.id];
      if (element) observer.observe(element);
    }

    return () => observer.disconnect();
  }, [sections]);

  useEffect(() => {
    if (!isMobile) return;
    const scroller = mobileNavScrollerRef.current;
    const button = mobileNavButtonRefs.current[activeSectionId];
    if (!scroller || !button) return;

    const scrollerRect = scroller.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const centeredLeft =
      scroller.scrollLeft +
      (buttonRect.left - scrollerRect.left) -
      (scroller.clientWidth - buttonRect.width) / 2;
    const maxScrollLeft = Math.max(scroller.scrollWidth - scroller.clientWidth, 0);
    const targetLeft = Math.min(Math.max(centeredLeft, 0), maxScrollLeft);

    scroller.scrollTo({ left: targetLeft, behavior: 'smooth' });
  }, [activeSectionId, isMobile]);

  const handleSectionJump = useCallback((sectionId: VisualSectionId) => {
    setActiveSectionId(sectionId);
    sectionRefs.current[sectionId]?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'start',
    });
  }, []);

  const navContent = (
    <div className={styles.navList}>
      {sections.map((section, index) => {
        const Icon = section.icon;

        return (
          <button
            key={section.id}
            type="button"
            className={`${styles.navButton} ${
              activeSectionId === section.id ? styles.navButtonActive : ''
            }`}
            onClick={() => handleSectionJump(section.id)}
          >
            <span className={styles.navIndex}>{String(index + 1).padStart(2, '0')}</span>
            <span className={styles.navMain}>
              <span className={styles.navHeadingRow}>
                <span className={styles.navLabelWrap}>
                  <span className={styles.navIcon}>
                    <Icon size={14} />
                  </span>
                  <span className={styles.navLabel}>{section.title}</span>
                </span>
                {section.errorCount > 0 ? (
                  <span className={styles.navBadge} aria-hidden="true">
                    {section.errorCount}
                  </span>
                ) : null}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className={styles.visualEditor}>
      <div className={styles.strategyHero}>
        <div className={styles.strategyHeroCopy}>
          <span className={styles.overviewPill}>Claude 账号池策略</span>
          <h2 className={styles.strategyHeroTitle}>把流量统一整理成更像 Claude Code 的请求</h2>
          <p className={styles.strategyHeroText}>
            这里集中调整全局伪装指纹、缓存命中、失败重试和账号切换。每个账号的代理 IP、
            启用状态和账号级伪装开关仍在账号池页面单独管理。
          </p>
        </div>
        <div className={styles.strategyMetrics}>
          <StrategyMetric
            label="指纹"
            value={stableFingerprintEnabled ? '稳定' : '跟随客户端'}
            tone={stableFingerprintEnabled ? 'good' : 'warn'}
          />
          <StrategyMetric
            label="缓存"
            value={affinityEnabled ? '命中优先' : '均衡优先'}
            tone={affinityEnabled ? 'good' : 'neutral'}
          />
          <StrategyMetric label="换号" value={routingStrategyLabel} />
          <StrategyMetric label="重试账号" value={retryCredentialText(values.maxRetryCredentials)} />
          <StrategyMetric
            label="限额保护"
            value={quotaThresholdText(
              values.claudeQuotaFiveHourRemainingPercent,
              values.claudeQuotaWeeklyRemainingPercent
            )}
          />
        </div>
      </div>

      <div className={styles.overview}>
        <div className={styles.overviewHeader}>
          <div className={styles.overviewMeta}>
            <span className={styles.overviewPill}>快速跳转</span>
            <span className={styles.overviewPill}>{activeSection?.title}</span>
            {hasValidationIssues ? (
              <span className={`${styles.overviewPill} ${styles.overviewPillWarning}`}>
                {t('config_management.visual.validation.validation_blocked')}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className={styles.workspace}>
        {isMobile ? (
          <div className={styles.mobileSectionNav}>
            <div
              ref={mobileNavScrollerRef}
              className={styles.mobileSectionNavScroller}
              aria-label="快速跳转"
            >
              {sections.map((section, index) => (
                <button
                  key={section.id}
                  ref={(node) => {
                    mobileNavButtonRefs.current[section.id] = node;
                  }}
                  type="button"
                  className={`${styles.mobileSectionNavButton} ${
                    activeSectionId === section.id ? styles.mobileSectionNavButtonActive : ''
                  }`}
                  onClick={() => handleSectionJump(section.id)}
                >
                  <span className={styles.mobileSectionNavIndex}>
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className={styles.mobileSectionNavLabel}>{section.title}</span>
                  {section.errorCount > 0 ? (
                    <span className={styles.mobileSectionNavBadge} aria-hidden="true">
                      {section.errorCount}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <aside className={styles.sidebar}>
          <div className={styles.sidebarRail}>{navContent}</div>
        </aside>

        <div className={styles.sections}>
          <ConfigSection
            id="cloak"
            ref={(node) => {
              sectionRefs.current.cloak = node;
            }}
            indexLabel="01"
            icon={<IconBot size={16} />}
            title="Claude Code 伪装"
            description="全局默认 Header 指纹，用于 OAuth 账号和 Claude Code 兼容请求。"
          >
            <SectionStack>
              <StatusList
                items={[
                  { label: 'Claude CLI User-Agent', active: Boolean(values.claudeHeaderUserAgent) },
                  { label: 'Package/Runtime 指纹', active: Boolean(values.claudeHeaderPackageVersion || values.claudeHeaderRuntimeVersion) },
                  { label: '设备指纹稳定', active: stableFingerprintEnabled },
                  { label: '账号级 user_id 缓存', active: true },
                ]}
              />
              <SectionGrid>
                <Input
                  label="User-Agent"
                  placeholder="claude-cli/2.1.148 (external, cli)"
                  value={values.claudeHeaderUserAgent}
                  onChange={(e) => onChange({ claudeHeaderUserAgent: e.target.value })}
                  disabled={disabled}
                />
                <Input
                  label="Package Version"
                  placeholder="0.98.0"
                  value={values.claudeHeaderPackageVersion}
                  onChange={(e) => onChange({ claudeHeaderPackageVersion: e.target.value })}
                  disabled={disabled}
                />
                <Input
                  label="Runtime Version"
                  placeholder="v24.13.0"
                  value={values.claudeHeaderRuntimeVersion}
                  onChange={(e) => onChange({ claudeHeaderRuntimeVersion: e.target.value })}
                  disabled={disabled}
                />
                <Input
                  label="Timeout"
                  placeholder="600"
                  value={values.claudeHeaderTimeout}
                  onChange={(e) => onChange({ claudeHeaderTimeout: e.target.value })}
                  disabled={disabled}
                />
              </SectionGrid>
              <SectionGrid>
                <Input
                  label="OS"
                  placeholder="MacOS"
                  value={values.claudeHeaderOs}
                  onChange={(e) => onChange({ claudeHeaderOs: e.target.value })}
                  disabled={disabled}
                />
                <Input
                  label="Arch"
                  placeholder="arm64"
                  value={values.claudeHeaderArch}
                  onChange={(e) => onChange({ claudeHeaderArch: e.target.value })}
                  disabled={disabled}
                />
                <ToggleRow
                  title="稳定设备指纹"
                  description="同一个账号保持固定 OS/Arch 和软件指纹，减少请求前后漂移。"
                  checked={stableFingerprintEnabled}
                  disabled={disabled}
                  onChange={(claudeHeaderStabilizeDeviceProfile) =>
                    onChange({ claudeHeaderStabilizeDeviceProfile })
                  }
                />
                <FieldShell
                  label="伪装守卫模式"
                  hint="自动修复并保护会放行可兼容请求、阻断明显泄露；严格模式会阻断未知工具等风险项。"
                >
                  <Select
                    value={values.claudeMimicryGuardMode}
                    options={mimicryGuardModeOptions}
                    disabled={disabled}
                    onChange={(nextValue) =>
                      onChange({
                        claudeMimicryGuardMode:
                          nextValue as VisualConfigValues['claudeMimicryGuardMode'],
                      })
                    }
                  />
                </FieldShell>
                <Input
                  label="诊断事件保留条数"
                  type="number"
                  min={1}
                  max={2000}
                  placeholder="500"
                  value={values.claudeMimicryGuardEventsLimit}
                  onChange={(e) => onChange({ claudeMimicryGuardEventsLimit: e.target.value })}
                  disabled={disabled}
                  hint="保存在内存里，用于按时间定位客户请求失败原因。"
                  error={claudeMimicryGuardEventsLimitError}
                />
              </SectionGrid>
            </SectionStack>
          </ConfigSection>

          <ConfigSection
            id="cache"
            ref={(node) => {
              sectionRefs.current.cache = node;
            }}
            indexLabel="02"
            icon={<IconChartLine size={16} />}
            title="缓存命中"
            description="提高 prompt cache 和会话复用的稳定性。"
          >
            <SectionStack>
              <SectionGrid>
                <ToggleRow
                  title="会话粘性路由"
                  description="同一用户或会话优先绑定到同一个 Claude 账号，提高上下文与缓存复用。"
                  checked={values.routingSessionAffinity}
                  disabled={disabled}
                  onChange={(routingSessionAffinity) => onChange({ routingSessionAffinity })}
                />
                <Input
                  label="会话绑定 TTL"
                  placeholder="1h"
                  value={values.routingSessionAffinityTTL}
                  onChange={(e) => onChange({ routingSessionAffinityTTL: e.target.value })}
                  disabled={disabled}
                  hint="留空使用后端默认值。"
                />
                <Input
                  label="流式 Keepalive 秒数"
                  type="number"
                  placeholder="0"
                  value={values.streaming.keepaliveSeconds}
                  onChange={(e) =>
                    onChange({
                      streaming: { ...values.streaming, keepaliveSeconds: e.target.value },
                    })
                  }
                  disabled={disabled}
                  hint={`当前：${disabledText(values.streaming.keepaliveSeconds)}`}
                  error={keepaliveError}
                />
              </SectionGrid>
              <SectionSubsection
                title="账号级缓存锚点"
                description="Cookie/OAuth 导入的新账号默认启用稳定 user_id；老账号可在账号池页面逐个调整。"
              >
                <StatusList
                  items={[
                    { label: '导入账号默认稳定 user_id', active: true },
                    { label: '请求自动注入 cache_control', active: true },
                    { label: '最多保留 4 个缓存断点', active: true },
                    { label: 'TTL 顺序自动规整', active: true },
                  ]}
                />
              </SectionSubsection>
            </SectionStack>
          </ConfigSection>

          <ConfigSection
            id="retry"
            ref={(node) => {
              sectionRefs.current.retry = node;
            }}
            indexLabel="03"
            icon={<IconShield size={16} />}
            title="失败重试"
            description="上游报错、429 或账号不可用时的自动重试和冷却策略。"
          >
            <SectionStack>
              <SectionGrid>
                <Input
                  label="单账号请求重试次数"
                  type="number"
                  placeholder="3"
                  value={values.requestRetry}
                  onChange={(e) => onChange({ requestRetry: e.target.value })}
                  disabled={disabled}
                  error={requestRetryError}
                />
                <Input
                  label="最大换号重试范围"
                  type="number"
                  placeholder="0"
                  value={values.maxRetryCredentials}
                  onChange={(e) => onChange({ maxRetryCredentials: e.target.value })}
                  disabled={disabled}
                  hint="0 表示用完所有可用账号。"
                  error={maxRetryCredentialsError}
                />
                <Input
                  label="等待冷却账号上限秒数"
                  type="number"
                  placeholder="30"
                  value={values.maxRetryInterval}
                  onChange={(e) => onChange({ maxRetryInterval: e.target.value })}
                  disabled={disabled}
                  error={maxRetryIntervalError}
                />
                <Input
                  label="认证自动刷新 Worker 数"
                  type="number"
                  placeholder="16"
                  value={values.authAutoRefreshWorkers}
                  onChange={(e) => onChange({ authAutoRefreshWorkers: e.target.value })}
                  disabled={disabled}
                  hint="用于并发刷新 OAuth/File 账号 token。"
                  error={authAutoRefreshWorkersError}
                />
              </SectionGrid>
              <SectionSubsection
                title="订阅额度保护"
                description="额度剩余达到阈值时，账号进入限额冷却并等待对应窗口重置。"
              >
                <SectionGrid>
                  <Input
                    label="5 小时窗口剩余阈值"
                    type="number"
                    min={0}
                    max={100}
                    placeholder="20"
                    value={values.claudeQuotaFiveHourRemainingPercent}
                    onChange={(e) =>
                      onChange({ claudeQuotaFiveHourRemainingPercent: e.target.value })
                    }
                    disabled={disabled}
                    hint="默认 20；填 0 表示只在 5h 额度用尽时冷却。"
                    error={claudeQuotaFiveHourError}
                  />
                  <Input
                    label="7 天窗口剩余阈值"
                    type="number"
                    min={0}
                    max={100}
                    placeholder="10"
                    value={values.claudeQuotaWeeklyRemainingPercent}
                    onChange={(e) =>
                      onChange({ claudeQuotaWeeklyRemainingPercent: e.target.value })
                    }
                    disabled={disabled}
                    hint="默认 10；适用于周限、Opus、Sonnet 等 7 天窗口。"
                    error={claudeQuotaWeeklyError}
                  />
                </SectionGrid>
              </SectionSubsection>
              <SectionGrid>
                <ToggleRow
                  title="启用失败冷却隔离"
                  description="429、过期、异常账号进入冷却或不可用状态，后续请求自动换号。"
                  checked={coolingEnabled}
                  disabled={disabled}
                  onChange={(enabled) => onChange({ disableCooling: !enabled })}
                />
                <ToggleRow
                  title="透传上游响应 Header"
                  description="向下游保留过滤后的上游 Header，便于客户端识别限流和缓存状态。"
                  checked={values.passthroughHeaders}
                  disabled={disabled}
                  onChange={(passthroughHeaders) => onChange({ passthroughHeaders })}
                />
              </SectionGrid>
            </SectionStack>
          </ConfigSection>

          <ConfigSection
            id="routing"
            ref={(node) => {
              sectionRefs.current.routing = node;
            }}
            indexLabel="04"
            icon={<IconKey size={16} />}
            title="账号切换"
            description="控制账号池如何选择账号、何时保持同账号、何时换账号。"
          >
            <SectionStack>
              <SectionGrid>
                <FieldShell
                  label="账号选择策略"
                  labelId={routingStrategyLabelId}
                  hint="轮询更均衡；填满优先会优先用当前账号直到不可用。"
                  hintId={routingStrategyHintId}
                >
                  <Select
                    value={values.routingStrategy}
                    options={[
                      { value: 'round-robin', label: '轮询均衡' },
                      { value: 'fill-first', label: '填满优先' },
                    ]}
                    id={`${routingStrategyLabelId}-select`}
                    disabled={disabled}
                    ariaLabelledBy={routingStrategyLabelId}
                    ariaDescribedBy={routingStrategyHintId}
                    onChange={(nextValue) =>
                      onChange({
                        routingStrategy: nextValue as VisualConfigValues['routingStrategy'],
                      })
                    }
                  />
                </FieldShell>
                <Input
                  label="全局代理 URL"
                  placeholder="socks5://user:pass@127.0.0.1:1080 或 direct"
                  value={values.proxyUrl}
                  onChange={(e) => onChange({ proxyUrl: e.target.value })}
                  disabled={disabled}
                  hint="支持 http://、https://、socks5://、socks5h://；账号级 proxy_url 可覆盖全局值，direct/none 表示强制直连。"
                />
                <ToggleRow
                  title="强制模型前缀"
                  description="有账号前缀时，未带前缀的请求只会走无前缀账号。"
                  checked={values.forceModelPrefix}
                  disabled={disabled}
                  onChange={(forceModelPrefix) => onChange({ forceModelPrefix })}
                />
              </SectionGrid>
              <div className={styles.strategyFlow}>
                <div>请求进入</div>
                <div>匹配模型/前缀</div>
                <div>{affinityEnabled ? '优先会话绑定' : '按池策略选择'}</div>
                <div>{coolingEnabled ? '跳过冷却账号' : '不做冷却隔离'}</div>
                <div>Claude 上游</div>
              </div>
            </SectionStack>
          </ConfigSection>

          <ConfigSection
            id="transport"
            ref={(node) => {
              sectionRefs.current.transport = node;
            }}
            indexLabel="05"
            icon={<IconSatellite size={16} />}
            title="请求适配"
            description="控制流式、非流式和特殊请求的稳定性。"
          >
            <SectionStack>
              <SectionGrid>
                <Input
                  label="流式启动重试次数"
                  type="number"
                  placeholder="1"
                  value={values.streaming.bootstrapRetries}
                  onChange={(e) =>
                    onChange({
                      streaming: { ...values.streaming, bootstrapRetries: e.target.value },
                    })
                  }
                  disabled={disabled}
                  hint="首包前失败时的 bootstrap 重试。"
                  error={bootstrapRetriesError}
                />
                <Input
                  label="非流式 Keepalive 间隔秒数"
                  type="number"
                  placeholder="0"
                  value={values.streaming.nonstreamKeepaliveInterval}
                  onChange={(e) =>
                    onChange({
                      streaming: {
                        ...values.streaming,
                        nonstreamKeepaliveInterval: e.target.value,
                      },
                    })
                  }
                  disabled={disabled}
                  hint={`当前：${disabledText(values.streaming.nonstreamKeepaliveInterval)}`}
                  error={nonstreamKeepaliveError}
                />
                <FieldShell
                  label="图像请求处理"
                  labelId={disableImageGenerationLabelId}
                  hint="账号池专注 Claude 文本与工具调用时，可限制图像入口。"
                  hintId={disableImageGenerationHintId}
                >
                  <Select
                    value={values.disableImageGeneration}
                    options={disableImageGenerationOptions}
                    id={`${disableImageGenerationLabelId}-select`}
                    disabled={disabled}
                    ariaLabelledBy={disableImageGenerationLabelId}
                    ariaDescribedBy={disableImageGenerationHintId}
                    onChange={(nextValue) =>
                      onChange({
                        disableImageGeneration:
                          nextValue as VisualConfigValues['disableImageGeneration'],
                      })
                    }
                  />
                </FieldShell>
              </SectionGrid>
              <SectionSubsection
                title="高级请求改写"
                description="复杂 payload 默认值、覆盖与过滤仍保留在 YAML 源码中，策略页只展示 Claude 反代需要快速调整的入口。"
              >
                <StatusList
                  items={[
                    { label: '通用 Chat/Responses 转 Claude', active: true },
                    { label: '第三方聊天格式转 Claude', active: true },
                    { label: 'Claude 原生透传', active: true },
                    { label: '工具名按 Claude Code 归一化', active: true },
                  ]}
                />
              </SectionSubsection>
            </SectionStack>
          </ConfigSection>
        </div>
      </div>
    </div>
  );
}
