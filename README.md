# Gerenciador de Redes Sociais

Plataforma SaaS para gestão centralizada de redes sociais — conteúdo,
publicação, agendamento, analytics, aprovação e multi-cliente — pensada para
agências e criadores no Brasil.

A especificação completa está em [`SPEC.md`](SPEC.md) e é a fonte da verdade
do projeto. O estado atual de cada fase está em [`STATUS.md`](STATUS.md).

---

## O que este sistema faz de diferente

**Várias contas por rede, de verdade.** Uma marca pode ter 5 TikToks, 5 canais
do YouTube e 5 Instagrams. Em nenhuma camada existe a noção de "a conta do
Instagram deste cliente".

**Um destino por conta.** Uma publicação para um grupo de 20 contas é uma linha
de `Post` e **vinte** de `PostTarget`, cada uma com horário, status, tentativas
e erro próprios. Falha em 3 não afeta as outras 17, e "tentar novamente"
reprocessa só as 3.

**Fuso horário por conta.** "Segunda às 10h" significa 10h no fuso de **cada
conta de destino** — o que gera instantes diferentes para contas em São Paulo e
em Lisboa. A interface mostra o fuso junto do horário, sempre.

**Nada finge funcionar.** Rede sem API oficial de publicação aparece como
indisponível, com o motivo. Rede implementada mas sem credencial no ambiente
diz exatamente isso. Métrica que a plataforma não fornece fica **ausente** em
vez de virar zero.

---

## Subir o ambiente

### Pré-requisitos

