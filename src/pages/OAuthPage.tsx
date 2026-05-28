import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ProxyPicker } from '@/components/proxy/ProxyPicker';
import { extractOAuthCallbackState, oauthApi } from '@/services/api/oauth';
import { proxyPoolApi, type ProxyPoolEntry } from '@/services/api/proxyPool';
import { useNotificationStore } from '@/stores';
import { copyToClipboard } from '@/utils/clipboard';
import { sanitizeSensitiveText } from '@/utils/displaySanitizer';
import styles from './OAuthPage.module.scss';
import iconClaude from '@/assets/icons/claude.svg';

type AuthStatus = 'idle' | 'waiting' | 'success' | 'error';

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return '操作失败';
}

function authMethodText(source?: string, label?: string): string {
  if (label?.trim()) return sanitizeSensitiveText(label.trim());
  switch (source?.trim()) {
    case 'claude_code_cli':
      return 'CLI OAuth';
    case 'claude_platform':
      return 'Platform OAuth';
    default:
      return '未知认证来源';
  }
}

export function OAuthPage() {
  const { showNotification } = useNotificationStore();
  const pollTimer = useRef<number | null>(null);
  const successResetTimer = useRef<number | null>(null);

  const [authUrl, setAuthUrl] = useState('');
  const [authState, setAuthState] = useState('');
  const [status, setStatus] = useState<AuthStatus>('idle');
  const [statusText, setStatusText] = useState('');
  const [starting, setStarting] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [callbackSubmitting, setCallbackSubmitting] = useState(false);
  const [sessionKey, setSessionKey] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');
  const [proxyPool, setProxyPool] = useState<ProxyPoolEntry[]>([]);
  const [cookieSubmitting, setCookieSubmitting] = useState(false);
  const [cookieResult, setCookieResult] = useState('');

  const loadProxyPool = useCallback(async () => {
    try {
      setProxyPool(await proxyPoolApi.list());
    } catch {
      setProxyPool([]);
    }
  }, []);

  const clearPollTimer = useCallback(() => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  useEffect(() => {
    loadProxyPool();
  }, [loadProxyPool]);

  useEffect(() => {
    return () => {
      clearPollTimer();
      if (successResetTimer.current !== null) {
        window.clearTimeout(successResetTimer.current);
      }
    };
  }, [clearPollTimer]);

  const markSuccess = useCallback(
    (message: string) => {
      clearPollTimer();
      setStatus('success');
      setStatusText(message);
      showNotification(message, 'success');
      if (successResetTimer.current !== null) {
        window.clearTimeout(successResetTimer.current);
      }
      successResetTimer.current = window.setTimeout(() => {
        setStatus('idle');
        setStatusText('');
      }, 5000);
    },
    [clearPollTimer, showNotification]
  );

  const pollStatus = useCallback(
    (state: string) => {
      clearPollTimer();
      pollTimer.current = window.setInterval(async () => {
        try {
          const result = await oauthApi.getAuthStatus(state);
          if (result.status === 'ok') {
            markSuccess(`OAuth 授权完成：${authMethodText(result.auth_source, result.auth_method_label)}`);
            void loadProxyPool();
          } else if (result.status === 'error') {
            clearPollTimer();
            setStatus('error');
            setStatusText(result.error ? sanitizeSensitiveText(result.error) : 'OAuth 授权失败');
          }
        } catch (error) {
          clearPollTimer();
          setStatus('error');
          setStatusText(sanitizeSensitiveText(errorMessage(error)));
        }
      }, 2000);
    },
    [clearPollTimer, loadProxyPool, markSuccess]
  );

  const startOAuth = async () => {
    setStarting(true);
    setStatus('waiting');
    setStatusText('正在创建 OAuth 授权链接');
    try {
      const result = await oauthApi.startAuth('anthropic', {
        proxyUrl: proxyUrl.trim() || undefined,
      });
      setAuthUrl(result.url);
      setAuthState(result.state || '');
      setStatusText('请在新窗口完成授权；跳到 localhost 后复制地址栏完整回调 URL 粘贴到下方');
      if (result.state) {
        pollStatus(result.state);
      }
      window.open(result.url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setStatus('error');
      setStatusText(sanitizeSensitiveText(errorMessage(error)));
      showNotification(`创建 OAuth 链接失败：${sanitizeSensitiveText(errorMessage(error))}`, 'error');
    } finally {
      setStarting(false);
    }
  };

  const submitCallback = async () => {
    if (!callbackUrl.trim()) {
      showNotification('请粘贴回调地址或 code/state 参数', 'error');
      return;
    }
    setCallbackSubmitting(true);
    try {
      const callbackInput = callbackUrl.trim();
      const result = await oauthApi.submitCallback('anthropic', callbackInput);
      const submittedState = result.state || extractOAuthCallbackState(callbackInput) || authState;
      setStatus('waiting');
      setStatusText('OAuth 回调已提交，正在换取 token 并写入账号池');
      showNotification('OAuth 回调已提交，正在等待后端完成换授权', 'success');
      if (submittedState) {
        setAuthState(submittedState);
        pollStatus(submittedState);
      }
      setCallbackUrl('');
    } catch (error) {
      setStatus('error');
      setStatusText(sanitizeSensitiveText(errorMessage(error)));
      showNotification(`提交回调失败：${sanitizeSensitiveText(errorMessage(error))}`, 'error');
    } finally {
      setCallbackSubmitting(false);
    }
  };

  const submitCookie = async () => {
    if (!sessionKey.trim()) {
      showNotification('请填写 sessionKey', 'error');
      return;
    }
    setCookieSubmitting(true);
    setCookieResult('');
    try {
      const result = await oauthApi.cookieAuthClaude({
        sessionKey: sessionKey.trim(),
        proxyUrl: proxyUrl.trim() || undefined,
      });
      const label = result.email || result.auth_file || '账号';
      const method = authMethodText(result.auth_source, result.auth_method_label);
      setCookieResult(`已导入 ${sanitizeSensitiveText(label)}，认证方式：${method}`);
      setSessionKey('');
      markSuccess(`Cookie 换授权完成：${method}`);
      void loadProxyPool();
    } catch (error) {
      showNotification(`Cookie 换授权失败：${sanitizeSensitiveText(errorMessage(error))}`, 'error');
    } finally {
      setCookieSubmitting(false);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <div>
          <h1 className={styles.pageTitle}>导入服务账号</h1>
          <p className={styles.cardHint}>
            OAuth 是授权协议，用来把服务账号换成可自动刷新的访问令牌；Cookie
            换授权是用官方站点的 sessionKey 完成同一件事。
          </p>
        </div>

        <Card
          title={
            <span className={styles.cardTitle}>
              <img src={iconClaude} alt="" className={styles.cardTitleIcon} />
              OAuth 导入
            </span>
          }
          extra={
            <Link to="/" className={styles.textLink}>
              返回账号池
            </Link>
          }
        >
          <div className={styles.cardContent}>
            <p className={styles.cardHint}>
              默认模拟 CLI 登录。授权后浏览器跳到 localhost 属于正常现象，复制地址栏完整回调
              URL 提交即可；后端会保存刷新令牌用于长期续期。
            </p>
            <ProxyPicker
              label="该账号专属代理"
              value={proxyUrl}
              proxies={proxyPool}
              onChange={setProxyUrl}
              placeholder="socks5://user:pass@host:port 或 direct，可留空"
              hint="OAuth 换 token、后续额度查询和账号请求都会优先使用这个代理。支持 http://、https://、socks5://、socks5h://。"
            />
            <div className={styles.authUrlActions}>
              <Button onClick={startOAuth} loading={starting}>
                开始 OAuth
              </Button>
              {authUrl && (
                <Button
                  variant="secondary"
                  onClick={async () => {
                    const copied = await copyToClipboard(authUrl);
                    showNotification(copied ? 'OAuth 链接已复制' : '复制失败', copied ? 'success' : 'error');
                  }}
                >
                  复制授权链接
                </Button>
              )}
            </div>
            {authUrl && (
              <div className={styles.authUrlBox}>
                <div className={styles.authUrlLabel}>授权链接</div>
                <div className={styles.authUrlValue}>{authUrl}</div>
                {authState && <div className={styles.cardHintSecondary}>state: {authState}</div>}
              </div>
            )}
            {status !== 'idle' && (
              <div className={`${styles.oauthStatus} ${styles[status]}`}>
                {statusText || (status === 'waiting' ? '等待授权完成' : '')}
              </div>
            )}

            <div className={styles.callbackSection}>
              <Input
                label="手动提交回调"
                value={callbackUrl}
                onChange={(event) => setCallbackUrl(event.target.value)}
                placeholder="http://localhost:54545/callback?code=...&state=..."
                hint="浏览器打开 localhost 失败也没关系，复制地址栏完整 URL 后提交。"
              />
              <div className={styles.callbackActions}>
                <Button variant="secondary" onClick={submitCallback} loading={callbackSubmitting}>
                  提交回调
                </Button>
              </div>
            </div>
          </div>
        </Card>

        <Card
          title={
            <span className={styles.cardTitle}>
              <img src={iconClaude} alt="" className={styles.cardTitleIcon} />
              Cookie 换授权
            </span>
          }
        >
          <div className={styles.cardContent}>
            <p className={styles.cardHint}>
              适合已有官方站点登录态时快速导入。后端会优先换取 CLI 风格 token；
              如果上游不接受 localhost 回调，会自动回退兼容模式。
            </p>
            <div className={styles.cookieSection}>
              <Input
                label="sessionKey"
                type="password"
                value={sessionKey}
                onChange={(event) => setSessionKey(event.target.value)}
                placeholder="粘贴官方站点 Cookie 中的 sessionKey"
              />
              <ProxyPicker
                label="该账号专属代理"
                value={proxyUrl}
                proxies={proxyPool}
                onChange={setProxyUrl}
                placeholder="socks5://user:pass@host:port 或 direct，可留空"
                hint="与上方 OAuth 代理共用；支持 http://、https://、socks5://、socks5h://；留空使用全局代理，direct/none 强制该账号直连。"
              />
              <div className={styles.cookieActions}>
                <Button onClick={submitCookie} loading={cookieSubmitting}>
                  换授权并加入账号池
                </Button>
                {cookieResult && <span className={styles.cookieResult}>{cookieResult}</span>}
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
