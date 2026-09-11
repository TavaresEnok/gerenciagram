# Implantação

---

## Ambientes

Três ambientes, com **credenciais de aplicativo separadas** — nunca usar
credencial de produção em staging ou desenvolvimento (SPEC seção 14).

| Ambiente | `APP_ENV` | Banco | Credenciais de plataforma |
|---|---|---|---|
| Desenvolvimento | `development` | Postgres local (Docker) | Apps de teste; YouTube em modo *Testing* |
| Staging | `staging` | Instância própria | Apps separados dos de produção |
| Produção | `production` | Instância gerenciada com backup | Apps aprovados |

Em `APP_ENV=production` o processo **se recusa a iniciar** se encontrar
configuração insegura — `COOKIE_SECURE=false`, URLs em `http://`, ou `HOST`
preso em `127.0.0.1` atrás de um proxy. Falhar na subida é melhor do que
descobrir em produção que o cookie não era `secure`.

---

## Conflito de IP

### O problema

O Docker aloca redes de usuário a partir do pool **`172.17.0.0/12`**
(172.16.x até 172.31.x). Numa máquina Windows com Hyper-V e WSL, esse pool
colide com faixas que o host já usa.

Exemplo real, medido nesta máquina:

```
Wi-Fi (LAN)                          192.168.68.0/22
vEthernet (Default Switch, Hyper-V)  172.22.144.0/20   ← dentro do pool
vEthernet (WSL)                      172.27.80.0/20    ← dentro do pool
VM interna do Docker Desktop         192.168.65.0/24
```

Duas das quatro caem dentro do pool padrão. Quando o Docker aloca uma rede que
se sobrepõe, o sintoma é a rede do host caindo de forma **intermitente** —
containers param de resolver DNS, conexões morrem sem padrão claro. É o tipo de
falha que se atribui ao provedor por semanas.

### A correção

**1. Fixe o pool global.** Em *Docker Desktop → Settings → Docker Engine*:

```json
{
  "default-address-pools": [{ "base": "10.201.0.0/16", "size": 24 }]
}
```

Reinicie o Docker Desktop. Confirme:

```bash
docker info | grep -A2 "Default Address Pool"
```

**2. A rede do projeto já é fixa.** O compose declara `10.201.10.0/24`
explicitamente, em vez de deixar o Docker escolher.

