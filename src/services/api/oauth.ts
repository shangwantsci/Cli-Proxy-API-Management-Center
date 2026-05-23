/**
 * OAuth 与设备码登录相关 API
 */

import { apiClient } from './client';

export type OAuthProvider =
  | 'codex'
  | 'anthropic'
  | 'antigravity'
  | 'gemini-cli'
  | 'kimi'
  | 'xai';

export interface OAuthStartResponse {
  url: string;
  state?: string;
  proxy_url?: string;
}

export interface OAuthCallbackResponse {
  status: 'ok';
  provider?: string;
  state?: string;
}

export interface ClaudeCookieAuthRequest {
  sessionKey: string;
  proxyUrl?: string;
  prefix?: string;
  note?: string;
}

export interface ClaudeCookieAuthResponse {
  status: 'ok';
  auth_file?: string;
  path?: string;
  email?: string;
  auth_source?: string;
  auth_method_label?: string;
  token_endpoint?: string;
  redirect_uri?: string;
}

export interface OAuthStatusResponse {
  status: 'ok' | 'wait' | 'error';
  error?: string;
  auth_source?: string;
  auth_method_label?: string;
  token_endpoint?: string;
  redirect_uri?: string;
}

const WEBUI_SUPPORTED: OAuthProvider[] = [
  'codex',
  'anthropic',
  'antigravity',
  'gemini-cli',
  'xai'
];
const CALLBACK_PROVIDER_MAP: Partial<Record<OAuthProvider, string>> = {
  'gemini-cli': 'gemini'
};

type ParsedOAuthCallbackInput = {
  code?: string;
  state?: string;
  error?: string;
};

function parseOAuthCallbackInput(input: string): ParsedOAuthCallbackInput {
  const trimmed = input.trim();
  if (!trimmed) return {};

  const candidates = [trimmed];
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    candidates.push(`https://callback.local/?${trimmed.replace(/^[?#]/, '')}`);
  }

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      const paramSources = [url.searchParams];
      const fragment = url.hash.replace(/^#?[?&]?/, '').trim();
      if (fragment) {
        paramSources.push(new URLSearchParams(fragment));
      }
      for (const params of paramSources) {
        const state = params.get('state')?.trim() || undefined;
        const code = params.get('code')?.trim() || undefined;
        const error = params.get('error')?.trim() || params.get('error_description')?.trim() || undefined;
        if (state || code || error) {
          return { code, state, error };
        }
      }
    } catch {
      // Try the normalized query-string candidate next.
    }
  }
  return {};
}

export function extractOAuthCallbackState(input: string): string {
  return parseOAuthCallbackInput(input).state || '';
}

export const oauthApi = {
  startAuth: (provider: OAuthProvider, options?: { projectId?: string; proxyUrl?: string }) => {
    const params: Record<string, string | boolean> = {};
    if (WEBUI_SUPPORTED.includes(provider)) {
      params.is_webui = true;
    }
    if (provider === 'gemini-cli' && options?.projectId) {
      params.project_id = options.projectId;
    }
    if (provider === 'anthropic' && options?.proxyUrl) {
      params.proxy_url = options.proxyUrl;
    }
    return apiClient.get<OAuthStartResponse>(`/${provider}-auth-url`, {
      params: Object.keys(params).length ? params : undefined
    });
  },

  getAuthStatus: (state: string) =>
    apiClient.get<OAuthStatusResponse>(`/get-auth-status`, {
      params: { state }
    }),

  submitCallback: (provider: OAuthProvider, redirectUrl: string) => {
    const callbackProvider = CALLBACK_PROVIDER_MAP[provider] ?? provider;
    const parsed = parseOAuthCallbackInput(redirectUrl);
    return apiClient.post<OAuthCallbackResponse>('/oauth-callback', {
      provider: callbackProvider,
      redirect_url: redirectUrl,
      code: parsed.code,
      state: parsed.state,
      error: parsed.error
    });
  },

  cookieAuthClaude: (payload: ClaudeCookieAuthRequest) =>
    apiClient.post<ClaudeCookieAuthResponse>('/anthropic-cookie-auth', {
      session_key: payload.sessionKey,
      proxy_url: payload.proxyUrl || undefined,
      prefix: payload.prefix || undefined,
      note: payload.note || undefined
    })
};
