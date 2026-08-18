# dsh-ark-plan

Activate **DeepSeek v4 flash** on the **Volcano Ark plan API**
(`https://ark.cn-beijing.volces.com/api/plan/v3`) in DeepSeek Harness —
the budget lane: 10× cheaper off-peak token bundles for the same model.

## Strategy: built-in route + baseURL override (no custom provider)

The plugin reuses **pi-ai's built-in `deepseek` provider** — which already
knows the models (reasoning incl. effort=max, 1M context, 384K output) — and
only overrides `baseURL` to point at Ark's plan API. No hand-rolled "ark"
provider, nothing to re-declare, nothing to silently degrade.

Two lanes coexist:

| Lane | Provider | baseURL | Key env | Key prefix |
|---|---|---|---|---|
| Official (default) | `deepseek-official` | api.deepseek.com | `DEEPSEEK_API_KEY` | `sk-...` |
| Ark budget | `deepseek` (DeepSeek V4 Flash(ARK)) | ark plan API | `ARK_API_KEY` | `ark-...` |

Default model stays on the official route; the ark lane is there to burn the
cheap plan tokens when you want them — switch the model picker to the
`deepseek` provider's models to use it, then switch back when the bundle runs
out (don't buy more: the plan's value ends there).

## Install

```bash
dsh plugin --profile web add github:snow-The/dsh-ark-plan
# restart dsh web
```

## Configure keys

```yaml
# ~/.dsh/.credentials.yaml (or the Models page)
DEEPSEEK_API_KEY: sk-...      # official DeepSeek key (official lane)
ARK_API_KEY: ark-...          # Volcano Ark plan key (ark lane)
```

The two envs are deliberately separate — a `sk-` key against the ark
baseURL answers `401 AuthenticationError` and vice versa.

## Verify

Ask your agent to run `ark_plan_doctor`. It reads the current config, flags
the known mistakes, and live-tests ark `/chat/completions` with the deepseek
thinking format (`thinking.type=enabled` + `reasoning_effort=max`) — expect
`serverModel` = `deepseek-v4-flash-ga-<date>` (e.g. `...-ga-260731`, the 0731
build) and `thinking: true`.

## Traps this plugin encodes

| Trap | Symptom if missed |
|---|---|
| **Stale standalone `ark` provider** (v0.1 layout) | A duplicate "ark \| 自定义" entry in the Models page with a red dot. Remove `llm-pi-ai.providers.ark`. |
| **`reasoningEffort: max` not set** | Thinking runs at the endpoint default (high), not max. |
| **Wrong key family for the baseURL** | `sk-...` against ark → 401; `ark-...` against api.deepseek.com → 401. Match key to endpoint. |
| **`ARK_API_KEY` missing** | The ark lane exists but answers 401 until its key is filled. |
| **baseURL not the ark plan API** | Plugin defaults do nothing if `deepseek.baseURL` points at `api.deepseek.com` — that's just the official route. |

## How the defaults work

dsh-settings registers each entry's patch config as the `base` of its settings
section, so plugin defaults only apply where the user has not configured the
same keys. No overwriting of user settings.

## License

MIT
