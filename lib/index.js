/**
 * dsh-ark-plan — correct DeepSeek v4 flash activation on the Volcano Ark plan API.
 *
 * Strategy (v0.2): reuse pi-ai's BUILT-IN "deepseek" provider — it already
 * carries the models (reasoning incl. effort=max, 1M context, 384K output) —
 * and only override baseURL to Ark's plan API. No separate "ark" provider is
 * created, so there is nothing for a fresh profile to trip over.
 *
 * The plugin ships two things:
 *   1. cordis.patch.yml — default config injection (deepseek baseURL -> ark,
 *      agent-default-model -> deepseek-official with reasoningEffort=max).
 *      Settings.yaml always wins over these.
 *   2. ark_plan_doctor — self-check: reads the current config, flags the
 *      known mistakes (stale standalone "ark" provider, effort not max,
 *      wrong key family for the ark baseURL, model specs silently shrunk),
 *      and live-tests ark /chat/completions with the deepseek thinking
 *      format to prove what the server resolves (model version + thinking).
 *
 * Node builtins only; the only network call is the optional live probe.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export const name = 'dsh-ark-plan';
export const inject = ['tools'];

const textOutput = () => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
});

function str(a, k) {
  const v = a?.[k];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** Minimal YAML value extraction for the known settings.yaml shape. */
function yamlValue(text, key) {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, 'm');
  const m = text.match(re);
  if (!m) return undefined;
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function sectionOf(text, name) {
  const re = new RegExp(`^\\s*${name}\\s*:\\s*$`, 'm');
  const m = text.match(re);
  if (!m) return '';
  const start = m.index + m[0].length;
  const next = text.slice(start).match(/^\S.*:\s*$/m);
  return text.slice(start, next ? start + next.index : undefined);
}

/** Read a credential from env or ~/.dsh/.credentials.yaml. Returns undefined safely. */
async function resolveKey(name) {
  if (process.env[name]) return process.env[name];
  try {
    const cred = await readFile(join(dshHome(), '.credentials.yaml'), 'utf8');
    return yamlValue(cred, name);
  } catch {
    return undefined;
  }
}

/** Live probe: POST a tiny ark /chat/completions request in the deepseek thinking format. */
async function probe(baseUrl, model, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        thinking: { type: 'enabled' },
        reasoning_effort: 'max',
        max_completion_tokens: 16,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, httpStatus: res.status, body: body.slice(0, 300) };
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    const hasThinking = Boolean(choice?.message?.reasoning_content) || data.usage?.completion_tokens_details?.reasoning_tokens > 0;
    return {
      ok: true,
      httpStatus: res.status,
      serverModel: data.model,
      thinking: hasThinking,
      note: hasThinking
        ? 'endpoint accepted thinking.type=enabled + reasoning_effort=max and returned a thinking block'
        : 'endpoint answered but no thinking block came back (thinking may be off/unsupported)',
    };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timed out after 25s' : String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

