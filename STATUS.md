# Status do projeto

Atualizado em **10/09/2026**.

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
| **4** | Compositor | ✅ Completa |
| **5** | Agendamento e engine de publicação | ✅ Completa |
| **6** | Instagram / Facebook | ⚠️ Pesquisado e declarado; adapter não escrito |
| **7** | TikTok | ⚠️ Pesquisado e declarado; adapter não escrito |
| **8** | YouTube (completo) | ✅ Adapter implementado |
| **9** | X | ⚠️ Pesquisado e declarado; adapter não escrito |
| **10** | Kwai | 🚫 **Fora da v1** — não há API oficial de publicação |
| **11** | Analytics | ✅ Completa |
| **12** | Workflow de aprovação | ✅ Completa |
| **13** | Módulo de IA | ✅ Completa (desligado sem chave) |
| **14** | Billing | ✅ Limites e planos; **sem gateway de pagamento** |
| **15** | Hardening | ✅ Documentado; itens de produção listados abaixo |

**Verificação:** 71 testes automatizados + 15 de integração contra Postgres
real + 35 verificações no teste de fumaça. Build limpo em todos os pacotes.

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

---

## Pendências conhecidas

**Adapters não escritos (fases 6, 7, 9).** As capacidades de Instagram,
Facebook, TikTok e X estão pesquisadas e declaradas no registro — o que já faz
o validador aplicar as regras corretas, inclusive o **bloqueio de conteúdo
duplicado no X**. Falta escrever os adapters. Cada um é um arquivo seguindo o
mesmo contrato do YouTube.

**Teste de carga (SPEC seção 5, Fase 15).** Os alvos da seção 2 (p95 ≤ 300ms,
job processado em poucos minutos do horário) estão documentados mas não foram
medidos sob carga.

**Inbox sem sincronização automática.** O endpoint de leitura e resposta
existe; falta o job periódico que busca comentários novos.

**Reaproveitamento de conteúdo.** `Post.duplicatedFromId` existe no modelo; a
ação de duplicar para outra data/rede não tem endpoint.

**Alertas.** As métricas técnicas existem no painel admin (tamanho de fila,
taxa de falha por plataforma, circuitos, dead-letter). Falta ligá-las a um
sistema de alerta — o `SENTRY_DSN` está previsto no `.env`.

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
