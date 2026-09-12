# Arquitetura

Este documento registra **por que** cada decisão foi tomada. O "o quê" está no
código; o "porquê" não sobrevive sem ser escrito.

---

## Visão geral

```
┌──────────────┐     HTTP      ┌──────────────┐
│  Next.js     │ ────────────► │  Fastify API │
│  (browser)   │ ◄──────────── │   apps/api   │
└──────────────┘   JSON/OpenAPI└──────┬───────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
              ┌──────────┐     ┌───────────┐     ┌───────────┐
              │ Postgres │     │   Redis   │     │   MinIO   │
              │  Prisma  │     │  BullMQ   │     │    S3     │
              └────▲─────┘     └─────▲─────┘     └─────▲─────┘
                   │                 │                 │
                   └─────────┬───────┴─────────────────┘
                             ▼
                     ┌───────────────┐        ┌──────────────────┐
                     │    Worker     │ ─────► │ APIs das redes   │
                     │ apps/worker   │        │ (YouTube, ...)   │
                     └───────────────┘        └──────────────────┘
```

**API e worker são processos separados.** A API precisa responder em ~300ms no
p95 (SPEC seção 2); o worker passa minutos enviando vídeo. Num processo só, um
upload grande seguraria o event loop e derrubaria o p95 de todo mundo. Ambos
escalam horizontalmente de forma independente.

---

## Escolhas de stack

| Camada | Escolha | Por quê |
|---|---|---|
| API | **Fastify 5** | A SPEC permite "NestJS ou arquitetura modular equivalente". Fastify tem ~2x a vazão do Express, type provider Zod de primeira classe (o mesmo schema valida e documenta) e OpenAPI nativo. A modularidade vem de composição explícita em vez de DI por decorator — menos peças móveis para o alvo de p95 |
| Banco | **PostgreSQL 16 + Prisma** | Prisma dá migrations versionadas, tipos derivados do schema e `@@unique` composta — que é o que sustenta a idempotência por destino |
| Fila | **Redis 7 + BullMQ** | Jobs atrasados nativos (agendamento), `jobId` determinístico (deduplicação) e retry com backoff. `appendonly` ligado: job agendado não pode sumir num restart |
| Storage | **S3-compatible** atrás de `StorageProvider` | MinIO em dev, S3/R2 em produção. Trocar é configuração, não código |
| Frontend | **Next.js 15 + Tailwind** | App Router, build standalone para container enxuto |
| Auth | **JWT próprio + argon2id** | A SPEC pede "Auth.js ou equivalente seguro". Auth.js é centrado no Next; para uma API separada, JWT curto + refresh opaco rotacionado é equivalente e não acopla o backend ao framework do front |

---

## As cinco decisões que definem o produto

### 1. `PostTarget` é a unidade de publicação

`Post` **não tem** horário nem status de publicação. Quem publica é o
`PostTarget` — um por conta de destino.

Uma publicação para um grupo de 20 contas é 1 `Post` e 20 `PostTarget`, cada
um com seu `scheduledAt`, `status`, `attempts`, `remoteId` e `errorMessage`.

Consequências diretas:

- falha em 3 destinos não afeta os outros 17 — não há transação abrangendo
  destinos, e o job é **por destino**;
- "tentar novamente" filtra por `status: FAILED` e toca só neles;
- `Post.status` é **derivado**, recalculado a partir dos destinos.
  `PARTIALLY_PUBLISHED` existe porque 17 sucessos e 3 falhas não é "publicado"
  nem "falhou", e chamar de um dos dois esconderia exatamente o que o usuário
  precisa ver.

Este desenho vale **desde a Fase 0**, com uma conta só. Migrar depois de "um
post, um horário" para "um post, N destinos" custaria reescrever agendamento,
worker, calendário e relatórios.

### 2. Idempotência em duas camadas

**Camada 1 — o banco.** `@@unique([postId, socialAccountId])` em `PostTarget`.
É estrutural: nem uma corrida entre dois workers cria dois destinos para a
mesma conta.