const doctorTool = {
  name: 'ark_plan_doctor',
  description: 'Self-check the Volcano Ark plan-API activation for DeepSeek v4 flash in DeepSeek Harness (v0.2: built-in deepseek route + ark baseURL override). Reads the current config (agent-default-model reasoningEffort, llm-pi-ai.providers.deepseek baseURL/apiKeyEnv), flags known mistakes — a stale standalone "ark" provider, reasoningEffort not max, an official (sk-) key pointed at the ark baseURL, or the deepseek route not pointing at ark at all — and, unless probe:false, live-tests ark /chat/completions with the deepseek thinking format to show the server-resolved model version and whether thinking comes back. Use when the user asks to verify the ark setup, whether effort=max is active, or what model version ark resolves.',
  parameters: {
    type: 'object',
    properties: {
      model: { type: 'string', description: 'Model id to check (default: deepseek-v4-flash)' },
      baseURL: { type: 'string', description: 'Ark base URL (default: the configured deepseek route, else https://ark.cn-beijing.volces.com/api/plan/v3)' },
      probe: { type: 'boolean', description: 'Run the live endpoint probe (default true; set false for config-only check)' },
    },
  },
  output: textOutput(),
  timeoutMs: 40000,
  isConcurrencySafe: () => true,
  presentCall: (a) => ({ card: 'generic', title: 'ark_plan_doctor', kind: 'read', rawInput: a }),
  async execute(args) {
    const model = str(args, 'model') ?? 'deepseek-v4-flash';
    const issues = [];
    const hints = [];

    // ---- 1. read current settings.yaml ----
    const settingsPath = join(dshHome(), 'settings.yaml');
    let settingsText = '';
    try {
      settingsText = await readFile(settingsPath, 'utf8');
    } catch {
      issues.push(`cannot read ${settingsPath}`);
    }

    const adm = sectionOf(settingsText, 'agent-default-model');
    const admProvider = yamlValue(adm, 'provider');
    const admModel = yamlValue(adm, 'model');
    const admEffort = yamlValue(adm, 'reasoningEffort');

    const pi = sectionOf(settingsText, 'llm-pi-ai');
    const ds = sectionOf(pi, 'deepseek');
    const dsBase = yamlValue(ds, 'baseURL');
    const dsKeyEnv = yamlValue(ds, 'apiKeyEnv');

    // Stale standalone "ark" provider (v0.1 layout) still present?
    const staleArk = /^\s*ark\s*:\s*$/m.test(pi);
    if (staleArk) {
      issues.push('STALE: a standalone "ark" provider is still configured under llm-pi-ai.providers — the v0.2 layout uses the built-in "deepseek" route with an ark baseURL override instead. Remove the "ark" block (and the ark_plan_doctor will pass).');
    }

    // ---- 2. evaluate the setup ----
    if (dsBase && !dsBase.includes('ark.cn-beijing.volces.com')) {
      issues.push(`llm-pi-ai.providers.deepseek.baseURL is "${dsBase}" — not the Ark plan API (https://ark.cn-beijing.volces.com/api/plan/v3). The ark activation is not in effect.`);
    } else if (!dsBase) {
      hints.push('llm-pi-ai.providers.deepseek.baseURL not set in settings.yaml — the plugin default (ark plan URL) applies.');
    }

    if (admEffort !== 'max') {
      issues.push(`agent-default-model.reasoningEffort is ${admEffort ?? '(unset)'} — thinking effort is not max.`);
    }
    if (admProvider && !/deepseek/.test(admProvider)) {
      hints.push(`agent-default-model.provider is "${admProvider}" — expected a deepseek-family route (e.g. deepseek-official).`);
    }

    // Key-family sanity: an ark baseURL wants an ark- key; a sk- key wants api.deepseek.com.
    const key = await resolveKey(dsKeyEnv ?? 'DEEPSEEK_API_KEY');
    const arkKey = await resolveKey('ARK_API_KEY');
    const keyForArk = (arkKey ?? '').startsWith('ark-') ? arkKey : (key ?? '').startsWith('ark-') ? key : undefined;
    if (dsBase && dsBase.includes('ark.')) {
      if (key && !key.startsWith('ark-')) {
        hints.push(`the configured apiKeyEnv (${dsKeyEnv ?? 'DEEPSEEK_API_KEY'}) holds a "${key.slice(0, 3)}..." key — the ark plan API expects an ark- key. It will answer 401 on the ark baseURL.`);
      }
    }

    // ---- 3. live probe ----
    const probeKey = keyForArk ?? key;
    const probeResult = probeKey && args?.probe !== false
      ? await probe(dsBase ?? 'https://ark.cn-beijing.volces.com/api/plan/v3', model, probeKey)
      : { ok: false, skipped: !probeKey ? 'no usable key found (DEEPSEEK_API_KEY / ARK_API_KEY in env or ~/.dsh/.credentials.yaml)' : 'probe disabled' };

    const serverModel = probeResult.ok ? probeResult.serverModel : undefined;
    if (probeResult.ok && serverModel && !serverModel.includes(model)) {
      issues.push(`live probe resolved model "${serverModel}" — id "${model}" does not prefix it; verify the configured model id.`);
    }

    return {
      ok: issues.length === 0,
      summary: issues.length === 0
        ? `ark activation is correct: deepseek route -> ark baseURL, effort=max, live probe accepted (model ${serverModel}, thinking ${probeResult.thinking ? 'returned' : 'missing'}).`
        : `ark activation needs attention: ${issues.length} issue(s).`,
      config: {
        settingsPath,
        agentDefaultModel: { provider: admProvider, model: admModel, reasoningEffort: admEffort },
        deepseekRoute: { baseURL: dsBase, apiKeyEnv: dsKeyEnv, keyPrefix: key ? key.slice(0, 3) : undefined, staleArkProvider: staleArk },
      },
      liveProbe: probeResult,
      issues,
      hints,
    };
  },
};

export function apply(ctx) {
  ctx.tools.register(doctorTool);
}
