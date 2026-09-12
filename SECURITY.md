# Segurança

Cobre a SPEC seção 10. O que este sistema guarda de mais sensível são **tokens
de acesso a contas de redes sociais de terceiros** — um vazamento não expõe só
dados nossos, expõe a capacidade de publicar em nome dos clientes.

---

## Superfície de risco

| Ativo | Impacto se vazar |
|---|---|
| **Tokens OAuth das contas** | Publicar, apagar e ler em nome do cliente |
| Credenciais de aplicativo | Comprometer **todas** as contas conectadas |
| Senhas dos usuários | Acesso à plataforma; reuso em outros serviços |
| Mídia | Conteúdo não publicado, sob embargo |
| Métricas e comentários | Dados pessoais de terceiros (LGPD) |

---

## Tokens de plataforma

**Em repouso:** cifrados com **AES-256-GCM**. O GCM autentica além de cifrar —
um token adulterado no banco falha na verificação da tag em vez de ser
decifrado em lixo e enviado para a plataforma.

Formato: `v<versão>.<iv>.<authTag>.<ciphertext>`, tudo em base64.

**Rotação de chave.** O prefixo de versão permite trocar `ENCRYPTION_KEY` sem
obrigar todos os usuários a reconectar: o registro guarda com qual versão foi
cifrado, e a decifragem escolhe a chave correspondente. Ao rotacionar, mantenha
a chave anterior disponível até reencriptar a base.

**Em trânsito interno:** decifrados apenas em memória, durante a operação.
Nunca vão para:

- payload de job (fica gravado no Redis e aparece no painel de filas);
- log (o `redact` do pino cobre os caminhos por nome);
- log de auditoria (`sanitizeChanges` substitui por `[REDIGIDO]`);
- resposta da API (a view de conta expõe só `expiresAt` e `scopes`).

**Menor privilégio.** Só pedimos o escopo que a funcionalidade atual exige. O
YouTube conecta com `youtube.upload` + `youtube.readonly`;
`youtube.force-ssl` — necessário para responder comentários — **não** é pedido
na conexão padrão. Quem tentar responder recebe uma mensagem pedindo reconexão
com a permissão extra, em vez de um 403 cru.

---

## Autenticação

**Senhas:** argon2id com 19 MiB de memória, 2 iterações, paralelismo 1
(recomendação do OWASP). Argon2id resiste tanto a ataque por GPU quanto a
side-channel.

Política: mínimo de **12 caracteres**, sem exigir símbolos. Comprimento protege
mais que composição — exigir símbolo empurra o usuário para `Senha1!`, que não
aumenta a entropia real. Recusamos senhas comuns e senhas que contenham o
próprio e-mail.

**Sessões:** access token JWT de 15 min (não revogável, por isso é curto) +
refresh opaco de 30 dias, guardado como SHA-256 e **rotacionado a cada uso**.

Reuso de um refresh já rotacionado só acontece em dois casos: cliente com bug
ou token roubado. Como não dá para distinguir, tratamos como comprometimento e
**revogamos a família inteira** de sessões.

**2FA (TOTP):** segredo cifrado com a mesma chave AES. A ativação exige
**confirmação** — o segredo só vira obrigatório depois que a pessoa prova que o
app dela gera o código certo, senão um QR escaneado errado trancaria a conta.
Códigos de recuperação são guardados como hash e consumidos uma única vez.

**Contra enumeração de contas:** login com e-mail inexistente e login com senha
errada devolvem a **mesma** mensagem, e o caminho do e-mail inexistente executa
uma verificação de hash falsa para igualar o tempo de resposta. O endpoint de
recuperação de senha responde `204` exista ou não a conta.

**Contra força bruta:** 8 tentativas erradas bloqueiam por 15 minutos. Janela
curta de propósito — um bloqueio longo vira uma forma fácil de derrubar a conta
alheia.

---

## Autorização

RBAC com sete papéis, declarados **explicitamente** por permissão, não
derivados de hierarquia numérica. Papéis reais não são uma linha reta: o
Approver aprova mas não conecta contas; o Analyst lê métricas mas não vê
rascunho. Um esquema de "nível ≥ 3" erraria os dois.

**O papel é relido do banco a cada requisição**, não confiado ao JWT. Uma
remoção de acesso vale imediatamente, em vez de esperar o token de 15 minutos
expirar. Rebaixamento e suspensão também **revogam as sessões ativas**.

Duas travas estruturais:

