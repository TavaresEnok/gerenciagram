# API

Referência **viva** em http://localhost:3001/docs (OpenAPI 3.1, gerado dos
mesmos schemas Zod que validam as requisições — não há como divergir do
comportamento real).

Este documento cobre as convenções que valem para todos os endpoints.

---

## Versionamento

Toda rota de negócio vive sob `/v1`. Os health checks ficam **fora** do
prefixo (`/healthz`, `/readyz`): são contrato com o orquestrador, não API de
produto, e não devem mudar quando a API versionar.

---

## Autenticação

```
Authorization: Bearer <access token>
```

| Token | Vida | Onde vive | Revogável |
|---|---|---|---|
| **Access** | 15 min | Memória do cliente | Não (por isso é curto) |
| **Refresh** | 30 dias | Cookie `httpOnly`, path `/v1/auth` | Sim |

O refresh é **opaco** e guardado como SHA-256. A cada uso ele é **rotacionado**;
apresentar um já rotacionado significa sessão copiada, e o sistema revoga a
**família inteira**.

```http
POST /v1/auth/login          → { accessToken, user, organizationId }
                             → ou { status: "mfa_required", challengeToken }
POST /v1/auth/login/mfa      → { accessToken, ... }
POST /v1/auth/refresh        → { accessToken, expiresIn }
POST /v1/auth/logout         → 204
```

Trocar de organização é um `refresh` com `{ organizationId }` — o papel muda
entre organizações, então o token precisa ser reemitido.

---

## Erros

Formato único, em todos os endpoints:

```json
{
  "error": {
    "code": "QUOTA_EXCEEDED",
    "message": "A cota diária do aplicativo em YouTube seria estourada...",
    "details": { "platform": "YOUTUBE", "scope": "APP" },
    "correlationId": "9f3c1e2a-..."
  }
}
```

O `correlationId` também volta no header `X-Correlation-Id` e é o mesmo que
aparece nos logs da API, da fila e do worker.

| Código | HTTP | Quando |
|---|---|---|
| `VALIDATION_ERROR` | 422 | Corpo inválido. `details` traz `path` e `message` por campo |
| `UNAUTHORIZED` | 401 | Sem token, token inválido ou expirado |
| `FORBIDDEN` | 403 | Papel sem a permissão exigida |
| `NOT_FOUND` | 404 | Recurso inexistente **ou de outra organização** |
| `CONFLICT` | 409 | Violação de unicidade ou estado incompatível |
| `RATE_LIMITED` | 429 | Limite da API própria |
| `PLATFORM_NOT_CONFIGURED` | 503 | Rede implementada, mas sem credenciais no ambiente |
| `UNSUPPORTED_BY_PLATFORM` | 422 | A API oficial da rede não oferece o recurso |
| `QUOTA_EXCEEDED` | 429 | Cota da conta ou do app/projeto |
| `CIRCUIT_OPEN` | 503 | Plataforma suspensa por falhas repetidas |
| `DUPLICATE_CONTENT_FORBIDDEN` | 422 | A rede proíbe conteúdo igual em várias contas |

> **`NOT_FOUND` para recurso de outra organização é intencional.** Um 403
> confirmaria que o id existe.

---

## Idempotência

Operações de escrita relevantes aceitam:

```
Idempotency-Key: <valor estável do cliente>
```

Reenviar a mesma requisição devolve a **mesma** publicação, em vez de criar
outra. É o que impede um duplo clique em "agendar" de gerar dois posts para as
mesmas 20 contas.

No nível do destino a garantia é estrutural: a chave é derivada de
`(postId, socialAccountId)` e protegida por `UNIQUE` no banco.

---

## Paginação

```
?limit=50&offset=0
```

Respostas de lista trazem `total`, `limit` e `offset`. Limite máximo por
endpoint entre 100 e 200.

---

## Rate limiting

Global: 300 requisições/minuto por usuário autenticado (por IP quando anônimo).
Compartilhado entre réplicas via Redis — limite em memória por processo é
contornável escalando horizontalmente.

Limites mais apertados onde importa:

