// 模型 → 厂商。来源自报了 provider 就用它，否则按模型名推断。

const RULES: { re: RegExp; vendor: string }[] = [
  { re: /^gpt-|^o[134]-|^chatgpt|^codex/i, vendor: 'openai' },
  { re: /^claude/i, vendor: 'anthropic' },
  { re: /^deepseek/i, vendor: 'deepseek' },
  { re: /^minimax/i, vendor: 'minimax' },
  { re: /^glm|^z-?ai/i, vendor: 'zai' },
  { re: /^gemini|^gemma/i, vendor: 'google' },
  { re: /^qwen|^qwq/i, vendor: 'alibaba' },
  { re: /^kimi|^moonshot/i, vendor: 'moonshot' },
  { re: /^llama/i, vendor: 'meta' },
  { re: /^mistral|^mixtral/i, vendor: 'mistral' },
  { re: /^grok/i, vendor: 'xai' },
  { re: /^doubao|^ernie/i, vendor: 'baidu' }
];

/** 已知厂商的 provider 键也直接认。 */
const KNOWN_PROVIDERS = new Set([
  'openai', 'anthropic', 'deepseek', 'minimax', 'minimax-cn', 'zai', 'google', 'alibaba',
  'moonshot', 'meta', 'mistral', 'xai', 'baidu', 'custom'
]);

export function inferVendor(model: string): string | null {
  for (const r of RULES) if (r.re.test(model)) return r.vendor;
  return null;
}

/** 来源自报优先，自报的不认就查表。 */
export function resolveVendor(model: string, provider: string | null): string | null {
  if (provider) {
    const p = provider.toLowerCase();
    if (KNOWN_PROVIDERS.has(p)) return p;
    const inferred = inferVendor(model);
    return inferred ?? p;
  }
  return inferVendor(model);
}
