# Progresso de implementação

Registro retomável de trabalho: cada ciclo lista problema, mudança, arquivos,
verificação e próximos passos. Para contexto vivo do projeto, ver `STATUS.md`;
para as decisões maiores, `ARCHITECTURE.md`.

---

## Ciclo 2026-10-03 — Confiabilidade do motor de publicação (1º ciclo das diretrizes de revisão)

**Base do ciclo:** commit `a51c8f7` (main). Análise estática externa havia
apontado 5 grupos de defeitos; todos foram reconfirmados no código antes de
qualquer mudança.

**Ambiente de verificação:** Node 25.0.0, pnpm 11.25.0, BullMQ **5.81.4**
(lockfile), Prisma 6.19.3, Postgres 16 + Redis 7 + MinIO via docker compose
(portas 5433/6380/9000). Banco de teste separado (`gerenciador_test`) e
prefixo de fila isolado (`grs-test`).

### Baseline antes das correções

- worker: 47/48 — 1 falha PREEXISTENTE reproduzível: `stuck-publishing.test.ts`
  fixava `windowDate` na meia-noite UTC e falhava quando a corrida cruzava o
  reset da cota do YouTube (07:00 UTC). Dependia da hora do dia.
- api 16/16, core 75/75, platform 52/52; typecheck limpo.
- `pnpm lint` quebrado em TODOS os pacotes (ESLint 9 sem `eslint.config`;
  `next lint` do web entra em prompt interativo). Baseline, não regressão.

### A. "Envio aceito" ≠ "publicação concluída"

**Problema:** `publishNow` gravava `PUBLISHED` ao receber o resultado do
adapter, ignorando `processingPending`. Nenhum consumidor chamava
`fetchRemoteState` (o contrato `JOB_CHECK_REMOTE_STATE` existia sem uso).

**Mudança:** novo status `PostTarget.PROCESSING` + colunas
`remoteOperationId` e `processingDeadlineAt` (migration
`20261003021311_processamento_remoto`). O envio aceito grava PROCESSING com o
identificador da OPERAÇÃO (no TikTok, `publish_id` não é o id público — o id
público só chega no `PUBLISH_COMPLETE`, via `fetchRemoteState`) e agenda o job
durável `check-remote-state`, que reagenda a si mesmo com
`moveToDelayed`+`DelayedError` (não consome tentativa) até READY/REJECTED ou o
prazo (`REMOTE_STATE_MAX_WINDOW_MS`, 24h). Varredura
`maintenance:reconcile-processing` (5 min) recoloca jobs perdidos e aplica o
prazo quando a cadeia morre. Sucesso notifica; processamento pendente, não.

**Arquivos:** `packages/db/prisma/schema.prisma` + migration,
`packages/core/src/jobs/contracts.ts`, `apps/worker/src/processors/publish.ts`,
`apps/worker/src/processors/remote-state.ts` (novo),
`apps/worker/src/processors/maintenance.ts`, `apps/worker/src/main.ts`,
`apps/worker/src/config/env.ts`, `apps/worker/src/lib/post-status.ts`,
`packages/platform/src/adapters/tiktok/publisher.ts`,
`apps/api` (agregações em posts/media/campaigns), `apps/web` (rótulo PROCESSING).

**Prova:** `apps/worker/src/processors/remote-state.test.ts` (9 testes):
PROCESSING→READY, PROCESSING→REJECTED (sem devolver cota), timeout como
desconhecido, consulta repetida não re-notifica, job perdido reenfileirado sem
refazer upload.

### B. Reagendamento com BullMQ real

**Problema:** `handleFailure` chamava `job.changeDelay` em job ATIVO (cota e
circuito). O BullMQ 5 restringe `changeDelay` a jobs delayed — num job ativo
lança `JobNotInState`; o dublê de teste (`changeDelay: grava valor`) escondia
isso.

**Mudança:** `moveToDelayed(timestamp, token)` + `throw new DelayedError()`.

**Descoberta adicional durante a validação:** O BullMQ 5.81.4 PROÍBE `:` em
`jobId` customizado ("Custom Id cannot contain :") — todos os geradores de id
usavam `:` (`publish:`, `token:`, `inbox:`, `report:`, `metrics:`,
`repeat:*`). Sem esta correção, agendar pela API quebrava no BullMQ resolvido.
Separador trocado para `_`.

**Arquivos:** `apps/worker/src/processors/publish.ts`,
`packages/core/src/jobs/contracts.ts`, `apps/worker/src/main.ts`,
`apps/worker/src/processors/inbox.ts`, `apps/api/src/modules/reports/routes.ts`,
`apps/worker/src/test/harness.ts` (dublê sem `changeDelay`, para a regressão
falhar), `apps/worker/src/processors/inbox.test.ts`.

**Prova:** `apps/worker/src/processors/publish-queue.integration.test.ts` com
Queue+Worker reais (Redis isolado por prefixo): cota estourada e circuito
aberto deixam o job em `delayed` SEM consumir tentativa, sem publicar e sem
chamar a plataforma; o job reaparece no horário e publica uma vez.

### C. Revisão de IA atravessa interface, API e worker

**Problema:** o compositor aplicava sugestões sem enviar `aiGenerated` (o save
não carregava o campo); `ContentService.update` marcava `aiReviewedAt` sozinho
na primeira edição — autosave funcionava como "revisão".