**Camada 2 — o claim condicional.** Antes de qualquer chamada externa, o worker
faz um `UPDATE ... WHERE id = ? AND status IN ('SCHEDULED','QUEUED') AND
remoteId IS NULL`. Quem encontrar 0 linhas afetadas sai sem publicar. A decisão
é do banco, não de uma leitura anterior.

Somam-se a isso o `jobId` determinístico (`publish:<targetId>`), que faz o
BullMQ ignorar um job já enfileirado, e a checagem de `remoteId` na entrada.

O teste `dois workers em paralelo publicam uma vez só` exercita exatamente
isso, contra Postgres real.

### 3. Fuso horário mora na conta

Todo horário é persistido em **UTC**. A conversão acontece no fuso da **conta
de destino**, nunca no do navegador de quem agendou.

"Segunda às 10h" para um grupo com contas em São Paulo e em Lisboa produz
**dois instantes UTC diferentes** — e isso está certo. A interface mostra o
fuso junto do horário em toda listagem, e o preview avisa quando os destinos
divergem.

Usamos **Luxon** porque a conversão precisa acertar horário de verão: a mesma
hora de parede pode não existir (salto para frente) ou existir duas vezes
(volta atrás). Fazer isso com offset fixo produz posts uma hora errados duas
vezes por ano.

### 4. Grupo é atalho, nunca permissão

`AccountGroup` é N:N e **transversal** à hierarquia — não um nível dela. A
mesma conta pode estar em "Curiosidades" e em "Todos os TikToks".

Duas garantias:

- **Grupo não concede permissão.** `filterAccountsUserCanPublishTo` resolve o
  grupo, mantém só as contas em que o usuário pode publicar e devolve as
  excluídas **nomeadas, com o motivo** — em vez de falhar o agendamento
  inteiro ou, pior, publicar onde o usuário não podia.
- **Mudar o grupo não altera agendamento existente.** `Post.sourceGroupIds`
  guarda o snapshot do momento. Adicionar uma conta depois não faz ela herdar
  agendamentos antigos; remover não cancela nada em silêncio. Só a ação
  explícita "aplicar aos agendamentos futuros" propaga — com preview antes.

A grade de horários da fila mora na **conta**, não no grupo, porque o fuso mora
na conta. O grupo é só um atalho para configurar várias de uma vez.

### 5. Validar no agendamento, não na hora de publicar

`validateTargets` é uma **função pura**: recebe o estado, devolve problemas.
Não lê banco, não chama API, não persiste nada — é o que a torna testável
contra os cenários da SPEC seção 21.

Ela roda no preview do compositor e checa, por destino:

- requisitos de mídia (formato, tamanho, duração, proporção, contagem);
- campos obrigatórios da rede (privacidade, categoria, consentimento);
- cota do dia, **contando o lote junto** — 20 destinos consomem 20 da cota de
  app, não 1 cada um avaliado isoladamente;
- regra de conteúdo duplicado entre contas da mesma rede.

O ponto é a frase da especificação: *"nunca deixar para descobrir às 3h da
manhã, quando o job roda"*.

---

## Camadas e dependências

```
@app/core      →  (nada)
@app/db        →  @app/core
@app/platform  →  @app/core, @app/db
@app/api       →  @app/core, @app/db, @app/platform
@app/worker    →  @app/core, @app/db, @app/platform
@app/web       →  @app/core (só tipos)
```

**`@app/core`** é domínio puro. Não importa Prisma, Fastify, BullMQ nem SDK de
plataforma. Guarda as interfaces da SPEC seção 4 (`SocialPlatform`,
`SocialPublisher`, `SocialAnalytics`, `SocialMediaAdapter`), o registro de
capacidades, o validador, o cálculo de fuso e slots, o RBAC e a resiliência.

**`@app/platform`** é compartilhado por API e worker de propósito. Adapter,
renovação de token, contabilidade de cota e circuit breaker precisam ser
**exatamente os mesmos** nos dois processos — se divergissem, o worker
publicaria sob uma regra que a API não aplicou no agendamento.