| Rota | Limite |
|---|---|
| `POST /v1/auth/login` | 20 / 15 min |
| `POST /v1/auth/register` | 10 / hora |
| `POST /v1/auth/password/forgot` | 5 / hora |
| `POST /v1/ai/suggest` | 60 / hora |
| `POST /v1/webhooks/:platform` | 1000 / min |

Health checks nunca são barrados.

---

## Endpoints por área

### Publicação — o fluxo central

```http
POST /v1/posts/preview
```

Resolve grupos e contas na lista final de destinos e **valida cada um**, sem
agendar nada. É a tela de confirmação exigida pela SPEC seção 6.1.

```json
{
  "contentId": "uuid",
  "selection": { "groupIds": ["uuid"], "accountIds": ["uuid"] },
  "schedule": { "mode": "SPECIFIC_TIME", "localDateTime": "2026-09-14T10:00" }
}
```

A resposta traz, **por destino**: o nome real do perfil, o horário já
convertido para o fuso **daquela conta**, o texto resolvido pela cascata
(override da conta > variação da rede > mestre) e a lista de problemas com
severidade. Mais `excluded` — as contas que o grupo trazia mas o usuário não
pode publicar, **com o motivo**.

`localDateTime` é **hora local**, sem fuso: ela é interpretada no fuso de cada
conta de destino. Mandar um ISO com offset perderia justamente essa
propriedade.

```http
POST /v1/posts                        cria e agenda (Idempotency-Key)
POST /v1/posts/:id/schedule           reagenda
POST /v1/posts/:id/retry              reprocessa SÓ os destinos que falharam
POST /v1/posts/:id/cancel             cancela destinos pendentes
GET  /v1/posts                        calendário e fila (filtra por grupo/conta)
GET  /v1/posts/:id                    detalhe com o estado de cada destino
```

```http
POST /v1/groups/:id/apply-to-future   { "dryRun": true }
```

Ação **explícita** de propagar a composição atual de um grupo para os
agendamentos futuros. Com `dryRun`, devolve o preview do que mudaria. Mudar um
grupo **nunca** altera agendamento existente sozinho.

### Demais áreas

| Área | Endpoints |
|---|---|
| **Autenticação** | `register`, `login`, `login/mfa`, `refresh`, `logout`, `logout-all`, `me`, `verify-email`, `password/*`, `invite/accept`, `2fa/*` |
| **Organização** | `GET/PATCH /organization`, `members`, `members/invite`, `audit-log`, `deletion-request` |
| **Clientes** | CRUD em `/clients` |
| **Contas** | `/accounts`, `/accounts/:id/disconnect`, `/oauth/:platform/start`, `/oauth/:platform/callback` |
| **Grupos** | `/groups`, `/groups/:id/members`, `/groups/resolve`, `/groups/:id/schedule`, `/accounts/:id/schedule` |
| **Mídia** | `/media` (multipart), `/media-folders` |
| **Conteúdo** | `/contents`, `/contents/:id/variants` |
| **Aprovação** | `/approvals`, `/posts/:id/request-approval`, `/approvals/:id/decide`, `/approvals/:id/comments` |
| **Campanhas** | `/campaigns`, `/campaigns/:id/metrics` |
| **Analytics** | `/analytics/overview`, `/analytics/series`, `/analytics/accounts` |
| **Relatórios** | `/reports` (assíncrono, 202 + polling) |
| **Inbox** | `/inbox`, `/inbox/:id/read`, `/inbox/:id/reply` |
| **IA** | `/ai/status`, `/ai/suggest`, `/contents/:id/ai-review` |
| **Billing** | `/billing/plans`, `/billing/subscription`, `/billing/change-plan`, `/feature-flags` |
| **Plataformas** | `GET /platforms` — capacidades, cotas e políticas de cada rede |
| **Admin** | `/admin/overview`, `/admin/dead-letter`, `/admin/circuits/:p/reset`, `/admin/organizations`, `/admin/queues/:q/failed` |

---

## Módulo de IA Universal Híbrido

