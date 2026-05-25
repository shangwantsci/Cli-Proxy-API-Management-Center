import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { proxyPoolApi, type ProxyPoolEntry } from '@/services/api/proxyPool';
import { useAuthStore, useNotificationStore } from '@/stores';
import styles from './ProxyPoolPage.module.scss';

interface ProxyForm {
  id: string;
  name: string;
  url: string;
  note: string;
  enabled: boolean;
}

const emptyForm: ProxyForm = {
  id: '',
  name: '',
  url: '',
  note: '',
  enabled: true,
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '操作失败';
}

function formatTime(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

export function ProxyPoolPage() {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const { showNotification } = useNotificationStore();
  const [proxies, setProxies] = useState<ProxyPoolEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [batchSaving, setBatchSaving] = useState(false);
  const [form, setForm] = useState<ProxyForm>(emptyForm);
  const [batchText, setBatchText] = useState('');

  const loadProxies = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      setProxies([]);
      return;
    }
    setLoading(true);
    try {
      setProxies(await proxyPoolApi.list());
    } catch (error) {
      showNotification(`代理池加载失败：${errorMessage(error)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [connectionStatus, showNotification]);

  useEffect(() => {
    loadProxies();
  }, [loadProxies]);

  const enabledCount = useMemo(() => proxies.filter((proxy) => proxy.enabled).length, [proxies]);
  const usedCount = useMemo(
    () => proxies.filter((proxy) => Number(proxy.usage_count ?? 0) > 0).length,
    [proxies]
  );

  const resetForm = () => setForm(emptyForm);

  const submitForm = async () => {
    if (!form.url.trim()) {
      showNotification('请填写代理 URL', 'error');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim() || undefined,
        url: form.url.trim(),
        note: form.note.trim() || undefined,
        enabled: form.enabled,
      };
      if (form.id) {
        await proxyPoolApi.update(form.id, payload);
        showNotification('代理已更新', 'success');
      } else {
        await proxyPoolApi.create(payload);
        showNotification('代理已加入代理池', 'success');
      }
      resetForm();
      await loadProxies();
    } catch (error) {
      showNotification(`代理保存失败：${errorMessage(error)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (proxy: ProxyPoolEntry) => {
    setForm({
      id: proxy.id,
      name: proxy.name || '',
      url: proxy.url,
      note: proxy.note || '',
      enabled: proxy.enabled,
    });
  };

  const deleteProxy = async (proxy: ProxyPoolEntry) => {
    const visible = proxy.name || proxy.redacted_url || proxy.url;
    if (!window.confirm(`确定从代理池删除 ${visible} 吗？已绑定账号不会被自动清空代理。`)) {
      return;
    }
    try {
      await proxyPoolApi.delete(proxy.id);
      showNotification('代理已删除', 'success');
      await loadProxies();
      if (form.id === proxy.id) resetForm();
    } catch (error) {
      showNotification(`代理删除失败：${errorMessage(error)}`, 'error');
    }
  };

  const importBatch = async () => {
    const urls = batchText
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (urls.length === 0) {
      showNotification('请先粘贴代理 URL，每行一个', 'error');
      return;
    }
    setBatchSaving(true);
    let success = 0;
    const failures: string[] = [];
    for (const url of urls) {
      try {
        await proxyPoolApi.create({ url, enabled: true });
        success += 1;
      } catch (error) {
        failures.push(`${url}: ${errorMessage(error)}`);
      }
    }
    setBatchSaving(false);
    await loadProxies();
    if (failures.length > 0) {
      showNotification(`批量导入完成：成功 ${success} 条，失败 ${failures.length} 条`, 'error');
      return;
    }
    setBatchText('');
    showNotification(`批量导入完成：${success} 条代理已加入代理池`, 'success');
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1>代理池</h1>
          <p>集中保存 Claude 账号可选代理。手动导入账号时填写的新代理会自动归档到这里。</p>
        </div>
        <Button variant="secondary" onClick={loadProxies} loading={loading}>
          刷新
        </Button>
      </div>

      <div className={styles.statsGrid}>
        <div className={styles.statCard}>
          <span>代理总数</span>
          <strong>{proxies.length}</strong>
        </div>
        <div className={styles.statCard}>
          <span>启用中</span>
          <strong>{enabledCount}</strong>
        </div>
        <div className={styles.statCard}>
          <span>已绑定账号</span>
          <strong>{usedCount}</strong>
        </div>
      </div>

      <div className={styles.mainGrid}>
        <Card title={form.id ? '编辑代理' : '添加代理'}>
          <div className={styles.formStack}>
            <Input
              label="代理名称"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="例如 US-01 / HK-备用"
            />
            <Input
              label="代理 URL"
              value={form.url}
              onChange={(event) => setForm({ ...form, url: event.target.value })}
              placeholder="socks5://user:pass@host:port"
              hint="支持 http://、https://、socks5://、socks5h://。direct/none 是账号直连设置，不会保存到代理池。"
            />
            <Input
              label="备注"
              value={form.note}
              onChange={(event) => setForm({ ...form, note: event.target.value })}
              placeholder="供应商、地区、到期时间等"
            />
            <ToggleSwitch
              checked={form.enabled}
              onChange={(enabled) => setForm({ ...form, enabled })}
              label="在账号导入和设置中可选"
            />
            <div className={styles.formActions}>
              {form.id && (
                <Button variant="ghost" onClick={resetForm}>
                  取消编辑
                </Button>
              )}
              <Button onClick={submitForm} loading={saving}>
                {form.id ? '保存代理' : '加入代理池'}
              </Button>
            </div>
          </div>
        </Card>

        <Card title="批量导入">
          <div className={styles.formStack}>
            <label className={styles.textareaField}>
              <span>代理 URL 列表</span>
              <textarea
                value={batchText}
                onChange={(event) => setBatchText(event.target.value)}
                placeholder="每行一个代理 URL"
                spellCheck={false}
              />
            </label>
            <Button onClick={importBatch} loading={batchSaving}>
              批量加入代理池
            </Button>
          </div>
        </Card>
      </div>

      <Card title="代理列表">
        <div className={styles.tableWrap}>
          <table className={styles.proxyTable}>
            <thead>
              <tr>
                <th>名称</th>
                <th>代理</th>
                <th>协议</th>
                <th>状态</th>
                <th>绑定账号</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {proxies.map((proxy) => (
                <tr key={proxy.id}>
                  <td>
                    <strong>{proxy.name || '未命名代理'}</strong>
                    {proxy.note && <small>{proxy.note}</small>}
                  </td>
                  <td className={styles.proxyUrl}>{proxy.redacted_url || proxy.url}</td>
                  <td>{proxy.scheme || '-'}</td>
                  <td>
                    <span className={proxy.enabled ? styles.enabledBadge : styles.disabledBadge}>
                      {proxy.enabled ? '启用' : '停用'}
                    </span>
                  </td>
                  <td>{proxy.usage_count ?? 0}</td>
                  <td>{formatTime(proxy.updated_at)}</td>
                  <td>
                    <div className={styles.rowActions}>
                      <Button variant="secondary" size="sm" onClick={() => startEdit(proxy)}>
                        编辑
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => deleteProxy(proxy)}>
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {proxies.length === 0 && (
                <tr>
                  <td colSpan={7} className={styles.emptyCell}>
                    暂无代理。添加账号时手动填写的有效代理也会自动出现在这里。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
