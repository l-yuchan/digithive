# Settings overhaul — one settings tab, providers, model selection

Owner request (2026-11-28): unify 연결 and 설정 into one tab with child routing; allow adding any
OpenAI-compatible provider; predefine OpenCode Go and DeepInfra and use their documented extra APIs
(model listing, usage/quota) instead of plain URL+key rows.

## Routes

| Path | Child | Content |
| --- | --- | --- |
| `/settings` | 개요 | 상태 요약, 모델 경로(우선순위=라우팅 순서), 각 섹션 링크 |
| `/settings/providers` | 모델 공급자 | 공급자 목록/추가/수정/삭제, 모델 찾기, 사용량/한도, 모델 경로 |
| `/settings/accounts` | 계정 | 기존 AccountsPanel + Google OAuth |
| `/settings/push` | 알림 | 기존 PushPanel |
| `/settings/briefings` | 브리핑 | 최근 브리핑 + 지금 만들기 |
| `/connections` | (legacy) | 서버가 셸 제공, 클라이언트가 `/settings/accounts`로 replace |

Tab list loses `connections`; the server route pattern gains `/settings/<child>` so a hard reload works.

## Data model (migration V17)

- `provider_connections`: id, catalog_id (`opencode-go` | `deepinfra` | `custom`), label, base_url,
  key_sealed (vault), headers_json, enabled, created_at, updated_at. Definitions only.
- `provider_models`: provider_id → model_id rows the provider served (or the owner typed) with
  context/pricing/capabilities snapshot. Replaced on each successful fetch.
- `model_chain`: provider_id, model_id, position, enabled — the ordered routing list. Definitions
  separate from execution; the router reads it per call.
- `provider_state`: provider_id, models_fetched_at, models_error, usage_json, usage_fetched_at,
  usage_error — the last probe outcome, so the screen can show something before the next probe.
- Seeding: a database with no provider rows gets its existing env configuration (MODEL_BASE_URL /
  MODEL_API_KEY / MODEL_NAME / HARNESS_MODEL_HEADERS + MODEL_FALLBACKS_JSON) as `custom` providers and
  the saved priority as chain order. Nothing is invented when the store already has providers.

## Catalog (server, per provider)

```ts
type ProviderCatalog = {
  id: "opencode-go" | "deepinfra" | "custom";
  label; baseUrl; docsUrl;
  capabilities: readonly ("models" | "usage")[];
  models(ctx): Promise<ModelOffer[]>;   // upstream call with the provider key
  usage(ctx): Promise<ProviderUsage>;   // meters / rate limits, or an explicit error
};
```

- OpenCode Go — `GET {base}/models` (OpenAI list + limit/cost/go), `GET {base}/usage` (rolling/weekly/
  monthly meters); base `https://opencode.ai/inference/go/v1`; chat only where `type === "chat"`.
- DeepInfra — `GET https://api.deepinfra.com/v1/openai/models` (metadata.context_length/pricing/tags),
  `GET https://api.deepinfra.com/v1/me/rate_limit`; chat only where tags include `chat`.
- Custom — generic OpenAI `GET {base}/models`; usage unsupported, and the screen says why.

## API

- `GET /api/providers` — providers (masked key), chain, state. No secret ever.
- `POST /api/providers` — create (catalogId, label?, apiKey, baseUrl? for custom, headers?).
- `PATCH /api/providers/:id` — label/baseUrl/key/headers/enabled.
- `DELETE /api/providers/:id` — removes provider, its models, chain entries, state.
- `POST /api/providers/:id/probe` — fetch models + usage with the stored key; persist state; return
  both plus each error verbatim.
- `GET /api/providers/:id/models` — stored offers (or fetch when stale? no: explicit probe).
- `PUT /api/settings/models` — chain order `{entries:[{providerId, modelId}]}` (permutation of enabled
  chain members); `POST`/`DELETE` chain rows for adding/removing a model.
- `POST /api/settings/models/test` — send one tiny chat completion through a chain entry and report the
  upstream answer/error (the "is this model usable" check).

## Client

Sidebar inside the settings tab (child links), URL-driven like tabs. Provider form: catalog picker,
key, base URL (custom), model search from listed models with context/pricing, manual model id, chain
move up/down/enable, usage panel, last probe errors shown verbatim.

## Verification

1. Unit/HTTP tests for store, catalog parsers (recorded upstream bodies), routes, chain order.
2. Routing test: fake endpoints prove the chain decides which provider answers and a disabled provider
   is skipped.
3. Browser QA with the QA fixture: navigate every child, add providers, probe, screenshots.
4. CI green → CD deploy → live probe of `/settings/providers` and the live DB schema version.
