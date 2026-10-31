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

export function inferVendor(model: string): string | null {
  for (const r of RULES) if (r.re.test(model)) return r.vendor;
  return null;
}

/**
 * 厂商：来源自报的 provider 原样用，没自报才按模型名推断。
 *
 * 不要拿“已知厂商名单”去否决自报值。同一个模型可以通过不同渠道拿到，
 * 渠道（provider）才是花销算在哪里的区分：opencode 的 deepseek-v4.1-flash-free
 * 自报 provider 是 opencode，经 opencode-go 走的是 opencode-go，直连才是 deepseek。
 * 以前只认名单里的键，不在名单里的被模型名推断覆盖，这三家全被归到了 deepseek。
 */
export function resolveVendor(model: string, provider: string | null): string | null {
  const p = provider?.trim();
  if (p) return p;
  return inferVendor(model);
}
