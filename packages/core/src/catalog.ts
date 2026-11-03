// 模型 → 厂商。来源自报了 provider 就用它，否则按模型名推断。

const RULES: { re: RegExp; vendor: string }[] = [
  // OpenAI：gpt-*、chatgpt、codex，还有裸型号 o1 / o3 / o4
  { re: /^gpt-|^o[134]($|-)|^chatgpt|^codex/i, vendor: 'openai' },
  { re: /^claude/i, vendor: 'anthropic' },
  { re: /^deepseek/i, vendor: 'deepseek' },
  { re: /^minimax/i, vendor: 'minimax' },
  // 智谱：glm-*、chatglm-*，还有 z-ai
  { re: /^glm|^chatglm|^z-?ai/i, vendor: 'zai' },
  { re: /^gemini|^gemma/i, vendor: 'google' },
  { re: /^qwen|^qwq/i, vendor: 'alibaba' },
  { re: /^kimi|^moonshot/i, vendor: 'moonshot' },
  { re: /^llama/i, vendor: 'meta' },
  // Mistral 家族：mistral-*、mixtral-*、ministral-*、magistral-*、devstral、codestral
  { re: /^mistral|^mixtral|^ministral|^magistral|^devstral|^codestral/i, vendor: 'mistral' },
  { re: /^grok/i, vendor: 'xai' },
  { re: /^doubao|^ernie/i, vendor: 'baidu' },
  // 其它常见家族
  { re: /^hunyuan/i, vendor: 'tencent' },
  { re: /^step-?/i, vendor: 'stepfun' },
  { re: /^yi-/i, vendor: 'zeroone' },
  { re: /^command/i, vendor: 'cohere' },
  { re: /^nova-|^titan/i, vendor: 'amazon' }
];

export function inferVendor(model: string): string | null {
  const m = model.trim();
  if (!m) return null;
  // 有的模型名带命名空间前缀（OpenRouter 风格：anthropic/claude-sonnet-4.5、
  // openai/gpt-4o）。规则都锚在开头，所以先把前缀剥掉再匹配。
  const bare = m.includes('/') ? m.slice(m.lastIndexOf('/') + 1) : m;
  for (const r of RULES) if (r.re.test(bare)) return r.vendor;
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