- ninguém altera o **próprio** papel — um Admin poderia se promover a Owner;
- a organização **nunca fica sem Owner ativo** — nem por rebaixamento, nem por
  remoção. Uma organização sem dono não tem quem gerencie plano nem quem
  solicite a exclusão de dados da LGPD.

**Grupo nunca concede permissão.** Ao resolver um grupo em destinos, ficam só
as contas em que o usuário pode publicar; as excluídas voltam nomeadas com o
motivo.

**Painel da plataforma fora do RBAC de tenant.** O acesso vem de
`User.isPlatformAdmin`, atribuído direto no banco. Nenhum papel de organização
concede — nem por engano, nem por escalação. Quem não tem recebe a mesma
resposta de "não existe", para o painel não se anunciar a quem sonda.

---

## Isolamento multi-tenant

Três camadas, porque uma só depende de alguém lembrar:

1. **Schema** — `organizationId` indexado em toda entidade de tenant.
2. **Consulta** — `tenantWhere()` injeta o filtro e `deletedAt: null` juntos.
3. **Defesa** — `assertTenant()` confere o dono de um registro carregado por id
   e transforma vazamento silencioso em exceção.

Recurso de outra organização responde **404**, não 403: um 403 confirmaria que
o id existe.

---

## Entrada e upload

**Validação:** todo corpo passa por schema Zod antes de chegar ao handler. O
mesmo schema gera o OpenAPI, então documentação e validação não divergem.

**MIME type:** o `Content-Type` declarado **não é confiável**. O tipo é
determinado pela assinatura dos primeiros bytes, e o arquivo é recusado quando
não bate.

**Travessia de caminho:** o nome do arquivo é reduzido ao basename e
sanitizado antes de virar chave no bucket. `../../etc/passwd` não vira caminho.

**Tamanho:** limitado no plugin multipart (antes de chegar ao handler) e
conferido de novo ao gravar. O limite de storage do plano é checado antes do
upload.

**Chave do bucket** sempre começa com `org/<id>/` — é o que torna possível
apagar tudo de um tenant na exclusão da LGPD sem varrer o bucket inteiro.

**Mídia é privada.** Nenhuma URL é persistida: cada resposta assina uma URL
temporária de 15 minutos. URL permanente viraria link público no primeiro
relatório exportado.

---

## Rede e transporte

**HTTPS obrigatório em produção** — a subida falha se `COOKIE_SECURE` for
false ou se as URLs públicas forem `http://`.

**Cookies:** `httpOnly`, `secure` em produção, `sameSite: lax`, com `path`
restrito a `/v1/auth`. O refresh token nunca é acessível ao JavaScript, o que o
tira do alcance de XSS.

**CORS** restrito à origem do frontend, com `credentials: true`.

**Helmet** aplicado. CSP fica desligada de propósito: a API não serve HTML, e
uma CSP restritiva só atrapalharia o Swagger UI.

**`trustProxy`** só fora de desenvolvimento — confiar cegamente em dev deixaria
qualquer cliente forjar o IP usado no rate limit.

**Timeout em toda chamada externa.** Nenhuma espera indefinidamente. O
`AbortSignal` é combinado com o do chamador, então o shutdown do worker cancela
requisições em voo.

---

## Webhooks

1. **Assinatura verificada** sobre o corpo **cru**. Recalcular sobre o JSON
   re-serializado falha, porque a ordem das chaves e o espaçamento mudam.
2. Assinatura inválida → **401 sem detalhe**. Não ajudamos quem tenta forjar.
3. Plataforma sem verificador implementado → **501**. Aceitar evento não
   verificado seria uma porta aberta.
4. Headers guardados são uma **lista de permitidos** — `cookie` e
   `authorization` não entram, mesmo que um webhook malformado os traga.

---

## Auditoria

`AuditLog` registra quem fez o quê, em quê e de onde, com o correlation ID.

O campo `changes` passa por `sanitizeChanges`, que substitui por `[REDIGIDO]`
qualquer chave de senha, token ou segredo — em qualquer profundidade. A tentação
de gravar "o objeto inteiro que mudou" é exatamente como credenciais acabam num
log retido por anos.

Escrever auditoria **nunca derruba a operação principal**: perder uma linha de
log é ruim; falhar uma publicação porque a auditoria caiu é pior. A falha vira
log de erro para ser notada.

---

## Dependências

`pnpm` bloqueia scripts de instalação por padrão. O `pnpm-workspace.yaml`
lista explicitamente os poucos pacotes autorizados a rodar build — um pacote
novo que tente executar script na instalação é barrado até alguém liberar
conscientemente.

O pipeline de CI roda `pnpm audit` (SCA) antes do merge.