`resolveVariantFor` vive no núcleo pelo mesmo motivo: a API a usa para montar
o preview e o worker para montar o que vai ser publicado. Duas implementações
fariam o publicado divergir do que a pessoa revisou.

---

## Adapters de plataforma

```typescript
interface SocialMediaAdapter {
  readonly platform: PlatformKey;
  readonly definition: PlatformDefinition;
  readonly auth: SocialAuthenticator;
  readonly publisher: SocialPublisher;
  readonly analytics?: SocialAnalytics;   // opcional
  readonly inbox?: SocialInbox;           // opcional
  readonly webhooks?: SocialWebhookVerifier; // opcional
}
```

As propriedades opcionais são a forma de dizer "esta rede não oferece isso por
API oficial". O núcleo verifica a ausência e responde ao usuário com a mensagem
da SPEC seção 3 — declarar um verificador vazio seria fingir suporte.

Um adapter **nunca**: decide se pode publicar (isso é do validador), persiste
nada (não conhece Prisma), re-tenta sozinho (o retry é do worker) ou simula uma
operação que a plataforma não oferece.

**Só entra no registro a rede que tem implementação.** Uma rede declarada mas
não implementada não ganha um adapter vazio — pedir por ela resulta em
`PlatformNotConfiguredError`.

---

## Resiliência

| Mecanismo | Onde | Detalhe |
|---|---|---|
| **Timeout** | Toda chamada externa | `withTimeout` combina o prazo com o `AbortSignal` do chamador, para o shutdown do worker cancelar requisições em voo |
| **Classificação de erro** | Adapter | Todo erro sai marcado como recuperável ou permanente. Sem isso, um token revogado consome 5 tentativas à toa e um rate limit temporário vira falha definitiva |
| **Backoff + jitter** | Worker | Jitter não é enfeite: sem ele, 20 destinos que falham juntos voltam ao mesmo tempo e derrubam a plataforma de novo |
| **Circuit breaker** | `SocialPlatform` (banco) | Persistido, **não em memória**: o worker escala horizontalmente, e um breaker por processo abriria e fecharia de forma independente em cada réplica |
| **Cota** | `PlatformQuotaUsage` | Reservada **antes** da chamada externa, com incremento atômico; devolvida em falha permanente. Estouro **reagenda** para depois do reset, sem gastar tentativa |
| **Dead-letter** | `DeadLetterJob` | Job que esgota o retry vira linha visível no painel admin. Nunca some silenciosamente |

### A armadilha do `NULL` em `UNIQUE`

Duas colunas do sistema precisam distinguir "escopo de conta" de "escopo
global". A modelagem óbvia — `socialAccountId` anulável na restrição `UNIQUE` —
**não funciona no Postgres**: dois `NULL` não colidem.

O efeito seria silencioso e grave:

- `PlatformQuotaUsage` criaria uma linha de cota de app por worker concorrente,
  e o limite compartilhado **nunca seria atingido**;
- `AnalyticsSnapshot` duplicaria o snapshot de conta a cada coleta,
  **dobrando os números** em qualquer gráfico.

A correção foi uma coluna `scopeKey` **não-nula** — o id da conta, ou a
constante `'APP'` / `'ACCOUNT'` — dentro da restrição. O `socialAccountId`
anulável continua existindo para as junções.

---

## Multi-tenant

Três camadas, porque uma só depende de alguém lembrar:

1. **Schema** — `organizationId` indexado em toda entidade de tenant.
2. **Consulta** — `tenantWhere(organizationId)` injeta o filtro e
   `deletedAt: null` juntos. Soft-delete que precisa ser lembrado a cada
   consulta acaba esquecido.
3. **Defesa** — `assertTenant` confere o dono de um registro carregado por id e
   transforma vazamento silencioso em exceção.

O papel do usuário é relido do banco **a cada requisição**, não confiado ao
JWT: uma remoção de acesso vale imediatamente, em vez de esperar o token de 15
minutos expirar. Rebaixamento e suspensão também revogam as sessões ativas.

---

## Fluxo de uma publicação

