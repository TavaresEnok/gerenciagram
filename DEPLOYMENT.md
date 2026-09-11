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

# Conferir que os dados vieram:
docker exec gerenciador_postgres psql -U gerenciador -d restauracao_teste \
  -c "SELECT (SELECT count(*) FROM organizations) AS orgs,
             (SELECT count(*) FROM post_targets) AS destinos,
             (SELECT count(*) FROM social_accounts) AS contas;"

docker exec gerenciador_postgres psql -U gerenciador -d postgres \
  -c "DROP DATABASE restauracao_teste;"
```

Registre a data e o resultado de cada teste. Um teste não registrado não
aconteceu.

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
