# Status do projeto

Atualizado em **11/09/2026**.

---

## Onde o projeto está

Todas as fases do roadmap (SPEC seção 17) foram implementadas **até onde
credenciais externas permitem**. O sistema builda, sobe e roda ponta a ponta.

| Fase | Escopo | Estado |
|---|---|---|
| **0** | Walking skeleton | ✅ Estrutura completa; publicação real **bloqueada por credenciais** |
| **1** | Auth, organizações, RBAC | ✅ Completa |
| **2** | Contas sociais + grupos | ✅ Completa (OAuth aguarda credenciais) |
| **3** | Biblioteca de mídia | ✅ Completa |
| **4** | Compositor | ✅ Completa (com assistente criativo de IA e preview detalhado) |
| **5** | Agendamento e engine de publicação | ✅ Completa (Anti-spam fan-out com `staggerMinutes` e poller de reconciliação de órfãos a cada 2 min) |
| **6** | Instagram / Facebook | ✅ Completa (adapters implementados e testados) |
| **7** | TikTok | ✅ Completa (adapter implementado e testado) |
| **8** | YouTube (completo) | ✅ Completa (adapter implementado e testado) |
| **9** | X | ✅ Completa (adapter implementado e testado) |
| **10** | Kwai | 🚫 **Fora da v1** — não há API oficial de publicação |
| **11** | Analytics | ✅ Completa |
| **12** | Workflow de aprovação | ✅ Completa |
| **13** | Módulo de IA Universal Híbrido | ✅ Completa (OpenAI-compatible, Anthropic Claude e gerador local determinístico de rascunhos com revisão humana obrigatória) |
| **14** | Billing | ✅ Limites e planos; **sem gateway de pagamento** |
| **15** | Hardening | ✅ Documentado; itens de produção listados abaixo |

**Verificação:** 135 testes automatizados (75 no core + 34 no platform + 18 no worker + 8 na api) todos passando com sucesso contra Postgres real e BullMQ. Build e typecheck limpos em todos os pacotes.


---

## 🔴 O que depende de você

Esta é a lista completa do que **eu não consigo fazer** e que bloqueia o
produto de publicar de verdade.

### 1. Credenciais do YouTube (desbloqueia a Fase 0 inteira)

É a mais fácil das seis — self-serve, sem revisão, e a única que aceita
`http://localhost` como callback.

1. [Google Cloud Console](https://console.cloud.google.com/) → novo projeto
2. Ativar **YouTube Data API v3**
3. *OAuth consent screen* → modo **Testing** (até 100 usuários, sem verificação)
4. *Credentials* → **OAuth client ID** → *Web application*
   Redirect URI: `http://localhost:3001/v1/oauth/youtube/callback`
5. Preencher no `.env`:
   ```
   YOUTUBE_CLIENT_ID=...
   YOUTUBE_CLIENT_SECRET=...
   ```

Feito isso, o fluxo completo funciona: conectar canal → compor → agendar →
worker publica → ver o vídeo no ar.

**Limite a saber:** 100 uploads/dia **por projeto**, compartilhado por todos os
clientes do SaaS. E sem auditoria de conformidade do YouTube, todo vídeo sai
como "privado" — independentemente da visibilidade escolhida.

### 2. Túnel HTTPS (para as outras redes)

Meta, TikTok e X **não aceitam `localhost`** como redirect URI.

```bash
cloudflared tunnel --url http://localhost:3001
# depois, no .env:
OAUTH_PUBLIC_URL=https://sua-url.trycloudflare.com
```

### 3. Aprovações externas, por rede

| Rede | O que pedir |
|---|---|
| **Meta** (IG/FB) | App + verificação de negócio + App Review das permissões de publicação + conta profissional vinculada a Página |
| **TikTok** | App + **auditoria** — sem ela, todo conteúdo sai `SELF_ONLY` e no máximo 5 usuários publicam por dia |
| **X** | **Plano pago** com permissão de escrita |

O passo a passo de cada uma está em
[`SOCIAL_INTEGRATIONS.md`](SOCIAL_INTEGRATIONS.md).

### 4. Decisões de produto que preciso que você tome

- **Kwai fica fora da v1?** Confirmei em 10/09/2026 que não existe API pública
  de publicação para terceiros — só a de anúncios. A alternativa seria scraping,
  que a SPEC seção 19 proíbe e que eu não implementei.
- **Gateway de pagamento** — qual? A estrutura de planos e limites está pronta;
  falta a integração de cobrança, que exige credenciais e contrato.
- **Cota do YouTube** — 100 uploads/dia por projeto é o teto **do SaaS
  inteiro**. Vale pedir aumento ao Google antes de vender para agências com
  volume.

---

## Decisões técnicas tomadas

O raciocínio completo está em [`ARCHITECTURE.md`](ARCHITECTURE.md). O resumo:

1. **Fastify em vez de NestJS.** A SPEC permite "arquitetura modular
   equivalente". Fastify tem type provider Zod de primeira classe (o mesmo
   schema valida e documenta) e menos peças móveis para o alvo de p95.