**3. Antes de adotar, verifique sua máquina.** A escolha de `10.x` funciona
aqui porque não há nenhuma rota nessa faixa. Confira a sua:

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, IPAddress, PrefixLength
Get-NetRoute -AddressFamily IPv4 | Select-Object DestinationPrefix, InterfaceAlias
```

Se a sua rede corporativa ou VPN usar `10.x`, escolha outra faixa livre e
ajuste `DOCKER_SUBNET` e `DOCKER_GATEWAY` no `.env`.

### Portas

Todas bindadas em **`127.0.0.1`** — o ambiente de desenvolvimento não fica
exposto na rede Wi-Fi. As portas de banco e cache usam valores fora do padrão
para não colidir com um Postgres ou Redis instalado nativamente.

| Serviço | Host | Container |
|---|---|---|
| Web | 3000 | 3000 |
| API | 3001 | 3001 |
| Postgres | **5433** | 5432 |
| Redis | **6380** | 6379 |
| MinIO | 9000 / 9001 | 9000 / 9001 |
| Mailpit | 1025 / 8025 | 1025 / 8025 |

---

## Migrations

Versionadas em `packages/db/prisma/migrations/`, aplicadas no deploy:

```bash
pnpm db:deploy    # prisma migrate deploy — idempotente, sem prompt
```

### Criar uma migration

`prisma migrate dev` exige TTY interativo e falha em CI, container e qualquer
automação. Use o script do projeto:

```bash
node infra/scripts/new-migration.mjs nome_em_snake_case [--dry-run]
```

Ele gera o SQL do diff entre banco e schema, grava a pasta da migration e
aplica com `migrate deploy` — sem prompt.

> No Windows, a regeneração do Prisma Client falha com `EPERM` se a API ou o
> worker estiverem rodando (o engine `.dll.node` fica travado). O script avisa
> e orienta a parar os processos e rodar `pnpm db:generate`.

### Deploy sem downtime

Migrations precisam ser **compatíveis com a versão anterior ainda rodando**
(SPEC seção 2). Na prática, mudanças destrutivas viram três deploys:

1. **Expandir** — adiciona a coluna nova como anulável ou com default. Deploy.
2. **Migrar** — o código passa a escrever nas duas e ler da nova. Deploy.
3. **Contrair** — remove a coluna antiga. Deploy.

O que **nunca** vai num único deploy: renomear ou remover coluna em uso,
adicionar `NOT NULL` sem default, ou trocar tipo de forma incompatível.

### Rollback

`prisma migrate deploy` não desfaz. A estratégia é:

1. Reverter o **código** para a versão anterior (que a migration em passo
   "expandir" continua suportando).
2. Se a migration precisa ser desfeita, escrever uma migration **nova** que a
   reverte — nunca editar uma já aplicada.
3. Restaurar do backup é o último recurso, e implica perder o que entrou depois
   do ponto de restauração.

---

## Containers

```bash
docker compose -f infra/docker/docker-compose.yml --env-file .env up -d
docker compose -f infra/docker/docker-compose.yml --env-file .env --profile full up -d
```

Por padrão o compose sobe **só a infraestrutura**, e as apps rodam no host com
hot reload. O profile `full` sobe tudo em container.

Os Dockerfiles são multi-stage com alvo `production` que:

- roda como usuário **não-root** (`app`, uid 1001);
- usa `tini` como PID 1, para shutdown gracioso de verdade;
- instala só as dependências de produção (`pnpm deploy --prod`);
- no caso do web, usa o output `standalone` do Next — imagem sem
  `node_modules` completo.

### Shutdown gracioso

Ambos os processos tratam `SIGTERM`. Importa mais no worker: `close()` espera
os jobs em voo terminarem, o que evita matar o processo **entre** "publicou no
YouTube" e "gravou o `remoteId` no banco" — que produziria a publicação
duplicada que a SPEC seção 19 proíbe.

O orquestrador precisa dar tempo: `terminationGracePeriodSeconds: 90` ou
equivalente.

### Health checks

| Endpoint | Pergunta | Verifica dependências? |
|---|---|---|
| `/healthz` | O processo está vivo? | **Não** |
| `/readyz` | Posso receber tráfego? | Sim: banco, Redis, storage |

A separação evita o modo de falha clássico: se o liveness checasse o banco, uma
queda do Postgres faria o orquestrador **matar e recriar réplicas saudáveis em
laço**. Falha no readiness apenas tira a réplica do balanceador.

---

## Escala

API e worker são **stateless** e escalam horizontalmente sem coordenação:

- rate limit e estado do circuit breaker vivem em Redis e Postgres, não em
  memória — um breaker por processo abriria e fecharia de forma independente
  em cada réplica;
- a corrida entre workers pelo mesmo destino é resolvida pelo `UPDATE`
  condicional no banco;
- jobs repetíveis usam `jobId` fixo, então subir uma segunda réplica não
  registra um segundo agendador para o mesmo trabalho.

`PUBLISH_CONCURRENCY` e `MEDIA_CONCURRENCY` controlam a concorrência por
processo. Processamento de vídeo é CPU-bound: `MEDIA_CONCURRENCY` alto num
container com pouca CPU só aumenta a latência.

---

## Backup e recuperação

### Metas da v1

| Meta | Valor | Significa |
|---|---|---|
| **RPO** | 24 h | Até 24h de dados podem ser perdidos num desastre |
| **RTO** | 4 h | Tempo alvo para voltar a operar |

Modestas de propósito — e documentadas para poderem ser apertadas depois.

### O que precisa de backup

| Dado | Estratégia |
|---|---|
| **Postgres** | Dump diário + WAL archiving em produção |
| **Mídia (S3)** | Replicação do provedor; versionamento de objeto |
| **Redis** | `appendonly` ligado. Perder a fila atrasa publicações, mas os `PostTarget` no banco permitem reenfileirar |
| **Segredos** | Fora do backup de dados, em cofre próprio |

### Backup do Postgres

```bash
docker exec gerenciador_postgres pg_dump -U gerenciador -Fc gerenciador > backup.dump
```

O banco é criado com `--data-checksums`, o que faz corrupção silenciosa de
página ser detectada em vez de propagada para o backup.

### Teste de restauração

**Backup nunca restaurado não é backup confiável** (SPEC seção 15). O teste
deve rodar ao menos **trimestralmente**:

```bash
docker exec gerenciador_postgres psql -U gerenciador -d postgres \
  -c "CREATE DATABASE restauracao_teste;"

