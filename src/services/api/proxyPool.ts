import { apiClient } from './client';

export interface ProxyPoolEntry {
  id: string;
  name?: string;
  url: string;
  redacted_url?: string;
  scheme?: string;
  host?: string;
  enabled: boolean;
  note?: string;
  usage_count?: number;
  created_at?: string;
  updated_at?: string;
}

export interface ProxyPoolPayload {
  name?: string;
  url?: string;
  enabled?: boolean;
  note?: string;
}

interface ProxyPoolListResponse {
  proxies?: ProxyPoolEntry[];
}

interface ProxyPoolItemResponse {
  proxy?: ProxyPoolEntry;
}

const normalizeList = (response: ProxyPoolListResponse): ProxyPoolEntry[] =>
  Array.isArray(response.proxies) ? response.proxies : [];

export const proxyPoolApi = {
  list: async (): Promise<ProxyPoolEntry[]> => normalizeList(await apiClient.get<ProxyPoolListResponse>('/proxy-pool')),

  create: async (payload: ProxyPoolPayload): Promise<ProxyPoolEntry> => {
    const response = await apiClient.post<ProxyPoolItemResponse>('/proxy-pool', payload);
    if (!response.proxy) throw new Error('代理池返回为空');
    return response.proxy;
  },

  update: async (id: string, payload: ProxyPoolPayload): Promise<ProxyPoolEntry> => {
    const response = await apiClient.patch<ProxyPoolItemResponse>(`/proxy-pool/${encodeURIComponent(id)}`, payload);
    if (!response.proxy) throw new Error('代理池返回为空');
    return response.proxy;
  },

  delete: (id: string) => apiClient.delete<{ status: string }>(`/proxy-pool/${encodeURIComponent(id)}`),
};