- Node.js 22+ e pnpm 11+
- Docker Desktop (com a rede configurada — ver [Conflito de IP](#conflito-de-ip))
- FFmpeg, se for rodar o worker fora do container

### Passo a passo

```bash
pnpm install
cp .env.example .env
```

Gere os três segredos criptográficos e coloque no `.env`:

```bash
node -e "const c=require('crypto');console.log('JWT_ACCESS_SECRET='+c.randomBytes(48).toString('base64'));console.log('JWT_REFRESH_SECRET='+c.randomBytes(48).toString('base64'));console.log('ENCRYPTION_KEY='+c.randomBytes(32).toString('base64'))"
```

Suba a infraestrutura, aplique as migrations e semeie o catálogo:

```bash
pnpm docker:up
pnpm db:deploy
pnpm db:seed
```

Rode a aplicação:

```bash
pnpm dev
```

| Serviço | Endereço |
|---|---|
| Aplicação | http://localhost:3000 |
| API | http://localhost:3001 |
| Documentação da API (OpenAPI) | http://localhost:3001/docs |
| E-mails capturados (Mailpit) | http://localhost:8025 |
| Storage (MinIO) | http://localhost:9001 |

Tudo escuta em `127.0.0.1` — nada fica exposto na sua rede local.

### Verificar que subiu inteiro

```bash
node infra/scripts/smoke-test.mjs
```

São 35 verificações contra a API real: infraestrutura, autenticação,
plataformas, grupos, validação e permissões.

---

## Conflito de IP

O Docker aloca redes a partir do pool `172.17.0.0/12` por padrão. Em máquinas
Windows com Hyper-V e WSL, esse pool **colide** com as faixas do host — o
sintoma é a rede caindo de forma intermitente, difícil de diagnosticar.

O projeto fixa a rede em `10.201.10.0/24`
([`infra/docker/docker-compose.yml`](infra/docker/docker-compose.yml)) e
recomenda fixar o pool global do Docker. Em *Settings → Docker Engine*:

```json
{
  "default-address-pools": [{ "base": "10.201.0.0/16", "size": 24 }]
}
```

Antes de mudar, confira quais faixas sua máquina já usa:

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, IPAddress, PrefixLength
```

O raciocínio completo está em [`DEPLOYMENT.md`](DEPLOYMENT.md).

---

## Credenciais das redes sociais

Nenhuma integração publica nada sem credenciais de aplicativo, e elas só podem
ser criadas pelo dono do projeto. Enquanto faltarem, a interface diz
explicitamente que a rede está "sem credenciais neste ambiente" — em vez de
simular.

O passo a passo de cada rede, as barreiras de aprovação e a matriz de
capacidades estão em [`SOCIAL_INTEGRATIONS.md`](SOCIAL_INTEGRATIONS.md).

**Resumo rápido:** o YouTube é a única das seis que aceita
`http://localhost` como callback de OAuth — as demais exigem um túnel HTTPS
público para desenvolver.

---

## Estrutura

```
apps/
  api/       Fastify 5 + Zod + OpenAPI
  worker/    BullMQ + FFmpeg (processo separado)
  web/       Next.js 15 + Tailwind
packages/
  core/      Domínio puro: validação, agendamento, RBAC, resiliência
  db/        Prisma: schema, migrations, seed
  platform/  Adapters das redes, tokens, cota, circuit breaker
infra/
  docker/    Compose e Dockerfiles
  scripts/   Migration não-interativa e teste de fumaça
```

`packages/core` não importa Prisma, Fastify, BullMQ nem SDK de plataforma
nenhuma — é o que permite testar agendamento, fuso e validação sem subir
infraestrutura.

Detalhes em [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Comandos

| Comando | O que faz |
|---|---|
| `pnpm dev` | Sobe API, worker e web com hot reload |
| `pnpm build` | Compila todos os pacotes |
| `pnpm test` | Roda os testes de todos os pacotes |
| `pnpm typecheck` | Verifica os tipos sem compilar |
| `pnpm docker:up` / `docker:down` | Sobe/derruba a infraestrutura |
| `pnpm docker:reset` | Derruba **e apaga os volumes** |
| `pnpm db:deploy` | Aplica as migrations |
| `pnpm db:seed` | Semeia plataformas, planos e feature flags |
| `pnpm db:studio` | Abre o Prisma Studio |
| `pnpm db:deploy:test` | Aplica as migrations no banco de **teste** |
| `node infra/scripts/new-migration.mjs <nome>` | Cria e aplica uma migration (funciona sem TTY) |

### Testes

```bash
pnpm --filter @app/core test     # domínio puro, sem infraestrutura
pnpm --filter @app/worker test   # motor de publicação, contra Postgres real
```

Os testes do worker precisam de um banco separado. Crie-o uma vez:

```bash
docker exec gerenciador_postgres psql -U gerenciador -d postgres -c "CREATE DATABASE gerenciador_test;"
```

Acrescente ao `.env` (a mesma senha do `DATABASE_URL`):

```
DATABASE_URL_TEST=postgresql://gerenciador:<senha>@localhost:5433/gerenciador_test?schema=public
```

E aplique as migrations — **repita sempre que criar uma migration nova**, senão
os testes falham com "a coluna X não existe":

```bash
pnpm db:deploy:test
```

Eles rodam contra Postgres de verdade de propósito: as garantias sendo
testadas — a UNIQUE por destino, o UPDATE condicional que resolve a corrida
entre workers, o incremento atômico de cota — são do banco, e um banco falso
as tornaria vazias.

---

## Documentação

| Documento | Conteúdo |
|---|---|
| [`SPEC.md`](SPEC.md) | Especificação do produto (fonte da verdade) |
| [`STATUS.md`](STATUS.md) | O que está pronto, decisões e pendências |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Decisões técnicas e o porquê delas |
| [`SOCIAL_INTEGRATIONS.md`](SOCIAL_INTEGRATIONS.md) | Matriz das redes e como obter cada credencial |
| [`API_DOCUMENTATION.md`](API_DOCUMENTATION.md) | Convenções da API; referência viva em `/docs` |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Ambientes, rede, migrations e backup |
| [`SECURITY.md`](SECURITY.md) | Modelo de ameaças e controles |
| [`PRIVACY.md`](PRIVACY.md) | Retenção, LGPD e subprocessadores |
