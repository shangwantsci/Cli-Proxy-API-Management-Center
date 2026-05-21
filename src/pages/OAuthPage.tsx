import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { oauthApi } from '@/services/api/oauth';
import { useNotificationStore } from '@/stores';
import { copyToClipboard } from '@/utils/clipboard';
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
  const [cookieSubmitting, setCookieSubmitting] = useState(false);
  const [cookieResult, setCookieResult] = useState('');

  const clearPollTimer = useCallback(() => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

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
            markSuccess('Claude OAuth 授权完成，账号已加入账号池');
          } else if (result.status === 'error') {
            clearPollTimer();
            setStatus('error');
            setStatusText(result.error || 'Claude OAuth 授权失败');
          }
        } catch (error) {
          clearPollTimer();
          setStatus('error');
          setStatusText(errorMessage(error));
        }
      }, 2000);
    },
    [clearPollTimer, markSuccess]
  );

  const startOAuth = async () => {
    setStarting(true);
    setStatus('waiting');
    setStatusText('正在创建 Claude OAuth 授权链接');
    try {
      const result = await oauthApi.startAuth('anthropic');
      setAuthUrl(result.url);
      setAuthState(result.state || '');
      setStatusText('请在新窗口完成 Claude 授权，授权完成后本页会自动更新状态');
      if (result.state) {
        pollStatus(result.state);
      }
      window.open(result.url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setStatus('error');
      setStatusText(errorMessage(error));
      showNotification(`创建 Claude OAuth 链接失败：${errorMessage(error)}`, 'error');
    } finally {
      setStarting(false);
    }
  };

  const submitCallback = async () => {
    if (!callbackUrl.trim()) {
      showNotification('请粘贴 Claude 回调地址或 code/state 参数', 'error');
      return;
    }
    setCallbackSubmitting(true);
    try {
      await oauthApi.submitCallback('anthropic', callbackUrl.trim());
      markSuccess('Claude OAuth 回调已提交，账号已加入账号池');
      setCallbackUrl('');
    } catch (error) {
      setStatus('error');
      setStatusText(errorMessage(error));
      showNotification(`提交回调失败：${errorMessage(error)}`, 'error');
    } finally {
      setCallbackSubmitting(false);
    }
  };

  const submitCookie = async () => {
    if (!sessionKey.trim()) {
      showNotification('请填写 Claude sessionKey', 'error');
      return;
    }
    setCookieSubmitting(true);
    setCookieResult('');
    try {
      const result = await oauthApi.cookieAuthClaude({
        sessionKey: sessionKey.trim(),
        proxyUrl: proxyUrl.trim() || undefined,
      });
      const label = result.email || result.auth_file || 'Claude';
      setCookieResult(`已导入 ${label}`);
      setSessionKey('');
      markSuccess('Cookie 换授权完成，账号已加入账号池');
    } catch (error) {
      showNotification(`Cookie 换授权失败：${errorMessage(error)}`, 'error');
    } finally {
      setCookieSubmitting(false);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <div>
          <h1 className={styles.pageTitle}>导入 Claude 账号</h1>
          <p className={styles.cardHint}>
            OAuth 是授权协议，用来把 Claude 账号换成可自动刷新的访问令牌；Cookie
            换授权是用 claude.ai 的 sessionKey 完成同一件事。
          </p>
        </div>

        <Card
          title={
            <span className={styles.cardTitle}>
              <img src={iconClaude} alt="" className={styles.cardTitleIcon} />
              Claude OAuth
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
              推荐优先使用 OAuth。授权成功后，后端会保存刷新令牌，后续 access token
              过期时可以自动刷新。
            </p>
            <div className={styles.authUrlActions}>
              <Button onClick={startOAuth} loading={starting}>
                开始 Claude OAuth
              </Button>
              {authUrl && (
                <Button
                  variant="secondary"
                  onClick={async () => {
                    const copied = await copyToClipboard(authUrl);
                    showNotification(copied ? 'Claude OAuth 链接已复制' : '复制失败', copied ? 'success' : 'error');
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
                placeholder="粘贴 Claude 回跳 URL，或 code=...&state=..."
                hint="浏览器没有自动回到本面板时使用。"
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
              适合已有 claude.ai 登录态时快速导入。sessionKey 只用于向 Claude
              请求授权，保存的是 OAuth token。
            </p>
            <div className={styles.cookieSection}>
              <Input
                label="Claude sessionKey"
                type="password"
                value={sessionKey}
                onChange={(event) => setSessionKey(event.target.value)}
                placeholder="粘贴 claude.ai Cookie 中的 sessionKey"
              />
              <Input
                label="该账号专属代理"
                value={proxyUrl}
                onChange={(event) => setProxyUrl(event.target.value)}
                placeholder="http://user:pass@host:port，可留空"
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