2. **`packages/platform` compartilhado entre API e worker.** Adapter, token,
   cota e circuit breaker precisam ser idênticos nos dois — se divergissem, o
   worker publicaria sob regra que a API não aplicou.
3. **Circuit breaker persistido no banco**, não em memória: o worker escala
   horizontalmente, e um breaker por processo não protegeria nada.
4. **Testes do worker contra Postgres real.** As garantias testadas são do
   banco; um banco falso as tornaria vazias.
5. **Luxon para fuso horário.** Offset fixo produz posts uma hora errados duas
   vezes por ano, na virada do horário de verão.
6. **Estado da rede social separado do estado da credencial.** "Implementada" e
   "tem credencial neste ambiente" são perguntas diferentes, e a UI responde as
   duas.

---

## Bugs encontrados e corrigidos durante a implementação

Cinco problemas reais que só apareceram ao montar o sistema:

**1. `z.coerce.boolean()` lê `"false"` como `true`.**
Em JavaScript a string `"false"` é *truthy*. Afetava `COOKIE_SECURE` (cookie
inseguro viraria seguro em dev, e vice-versa) e `SMTP_SECURE` — este último
causava `wrong version number` ao tentar TLS numa porta em texto claro.
Substituído por um parser que compara o texto explicitamente.

**2. `@@unique` com coluna anulável não impede duplicatas no Postgres.**
Dois `NULL` não colidem numa restrição `UNIQUE`. Isso afetava:
- `PlatformQuotaUsage` — a linha de cota de app se duplicaria por worker
  concorrente, e **o limite compartilhado nunca seria atingido**;
- `AnalyticsSnapshot` — o snapshot de conta duplicaria a cada coleta,
  **dobrando os números** em qualquer gráfico.

Corrigido com uma coluna `scopeKey` **não-nula** dentro da restrição.

**3. `MANAGER` tinha `report:generate` mas não `report:read`.**
Dava para gerar um relatório e não conseguir listá-lo nem baixá-lo. Encontrado
pelo teste de fumaça; corrigido com teste de regressão que exige as duas
permissões juntas.

**4. Os Dockerfiles de produção não construíam.**
Foram escritos antes de `@app/platform` existir e nunca copiavam nem
compilavam o pacote. Além disso, `pnpm deploy --prod` monta um
`node_modules` novo e o Prisma Client gerado ficava para trás — a imagem
subia e morria com *"@prisma/client did not initialize yet"*. Corrigido
emitindo o client **dentro** do pacote (`packages/db/generated`), que o
deploy carrega junto. As três imagens agora constroem, e a da API passa nas
35 verificações do teste de fumaça rodando em container.

**5. Falha de SMTP derrubava o cadastro.**
A conta era criada e a requisição respondia 500. Agora o envio do e-mail de
verificação falha em silêncio (com log de erro) e o usuário pode pedir reenvio.

---

## Verificações de conformidade com a SPEC

Cenários da seção 21 cobertos por teste automatizado:

| Cenário | Onde |
|---|---|
| 20 contas, 3 falham → 17 publicam, `PARTIALLY_PUBLISHED` | `publish.test.ts` |
| Reprocessar só as que falharam, sem republicar as demais | `publish.test.ts` |
| Dois workers em paralelo publicam **uma vez só** | `publish.test.ts` |
| Reprocessar o mesmo job não publica duas vezes | `publish.test.ts` |
| Token expirado falha na hora, sem queimar 5 tentativas | `publish.test.ts` |
| Esgotar tentativas registra na dead-letter | `publish.test.ts` |
| Cota consumida e **devolvida** em falha permanente | `publish.test.ts` |
| Circuit breaker abre e recusa sem chamar a plataforma | `publish.test.ts` |
| Conteúdo de IA não revisado é bloqueado na publicação | `publish.test.ts` |
| **Mesmo conteúdo em duas contas do X → bloqueado** | `target-validator.test.ts` |
| Cota do dia estourada detectada no agendamento | `target-validator.test.ts` |
| Lote de 20 contado junto contra a cota de app | `target-validator.test.ts` |
| Grupo com conta sem permissão não derruba o resto | `permissions.test.ts` |
| Post para conta com fuso diferente do usuário | `scheduling.test.ts` |
| Horário de verão (ida e volta preserva a hora de parede) | `scheduling.test.ts` |
| Conta sem grade de fila não derruba as outras do grupo | `scheduling.test.ts` |
| Ressincronizar a inbox não duplica nem desmarca o que já foi lido | `inbox.test.ts` |
| Falha num post não impede a inbox dos outros | `inbox.test.ts` |
| Duplicar publicação não compartilha o conteúdo com a original | `duplicate.test.ts` |
| Duplicar NÃO reexpande o grupo (mudança de grupo não vaza) | `duplicate.test.ts` |
| Alerta não dispara com amostra pequena (1 falha em 1 = 100%) | `alerts.test.ts` |