**Mudança:** migration `20261003033347_revisao_ia_versionada` (`aiReviewHash`).
A revisão (`POST /contents/:id/ai-review`) grava o hash sha256 da versão
revisada (texto + hashtags + variações + campos de plataforma). `update` e
`setVariants` invalidam a revisão quando o conteúdo que vai para a rede muda
(comparação de hash: reenvio idêntico, que o compositor faz a cada preview,
não invalida). O validador do agendamento ganhou `AI_REVIEW_REQUIRED` como
erro bloqueante. O compositor declara a proveniência (`aiGenerated: true` ao
aplicar sugestão) e oferece o botão explícito "Registrar revisão humana".

**Arquivos:** `apps/api/src/lib/ai-review.ts` (novo), `contents/service.ts`,
`contents/routes.ts`, `ai/routes.ts`, `packages/core/src/validation/target-validator.ts`,
`posts/service.ts` (preview), `apps/web/.../compositor/page.tsx`.

**Prova:** `apps/api/src/modules/contents/ai-review.test.ts` (6 testes —
cadeia completa gerar→aplicar→salvar→bloquear→revisar→permitir→modificar→
exigir de novo, incluindo variações e mídia) + 2 casos no target-validator +
2 no worker (revisado publica; revisão invalidada bloqueia).

### D. Exclusão e retenção alcançam o storage

**Problema:** `applyRetention` e `processDataDeletion` apagavam linhas sem
remover os objetos do bucket; a interface de storage do worker nem expunha
`deleteObject`. Bônus: `processDataDeletion` travaria no sucesso (atualizava
o pedido DEPOIS do cascade da organização apagar a linha dele — P2025).

**Mudança:** `Storage.deleteObject` (idempotente no S3/MinIO); retenção remove
objeto e miniatura antes da linha, tolera falha por objeto e retoma na rodada
seguinte; relatórios expirados perdem o arquivo junto; a exclusão LGPD remove
todos os objetos (mídia + relatórios) antes de derrubar a organização, com
falha parcial devolvendo o pedido a CONFIRMED para retry, e a marca de
COMPLETED antes do cascade. `DEPLOYMENT.md` documenta o bucket sem
versionamento (senão o expurgo cria delete markers e os bytes ficam).

**Prova:** `apps/worker/src/processors/storage-purge.test.ts` (6 testes —
ordem objeto→linha, retenção não vencida intacta, falha retomável, relatório
expirado, exclusão total, falha parcial com retry).

### E. Resultado desconhecido e retentativas

**Problema:** `retryFailed` aceitava `PUBLISH_INTERRUPTED_UNVERIFIED` como
falha comum (risco de publicação dupla), e a cota era devolvida mesmo quando
o timeout aconteceu DEPOIS do envio (a plataforma pode ter cobrado).

**Mudança:** `UNVERIFIED_OUTCOME_CODES` no core. Retry: falha confirmada volta
à fila; desconhecido COM identificador de operação volta a PROCESSING e só a
verificação reenfileira (sem novo upload); desconhecido SEM identificador
exige `acknowledgeUnverified` (auditado) — a UI da fila mostra modal com o
risco. Na falha definitiva, a cota só é devolvida quando a chamada não saiu
ou foi recusada na autenticação (401 não consome a janela de upload);
`recoverStuckPublishing` segue a mesma régua. Não prometemos exclusividade de
publicação que a API remota não garante: nesses casos o sistema pede decisão.

**Arquivos:** `packages/core/src/errors.ts`, `apps/api/src/modules/posts/service.ts`
+ `routes.ts`, `apps/worker/src/processors/publish.ts` + `maintenance.ts`,
`apps/web/.../fila/page.tsx`.

**Prova:** `apps/api/src/modules/posts/retry.test.ts` (4 testes) + 1 teste de
cota após timeout no worker.

### Resultado do ciclo

| Pacote | Antes | Depois |
|---|---|---|
| worker | 47✓/1✗ (1 falha de baseline) | 68✓ |
| api | 16✓ | 26✓ |
| core | 75✓ | 77✓ |
| platform | 52✓ | 52✓ |

Typecheck limpo nos 9 pacotes. `pnpm worker:check` ok. Stack de dev sobe
inteira (`pnpm dev`) e o smoke test passa **36/36** (`infra/scripts/smoke-test.mjs`).

### Não validado neste ciclo (pendências honestas)

- Nenhuma chamada real às redes sociais: OAuth/TOKEN/publicação reais continuam
  bloqueados por credenciais (ver STATUS.md). O fluxo PROCESSING→READY foi
  provado contra as implementações de `fetchRemoteState` com o adapter falso;
  a resposta real do TikTok/YouTube/Facebook na conta de teste é a validação
  externa pendente.
- `pnpm lint` quebrado em todo o repo (ESLint 9 sem `eslint.config.js`,
  `next lint` interativo no web). Preexistente; corrigir no próximo ciclo.
- E2E pela interface (browser) não foi executado; a UI foi coberta por
  typecheck.
- Falha de banco depois do sucesso remoto: coberta pelo caminho
  PUBLISH_INTERRUPTED_UNVERIFIED já existente (testado), não por injeção nova.

### Próximo passo recomendado

1. Corrigir o lint (ESLint flat config por pacote) — hoje nenhum guarda-chuva
   de estilo funciona.
2. Com credenciais de teste do YouTube, validar o ciclo completo
   conectar→publicar→confirmar numa conta real autorizada (o STATUS lista o
   passo a passo).
3. Depois: ordem de evolução item 2 (compositor/calendário) ou benchmark
   medido contra Postiz em tarefa equivalente.