```
Compositor
   │  POST /v1/posts/preview
   ▼
Resolve grupos → filtra por permissão → calcula horário por fuso
   │
   ▼  valida cada destino (mídia, cota, duplicado, campos obrigatórios)
Preview na tela: conta por conta, nome real do perfil, horário local
   │
   │  POST /v1/posts  (Idempotency-Key)
   ▼
Cria Post + N PostTarget (UNIQUE por conta) → enfileira 1 job por destino
   │
   ▼  no horário
Worker: claim condicional → circuito → cota → token → variante → publica
   │
   ├─ sucesso    → PUBLISHED + remoteId + notificação
   ├─ recuperável→ SCHEDULED + backoff (se restam tentativas)
   ├─ cota       → SCHEDULED para depois do reset (sem gastar tentativa)
   └─ permanente → FAILED + devolve cota + dead-letter + notificação
   │
   ▼
Recalcula Post.status a partir dos destinos
```

---

## Observabilidade

Um **correlation ID** atravessa API → fila → worker → chamada externa. Ele
entra por header (sanitizado) ou é gerado, vai para o log de toda requisição,
para o payload do job, para `PostTarget.correlationId`, para `PublishAttempt` e
para a linha de dead-letter.

É o que permite pegar uma publicação que falhou às 3h da manhã e reconstruir o
caminho inteiro.

Os logs são estruturados (pino) com `redact` por caminho — token, senha,
cookie e header de autorização nunca chegam ao agregador. Redigir por caminho é
mais confiável do que depender de alguém lembrar em cada chamada de log.

`PublishAttempt` guarda **cada tentativa**, nunca sobrescrita: é o que permite
auditar por que um destino falhou 4 vezes antes de dar certo.

### Jobs periódicos

Além do job por destino, o worker registra agendadores com `jobId` fixo — o id
fixo impede que subir uma segunda réplica registre um segundo agendador para o
mesmo trabalho.

| Job | Intervalo | O que faz |
|---|---|---|
| `scan-expiring-tokens` | 30 min | Enfileira renovação dos tokens perto de expirar |
| `inbox:scan-accounts` | 15 min | Enfileira uma sincronização de inbox por conta ativa |
| `maintenance:evaluate-alerts` | 5 min | Compara as métricas técnicas com os limiares e dispara |
| `maintenance:recover-stuck-publishing` | 5 min | Destrava destinos presos em PUBLISHING por worker morto |
| `maintenance:reconcile-orphans` | 2 min | Reenfileira destinos agendados que ficaram sem job |
| `apply-retention` | 3h da manhã | Aplica a retenção da LGPD |

Os que abrem trabalho por conta (inbox, tokens) **separam o agendador do
trabalho**: o job periódico só enfileira, e quem executa é um job por conta.
É o que mantém cada conta como unidade independente de falha e de retry —
uma conta com token quebrado não impede a sincronização das outras 19.

### Alertas

O painel admin é **pull**: só avisa quem está olhando. `evaluate-alerts` é o
**push** — lê as mesmas métricas (circuitos, taxa de falha por plataforma,
dead-letter, profundidade de fila, contas pedindo reconexão) e dispara quando
passam dos limiares do `.env`.

Três decisões que evitam o alerta que ninguém lê:

- **Nenhum limiar no código.** Todos vêm do ambiente (`ALERT_*`), porque o que
  é ruído numa agência de 5 contas é emergência numa de 500.
- **Amostra mínima na taxa de falha.** Uma falha em uma tentativa é 100% e não
  significa nada; sem o piso, a primeira publicação com erro de uma rede nova
  acordaria a operação.
- **Silêncio pós-disparo no Redis, com `SET NX EX`.** É atômico: com duas
  réplicas avaliando ao mesmo tempo, só uma manda o e-mail. Em memória, sairia
  um e-mail por réplica a cada 5 minutos.

O canal que sempre existe é o **log em nível de erro** — é o que qualquer
coletor (Sentry, Loki, CloudWatch) capta sem acoplar o worker a um fornecedor.
O e-mail é adicional e só sai se `ALERT_EMAIL` estiver preenchido: sem
destinatário configurado, o sistema não inventa um.