---

## O que foi fechado depois dos adapters

**Reaproveitamento de conteúdo.** `POST /v1/posts/:postId/duplicate` cria uma
publicação nova ligada à original por `duplicatedFromId`. Por padrão COPIA o
conteúdo — se apontasse para o mesmo `Content`, editar a republicação
reescreveria o texto de um post que já saiu no ar — e reaproveita exatamente
as contas de destino da origem, sem reexpandir o grupo (reexpandir faria a
cópia herdar contas que entraram depois, que é a alteração silenciosa que a
SPEC seção 6.1 proíbe). A cópia passa pela mesma validação: duplicar para uma
segunda conta do X continua bloqueado.

**Sincronização da inbox.** Um job varre, a cada 15 min, as contas ativas de
redes que oferecem comentários por API oficial e enfileira uma rodada por
conta (`jobId` determinístico, para duas réplicas não sincronizarem a mesma
conta em paralelo). Cada rodada busca os comentários das publicações dos
últimos 14 dias, com teto de 50 posts — varrer o histórico inteiro queimaria
cota sem trazer nada novo. A gravação é idempotente pela UNIQUE
`(conta, id remoto)`, e a ressincronização não toca em `isRead`/`isReplied`:
o estado de leitura é nosso, não da plataforma.

**Alertas operacionais.** Um job avalia a cada 5 min as mesmas métricas do
painel admin contra limiares configuráveis (`ALERT_*` no `.env.example`) e
dispara: circuito aberto, taxa de falha por plataforma, dead-letter acumulada,
fila crescendo e contas pedindo reconexão. Todo alerta vai para o log em nível
de erro; o e-mail só sai se `ALERT_EMAIL` estiver preenchido. O silêncio
pós-disparo é guardado no Redis com `SET NX EX`, que é atômico — com duas
réplicas avaliando ao mesmo tempo, só uma manda o e-mail.

---

## Pendências conhecidas

**Adapters das redes oficiais:** Todos os adapters previstos para a v1 (YouTube, Instagram, Facebook, TikTok e X) estão escritos, registrados e cobertos por testes automatizados no pacote `@app/platform`. Kwai permanece fora da v1 conforme decisão documentada na SPEC seção 3.

**Teste de carga — medido.** `pnpm load:api` + `pnpm load:test`. Os dois alvos
da seção 2 foram atingidos: todos os endpoints síncronos ficam bem abaixo dos
300ms no p95 com 50 requisições em voo, e a fila entrega os jobs 90ms (p95)
depois do horário agendado, contra um alvo de "poucos minutos".

O limite prático está no `preview`, o endpoint mais pesado: com 50 destinos
ele sustenta ~120 req/s por processo e cruza os 300ms por volta de 30 previews
simultâneos. É saturação, não defeito — a latência ali é `concorrência ÷
vazão`, e a API é stateless justamente para escalar horizontalmente. Números,
procedimento e duas armadilhas de interpretação estão em `DEPLOYMENT.md`.

**Sentry.** Os alertas operacionais já rodam (job a cada 5 min, ver abaixo) e
saem no log em nível de erro, que é o canal que qualquer coletor capta sem
acoplar o worker a um fornecedor. Ligar o SDK do Sentry propriamente dito —
com stack trace e agrupamento de exceção — continua pendente; o `SENTRY_DSN`
está previsto no `.env` e hoje não é lido por ninguém.

**Aviso de depreciação do Fastify.** `disableRequestLogging` sai no Fastify 6,
substituída por `logController` — que exige implementar um contrato de 10
métodos, não só trocar o nome. Fica para o upgrade; até lá a opção funciona.

**Teste de restauração de backup.** O procedimento está documentado em
`DEPLOYMENT.md` e nunca foi executado neste ambiente. Backup não restaurado não
é backup confiável.

---

## Como retomar

```bash
pnpm install
pnpm docker:up && pnpm db:deploy && pnpm db:seed
pnpm dev
node infra/scripts/smoke-test.mjs
```

Se algo não subir, os três suspeitos usuais: Docker Desktop parado, `.env` sem
os segredos gerados, ou porta ocupada (5433/6380/3000/3001).