O sistema suporta três classes de provedores com fallback transparente:
1. **OpenAI-Compatible (`openai-compatible`)**: Suporta Google Gemini (via endpoint OpenAI do Google AI Studio), OpenRouter, Ollama (local), OpenAI e Groq. Configurado via `AI_BASE_URL`, `AI_API_KEY` e `AI_MODEL`.
2. **Anthropic Claude (`anthropic`)**: Suportado via `ANTHROPIC_API_KEY`.
3. **Motor Heurístico Local (`local-draft`)**: Quando nenhuma chave está presente ou em caso de falha de rede remota, opera de forma 100% determinística e sem custo, gerando ganchos, legendas, títulos e hashtags que respeitam rigorosamente os limites da plataforma.

### Endpoints
- `GET /v1/ai/status`:
  Retorna `{ configured: boolean, provider: string, model: string | null, reason: string | null }`.
- `POST /v1/ai/suggest`:
  Corpo:
  ```json
  {
    "kind": "CAPTION",
    "platform": "INSTAGRAM",
    "brief": "Lançamento da nova funcionalidade...",
    "tone": "profissional",
    "count": 3
  }
  ```
  Retorna `{ suggestions: string[], requiresHumanReview: true, provider: string, constraints: { ... } }`.
- `POST /v1/contents/:id/ai-review`:
  Registra a aprovação humana de um conteúdo gerado por IA (`aiReviewedAt = now()`). O worker rejeita publicar conteúdos marcados com `aiGenerated = true` sem esta confirmação.

---

## Anti-Spam Fan-Out (`staggerMinutes`)

Ao agendar publicações para múltiplos destinos (contas individuais ou grupos), a API permite distribuir os envios no tempo:

```json
{
  "contentId": "...",
  "selection": { "groupIds": ["..."] },
  "schedule": {
    "mode": "SPECIFIC_TIME",
    "localDateTime": "2026-09-14T10:00",
    "staggerMinutes": 5
  }
}
```

Cada destino subsequente recebe um atraso determinístico de `index * staggerMinutes * 60_000` ms sobre o instante agendado, garantindo conformidade com as diretrizes contra disparo em massa das plataformas sociais.

---

## Reconciliação de Destinos Órfãos (Outbox Pattern)

O worker executa a cada 2 minutos o job repetível `JOB_RECONCILE_ORPHANS`. Qualquer publicação em estado `SCHEDULED` com horário vencido ou `QUEUED` sem job ativo no Redis é identificada e reenfileirada com atraso zero de maneira estritamente idempotente.

---

## Upload de mídia

`POST /v1/media` com `multipart/form-data`, campo `file`. Campos opcionais:
`clientId`, `folderId`, `tags`, `replacesAssetId`.

O tipo é determinado pela **assinatura do conteúdo**, não pelo `Content-Type`
declarado — que é do cliente e não é confiável. Arquivos idênticos (mesmo
SHA-256) são deduplicados e devolvem `deduplicated: true`.

URLs de mídia **nunca são persistidas**: o bucket é privado e cada resposta
assina uma URL temporária (15 min). Uma URL permanente viraria link público no
primeiro relatório exportado.

---

## Webhooks

```http
GET  /v1/webhooks/:platform    desafio de verificação de subscrição
POST /v1/webhooks/:platform    recebe eventos
```

Três garantias, nesta ordem: **assinatura verificada** sobre o corpo **cru**
(recalcular sobre o JSON re-serializado falha, porque a ordem das chaves muda),
**resposta imediata** com processamento assíncrono (plataformas desativam
webhooks lentos) e **idempotência** por `(plataforma, id do evento)` —
reentrega é comportamento normal, não exceção.

Plataforma sem verificador implementado recebe **501**. Aceitar evento não
verificado seria uma porta aberta.

---

## Convenções de escrita

- Datas em **ISO 8601 UTC**, exceto `localDateTime` (hora local, sem fuso).
- `PATCH` aceita campos parciais; `null` explícito limpa, ausente não altera.
- Exclusão é **soft-delete** — histórico e relatórios emitidos continuam
  coerentes. A remoção definitiva vem da política de retenção ou do fluxo de
  exclusão da LGPD.
- `204 No Content` em operações sem corpo de resposta.
- `202 Accepted` no que é assíncrono (relatórios).
