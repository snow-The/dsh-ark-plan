# dsh-ark-plan

Correctly activate **DeepSeek v4 flash** on the **Volcano Ark plan API**
(`https://ark.cn-beijing.volces.com/api/plan/v3`) for DeepSeek Harness.

Why this exists: getting the ark route *working* is easy, but getting
**thinking effort = max** to actually reach the model is not — it needs two
things that are easy to miss, and missing either one silently degrades or
breaks the setup.

## What it does

1. **Default config injection** (`cordis.patch.yml`): a fresh profile gets a
   working ark route + `reasoningEffort: max` with zero manual YAML. Your own
   `settings.yaml` always wins over these defaults.
2. **`ark_plan_doctor`** — a self-check tool that reads your current config,
   flags the two known traps, and live-tests the endpoint to show the
   server-resolved model version and whether a thinking block comes back.

## Install

```bash
# from this repo
dsh plugin --profile web add github:snow-The/dsh-ark-plan
# or local
dsh plugin --profile web add file:C:/path/to/dsh-ark-plan
# then restart dsh web
```

Set your API key once (in the GUI Models page, or):

```bash
# ~/.dsh/.credentials.yaml
ARK_API_KEY: <your volcano ark key>
```

That's it. The profile defaults to `modlens-ark` (vision wrapper from
`@liustack/modlens` — install modlens if you want image input; without it,
set `agent-default-model.provider` to `ark`).

## Verify

Ask your agent to run `ark_plan_doctor`, or check the config yourself:

```yaml
# expected effective values
llm-pi-ai.providers.ark.models[0].reasoningEfforts: { low: low, high: high, max: max }
agent-default-model.reasoningEffort: max
```

The doctor also live-probes the endpoint — expect `serverModel` =
`deepseek-v4-flash-ga-<date>` (e.g. `...-ga-260731`) and a returned reasoning
block.

## The two traps this plugin encodes

| Trap | Symptom if missed |
|---|---|
| **`reasoningEfforts` must be declared on the ark model** — otherwise pi-ai judges the model non-reasoning and its openai-responses adapter skips the whole reasoning branch. The request carries no effort, and the server silently uses its default (`high`). | effort=max never actually reaches the model |
| **`reasoningEffort: max` must accompany `reasoningEfforts`** — setting max without the model declaring it makes `resolveReasoningLevel` throw `UNSUPPORTED_REASONING_EFFORT`. | requests error out |

Also encoded: the bare id `deepseek-v4-flash` is resolved by Ark to the latest
GA snapshot (currently `deepseek-v4-flash-ga-260731`, i.e. the 0731 build).

## How the defaults work

dsh-settings registers each entry's patch config as the `base` of its settings
section, so plugin defaults only apply where the user has not configured the
same keys. No overwriting of user settings.

## License

MIT
