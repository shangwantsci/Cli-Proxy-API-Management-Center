export function sanitizeSensitiveText(value: unknown): string {
  const text = String(value ?? '');
  if (!text) return '';
  return text
    .replace(/Claude Code CLI OAuth/gi, 'CLI OAuth')
    .replace(/Claude Code CLI/gi, 'CLI')
    .replace(/Claude Code/gi, 'CLI')
    .replace(/claude\.ai/gi, '官方站点')
    .replace(/Anthropic/gi, '上游服务')
    .replace(/Claude/gi, '服务账号');
}
