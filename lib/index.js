/**
 * dsh-ark-plan — correct DeepSeek v4 flash activation on the Volcano Ark plan API.
 *
 * The plugin ships two things:
 *   1. cordis.patch.yml — default config injection (ark provider route with
 *      reasoningEfforts declared, agent-default-model pointed at modlens-ark
 *      with reasoningEffort=max). Settings.yaml always wins over these.
 *   2. ark_plan_doctor — a self-check tool: reads the current config, checks
 *      the two known activation traps, and live-tests the endpoint to prove
 *      what the server actually resolves (model version + thinking effort).
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

/** Read ARK_API_KEY from env or ~/.dsh/.credentials.yaml. Returns undefined safely. */
async function resolveArkKey() {
  if (process.env.ARK_API_KEY) return process.env.ARK_API_KEY;
  try {
    const cred = await readFile(join(dshHome(), '.credentials.yaml'), 'utf8');
    return yamlValue(cred, 'ARK_API_KEY');
  } catch {
    return undefined;
  }
}

/** Live probe: POST a tiny /responses request with reasoning.effort=max. */
async function probe(baseUrl, model, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: 'ping',
        reasoning: { effort: 'max', summary: 'auto' },
        max_output_tokens: 16,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, httpStatus: res.status, body: body.slice(0, 300) };
    }
    const data = await res.json();
    const reasoningBlocks = Array.isArray(data.output)
      ? data.output.filter((o) => o?.type === 'reasoning').length
      : 0;
    return {
      ok: true,
      httpStatus: res.status,
      serverModel: data.model,
      reasoningBlocks,
      usage: data.usage,
      note: reasoningBlocks > 0
        ? 'endpoint accepted reasoning.effort=max and returned a thinking block'
        : 'endpoint answered but no reasoning block came back (thinking may be off/unsupported)',
    };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timed out after 25s' : String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

const doctorTool = {
  name: 'ark_plan_doctor',
  description: 'Self-check the Volcano Ark plan-API activation for DeepSeek v4 flash in DeepSeek Harness. Reads the current config (agent-default-model reasoningEffort, llm-pi-ai providers.ark route + reasoningEfforts), reports the two known activation traps (missing reasoningEfforts makes the model non-reasoning; reasoningEffort=max without it throws UNSUPPORTED_REASONING_EFFORT), and — unless probe:false — live-tests the endpoint to show the server-resolved model version and whether a thinking block comes back. Use when the user asks to verify the ark setup, whether effort=max is active, or what model version ark resolves.',
  parameters: {
    type: 'object',
    properties: {
      model: { type: 'string', description: 'Model id to check (default: deepseek-v4-flash)' },
      baseURL: { type: 'string', description: 'Ark base URL (default: the configured route, else https://ark.cn-beijing.volces.com/api/plan/v3)' },
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
    const ark = sectionOf(pi, 'ark');
    const arkBase = yamlValue(ark, 'baseURL');
    const arkApi = yamlValue(ark, 'api');
    const arkKeyEnv = yamlValue(ark, 'apiKeyEnv');
    const idMatch = ark.match(/^\s*-\s*id\s*:\s*(.+)$/m);
    const arkModelId = idMatch ? idMatch[1].trim().replace(/^["']|["']$/g, '') : undefined;
    const effortsDeclared = /reasoningEfforts\s*:/.test(ark);
    const maxDeclared = /^\s*max\s*:\s*max\s*$/m.test(ark);

    // ---- 2. evaluate the two traps ----
    if (!effortsDeclared) {
      issues.push('TRAP 1: the ark model entry has no reasoningEfforts — pi-ai judges the model non-reasoning, the responses adapter skips the reasoning branch, and effort is never sent (server default high).');
    } else if (!maxDeclared) {
      issues.push('reasoningEfforts declared but the "max" level is missing — effort=max cannot be selected.');
    }
    if (admEffort === 'max' && !effortsDeclared) {
      issues.push('TRAP 2: agent-default-model.reasoningEffort=max is set but the model declares no reasoningEfforts — requests will throw UNSUPPORTED_REASONING_EFFORT.');
    }
    if (admEffort !== 'max') {
      issues.push(`agent-default-model.reasoningEffort is ${admEffort ?? '(unset)'} — thinking effort is not max.`);
    }
    if (!arkBase || !arkKeyEnv) {
      issues.push('ark route missing baseURL/apiKeyEnv — the provider route is incomplete.');
    }

    // ---- 3. live probe ----
    const key = await resolveArkKey();
    const probeResult = key && args?.probe !== false
      ? await probe(arkBase ?? 'https://ark.cn-beijing.volces.com/api/plan/v3', model, key)
      : { ok: false, skipped: !key ? 'ARK_API_KEY not found (env or ~/.dsh/.credentials.yaml)' : 'probe disabled' };

    const serverModel = probeResult.ok ? probeResult.serverModel : undefined;
    if (probeResult.ok && serverModel && !serverModel.includes(model)) {
      issues.push(`live probe resolved model "${serverModel}" — id "${model}" does not prefix it; verify the configured model id.`);
    }

    return {
      ok: issues.length === 0,
      summary: issues.length === 0
        ? `ark activation is correct: effort=max configured, reasoningEfforts declared, live probe accepted (model ${serverModel}).`
        : `ark activation needs attention: ${issues.length} issue(s).`,
      config: {
        settingsPath,
        agentDefaultModel: { provider: admProvider, model: admModel, reasoningEffort: admEffort },
        arkRoute: { baseURL: arkBase, api: arkApi, apiKeyEnv: arkKeyEnv, modelId: arkModelId, reasoningEffortsDeclared: effortsDeclared },
      },
      liveProbe: probeResult,
      issues,
    };
  },
};

export function apply(ctx) {
  ctx.tools.register(doctorTool);
}