docker exec -i gerenciador_postgres pg_restore -U gerenciador \
  -d restauracao_teste --no-owner < backup.dump

# 1. Os dados vieram?
docker exec gerenciador_postgres psql -U gerenciador -d restauracao_teste \
  -c "SELECT (SELECT count(*) FROM organizations) AS orgs,
             (SELECT count(*) FROM post_targets) AS destinos,
             (SELECT count(*) FROM social_accounts) AS contas;"

# 2. As CONSTRAINTS vieram? Contar linhas não basta: um banco restaurado sem
#    as UNIQUE aceita publicação duplicada em silêncio, que é exatamente o
#    que o sistema inteiro foi desenhado para impedir.
docker exec gerenciador_postgres psql -U gerenciador -d restauracao_teste \
  -c "SELECT contype, count(*) FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'public' GROUP BY contype ORDER BY contype;"

docker exec gerenciador_postgres psql -U gerenciador -d restauracao_teste \
  -c "SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexdef LIKE 'CREATE UNIQUE%'
       ORDER BY 1;"

# 3. As constraints estão sendo APLICADAS? Presente no catálogo e ativa são
#    coisas diferentes. Esta inserção tem de falhar na segunda linha.
docker exec gerenciador_postgres psql -U gerenciador -d restauracao_teste -c "
  INSERT INTO platform_quota_usage
    (id, platform, \"scopeKey\", \"windowDate\", \"windowStart\", \"windowEnd\",
     count, units, \"createdAt\", \"updatedAt\")
  VALUES (gen_random_uuid(), 'YOUTUBE', 'APP', CURRENT_DATE, now(),
          now() + interval '1 day', 1, 1, now(), now());
  INSERT INTO platform_quota_usage
    (id, platform, \"scopeKey\", \"windowDate\", \"windowStart\", \"windowEnd\",
     count, units, \"createdAt\", \"updatedAt\")
  VALUES (gen_random_uuid(), 'YOUTUBE', 'APP', CURRENT_DATE, now(),
          now() + interval '1 day', 1, 1, now(), now());"

docker exec gerenciador_postgres psql -U gerenciador -d postgres \
  -c "DROP DATABASE restauracao_teste;"
```

Registre a data e o resultado de cada teste. Um teste não registrado não
aconteceu.

> **O dump não restaura sozinho.** `oauth_tokens` guarda os tokens cifrados
> com AES-256-GCM, e a chave (`ENCRYPTION_KEY`) fica FORA do backup, no cofre
> de segredos. Restaurar o banco com uma chave diferente devolve um sistema
> que sobe, responde e falha em toda publicação — os tokens não decifram e
> todas as contas precisam ser reconectadas uma a uma. A chave da versão
> correspondente (`keyVersion`) faz parte do procedimento de recuperação tanto
> quanto o `.dump`.

### Registro dos testes de restauração

| Data | Origem | Resultado |
|---|---|---|
| 2026-09-11 | Dump de 162 KB do `gerenciador` em dev (13 organizações, 210 contas, 10 conteúdos) | **Passou.** Contagens idênticas; 37 chaves primárias, 63 estrangeiras e 133 índices restaurados sem divergência; as UNIQUE críticas presentes (`post_targets_postId_socialAccountId_key`, `post_targets_idempotencyKey_key`, `platform_quota_usage_platform_scopeKey_windowDate_key`, `comments_socialAccountId_remoteId_key`, `oauth_tokens_socialAccountId_key`) e a de cota **rejeitou uma inserção duplicada**, provando que está ativa e não só catalogada. Banco de teste removido ao fim. |

O passo 3 nasceu deste teste: a versão anterior do procedimento só conferia
contagem de linhas, e contagem de linhas não teria detectado a perda de uma
UNIQUE — o defeito mais caro que uma restauração pode carregar.

### Revogação em massa

Em incidente de segurança, todos os tokens de conta podem ser invalidados de
uma vez:

```sql
UPDATE oauth_tokens SET revoked_at = now(), access_token_enc = '', refresh_token_enc = NULL;
UPDATE social_accounts SET status = 'NEEDS_RECONNECT',
       status_reason = 'Revogação preventiva por incidente de segurança.';
```

Isso invalida localmente. A revogação **junto às plataformas** passa pelo fluxo
de desconexão, que chama a API de cada rede.

---

## Variáveis de ambiente

O `.env.example` é a referência completa. As que quebram a subida se
estiverem erradas:

| Variável | Formato |
|---|---|
| `DATABASE_URL` | URL do Postgres |
| `REDIS_URL` | URL do Redis |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | ≥ 32 caracteres |
| `ENCRYPTION_KEY` | **Exatamente 32 bytes em base64** |
| `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Credenciais do storage |

```bash
openssl rand -base64 48   # segredos JWT
openssl rand -base64 32   # ENCRYPTION_KEY
```

> **Booleanos:** o parser compara o texto explicitamente. `z.coerce.boolean()`
> **não** serve — em JavaScript a string `"false"` é *truthy*, e
> `SMTP_SECURE=false` viraria `true`, fazendo a conexão tentar TLS numa porta
> em texto claro. Este bug existiu e foi corrigido.

---

## Teste de carga

Mede os dois alvos numéricos da SPEC seção 2: p95 ≤ 300ms nos endpoints
síncronos e job de publicação processado dentro de poucos minutos do horário.

```bash
pnpm build            # o teste roda contra o bundle, não contra o tsx watch
pnpm load:api         # sobe uma API na 3002, com o rate limiter afrouxado
pnpm load:test
```

São dois comandos porque o rate limiter da API (300 req/min por usuário, e
está certo assim) é menor que a carga do teste. Medir com ele no caminho
mediria o limiter, não os endpoints — e a instância de desenvolvimento
continua intacta na 3001.

O script cria a própria organização, com sufixo aleatório, e não apaga nem
altera nada existente. Ele se recusa a rodar com `APP_ENV=production`.

### Resultado medido (2026-09-11)

Windows 11, Postgres e Redis em Docker, API e carga na mesma máquina — ou
seja, cliente e servidor disputando CPU. Num servidor dedicado os números
tendem a ser melhores, não piores.

Perfil: 50 contas num grupo, 300 requisições por endpoint.

| Endpoint | 25 em voo | 50 em voo |
|---|---|---|
| `GET /dashboard` | — | p95 111ms |
| `GET /posts` | — | p95 82ms |
| `GET /contents` | — | p95 101ms |
| `GET /accounts` | p95 138ms | p95 255ms |
| `GET /groups` | — | p95 168ms |
| `GET /analytics/overview` | — | p95 109ms |
| `POST /groups/resolve` | — | p95 95ms |
| `POST /posts/preview` (50 destinos) | **p95 248ms** | **p95 476ms** |

Entrega da fila: atraso p95 de 90ms depois do horário agendado, contra um
alvo de "poucos minutos" — três ordens de grandeza de folga.

**O limite prático está no `preview`**, que é o endpoint mais pesado: resolve
o grupo, valida cada destino (mídia, cota, conteúdo duplicado, campos
obrigatórios da rede) e converte fuso conta a conta. Com 50 destinos ele
sustenta ~120 req/s por processo, e o p95 cruza os 300ms por volta de **30
previews simultâneos**. Até 25 simultâneos fica dentro do alvo.

Isso é saturação, não defeito: a latência aí é `concorrência ÷ vazão`, e o
caminho é escalar horizontalmente — a API é stateless exatamente para isso.
Vale dizer que 30 previews de 50 contas *ao mesmo tempo* é um pico
considerável: preview é ação humana, um clique por vez.

Uma otimização de fuso horário foi **medida e descartada**: `isValidTimezone` e
`formatInTimezone` custam ~7µs e ~14µs por chamada, o que dá ~1,4ms para 50
destinos. Não é o gargalo, e cachear ali só acrescentaria estado sem ganho.

### Cuidado ao interpretar

O primeiro endpoint medido chegou a mostrar p99 de 2,1s até o aquecimento
passar a rodar na mesma concorrência da medição. Não era o endpoint: o pool de
conexões do Prisma cresce sob demanda, e 20 requisições sequenciais abriam 1 ou
2 conexões enquanto as 20 primeiras concorrentes abriam as outras 18 de uma
vez. Aquecimento em série mede uma coisa e a medição mede outra.
