import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import type { ProxyPoolEntry } from '@/services/api/proxyPool';
import styles from './ProxyPicker.module.scss';

interface ProxyPickerProps {
  label: string;
  value: string;
  proxies: ProxyPoolEntry[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  hint?: string;
}

const proxyLabel = (proxy: ProxyPoolEntry): string => {
  const name = proxy.name?.trim();
  const visibleURL = proxy.redacted_url || proxy.url;
  const usage = typeof proxy.usage_count === 'number' ? ` · ${proxy.usage_count} 个账号` : '';
  return `${name || visibleURL}${name ? ` · ${visibleURL}` : ''}${usage}`;
};

export function ProxyPicker({
  label,
  value,
  proxies,
  onChange,
  disabled = false,
  placeholder = 'socks5://user:pass@host:port 或 direct',
  hint,
}: ProxyPickerProps) {
  const enabledProxies = proxies.filter((proxy) => proxy.enabled);
  const selectedProxy = enabledProxies.find((proxy) => proxy.url === value)?.url ?? '';
  const options = [
    { value: '', label: '手动填写 / 不使用代理池' },
    ...enabledProxies.map((proxy) => ({ value: proxy.url, label: proxyLabel(proxy) })),
  ];

  return (
    <div className={styles.proxyPicker}>
      {enabledProxies.length > 0 && (
        <div className={styles.selectField}>
          <label>{label}来源</label>
          <Select
            value={selectedProxy}
            options={options}
            disabled={disabled}
            onChange={(nextValue) => {
              if (nextValue) onChange(nextValue);
            }}
          />
        </div>
      )}
      <Input
        label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        hint={hint}
      />
    </div>
  );
}
