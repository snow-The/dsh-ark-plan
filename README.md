# dsh-ark-plan

Correctly activate **DeepSeek v4 flash** on the **Volcano Ark plan API**
(`https://ark.cn-beijing.volces.com/api/plan/v3`) for DeepSeek Harness.

## Strategy (v0.2): built-in route + baseURL override

No custom provider is created. The plugin reuses **pi-ai's built-in `deepseek`
provider** — which already knows the models (reasoning incl. effort=max, 1M
context, 384K output) — and only overrides `baseURL` to point at Ark's plan
API. A fresh profile ends up with exactly what you would hand-write:

```yaml
llm-pi-ai:
  providers:
    deepseek:                  # pi-ai built-in models inherited
      baseURL: https://ark.cn-beijing.volces.com/api/plan/v3
      apiKeyEnv: DEEPSEEK_API_KEY
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
  reasoningEffort: max
```

Why this beats a hand-rolled "ark" provider: pi-ai's catalog already declares
the deepseek models' reasoning support (`thinkingLevelMap` includes `max`),
context window (1M) and output cap (384K) — none of it needs re-declaring,
and nothing can silently degrade.

## The traps this plugin encodes

| Trap | Symptom if missed |
|---|---|
| **Stale standalone `ark` provider** (v0.1 layout) | A duplicate "ark \| 自定义" entry shows up in the Models page with a red dot. Remove the `llm-pi-ai.providers.ark` block. |
| **`reasoningEffort: max` not set** | Thinking runs at the endpoint default (high), not max. |
| **Wrong key family for the baseURL** | `sk-...` (official DeepSeek) against the ark baseURL → `401 AuthenticationError`; `ark-...` against `api.deepseek.com` → 401 too. Match the key to the endpoint. |
| **baseURL not the ark plan API** | The plugin does nothing if `deepseek.baseURL` points at `api.deepseek.com` — that is just the official route. |

Also encoded: the bare id `deepseek-v4-flash` is resolved by Ark to the latest
GA snapshot (currently `deepseek-v4-flash-ga-260731`, i.e. the 0731 build).

## Install

```bash
dsh plugin --profile web add github:snow-The/dsh-ark-plan
# restart dsh web, then set your key
```

Key: put the **ark- key** in `DEEPSEEK_API_KEY` (or whatever
`llm-pi-ai.providers.deepseek.apiKeyEnv` names) via the Models page or
`~/.dsh/.credentials.yaml`.

## Verify

Ask your agent to run `ark_plan_doctor`. It reads the current config, flags
the traps above (including any stale `ark` provider), and live-tests
ark `/chat/completions` with the deepseek thinking format
(`thinking.type=enabled` + `reasoning_effort=max`) — expect
`serverModel` = `deepseek-v4-flash-ga-<date>` and `thinking: true`.

## How the defaults work

dsh-settings registers each entry's patch config as the `base` of its settings
section, so plugin defaults only apply where the user has not configured the
same keys. No overwriting of user settings.

## License

MIT