Escolhas que reduzem superfície: `@node-rs/argon2` (binário pré-compilado,
dispensa toolchain C++), `jose` (JWT sem dependências), `pdfkit` (PDF sem
headless browser).

---

## Rotação de segredos

| Segredo | Frequência sugerida | Como |
|---|---|---|
| `JWT_ACCESS_SECRET` | Semestral | Troca direta; derruba as sessões ativas |
| `JWT_REFRESH_SECRET` | Semestral | Idem |
| `ENCRYPTION_KEY` | Anual | Versionada — mantenha a anterior até reencriptar |
| Credenciais de plataforma | Conforme a política de cada rede | Console de cada plataforma |
| Senha do Postgres / MinIO | Semestral | Rotacionar e reiniciar os serviços |

> Rotação de **secret de aplicativo** é diferente de expiração de **token de
> conta de usuário** — este último segue a regra de cada plataforma e é
> renovado automaticamente pelo worker.

---

## Resposta a incidente

Processo mínimo da v1 (SPEC seção 10).

**1. Conter (primeira hora)**

- revogar em massa os tokens de conta (ver `DEPLOYMENT.md`);
- revogar todas as sessões: `UPDATE sessions SET revoked_at = now();`
- rotacionar os segredos de aplicativo no console de cada plataforma;
- se houver suspeita sobre o banco, tirar a aplicação do ar.

**2. Avaliar**

- usar o `AuditLog` e o correlation ID para reconstruir o alcance;
- determinar **quais organizações** e **quais dados pessoais** foram afetados —
  isso define a obrigação de notificação sob a LGPD.

**3. Notificar**

A LGPD exige comunicar à **ANPD** e aos titulares em prazo razoável quando há
risco relevante. A comunicação deve dizer o que aconteceu, quais dados, quais
medidas foram tomadas e o que o titular deve fazer.

**4. Recuperar e registrar**

- exigir reconexão das contas afetadas e troca de senha onde couber;
- registrar linha do tempo, causa raiz e correções — e transformar a causa raiz
  em teste automatizado, para não repetir.

---

## Checklist antes de produção

- [ ] `APP_ENV=production` e a subida passa nas checagens de segurança
- [ ] Segredos gerados com `openssl rand`, nunca reaproveitados de dev
- [ ] HTTPS válido, com redirecionamento de `http://`
- [ ] Postgres e Redis **sem** porta pública
- [ ] Backup automático configurado **e restauração testada**
- [ ] `SENTRY_DSN` configurado
- [ ] Alertas ativos: fila acima do limite, taxa de falha, worker parado, token
      de aplicativo perto de expirar
- [ ] 2FA ativo nas contas Owner/Admin
- [ ] `pnpm audit` sem vulnerabilidade crítica
- [ ] Retenção de dados configurada por organização
- [ ] Contatos de resposta a incidente documentados

---

## Rotação da chave de criptografia

Os tokens OAuth são cifrados em repouso com AES-256-GCM, e cada valor guarda
a VERSÃO da chave que o cifrou (`oauth_tokens.keyVersion`). É isso que permite
trocar a chave sem obrigar todo mundo a reconectar as contas.

A ordem importa:

```bash
# 1. Gere a chave nova
openssl rand -base64 32

# 2. No .env, os três de uma vez:
ENCRYPTION_KEY=<chave nova>
ENCRYPTION_KEY_VERSION=2
ENCRYPTION_KEYS_PREVIOUS={"1":"<chave antiga>"}

# 3. Reinicie API e worker JUNTOS — os dois precisam do mesmo chaveiro.
```

O que já está no banco continua sendo decifrado com a v1; o que for gravado
daqui em diante nasce v2. A chave antiga só pode sair de
`ENCRYPTION_KEYS_PREVIOUS` quando nenhuma linha referenciar mais aquela
versão:

```sql
SELECT "keyVersion", count(*) FROM oauth_tokens GROUP BY "keyVersion";
```

**Trocar `ENCRYPTION_KEY` sem incrementar `ENCRYPTION_KEY_VERSION` faz o
processo se recusar a subir**, e isso é proposital. Antes o sistema aceitava
em silêncio, e o resultado era o pior possível: a chave nova ocupava o slot da
antiga, todo texto cifrado marcado `v1` passava a falhar na verificação da tag
GCM, e cada conta conectada precisava ser reconectada à mão. Um erro no boot é
infinitamente melhor do que descobrir isso na primeira publicação.

A recuperação de um backup exige a chave da versão correspondente. O `.dump`
não a carrega — ela vive no cofre de segredos (ver `DEPLOYMENT.md`).
