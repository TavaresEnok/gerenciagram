# Privacidade e LGPD

Cobre a SPEC seção 11.

Este sistema trata dados pessoais em **duas camadas**, e a segunda é a que
costuma ser esquecida:

1. **Usuários da plataforma** — quem tem conta aqui: nome, e-mail, senha,
   IP, histórico de acesso.
2. **Terceiros, indiretamente** — pessoas que comentaram nas publicações dos
   clientes e vieram para o Inbox, e as métricas agregadas que descrevem o
   público de cada conta. Essas pessoas **não são nossas usuárias** e nunca
   consentiram diretamente com este sistema.

A segunda camada é tratada como dado sensível desde o desenho do banco.

---

## Inventário

| Dado | Onde | Base legal (art. 7º) | Retenção padrão |
|---|---|---|---|
| Nome, e-mail, senha (hash) | `users` | Execução de contrato | Enquanto a conta existir |
| IP, user-agent, horário de acesso | `sessions`, `audit_logs` | Legítimo interesse (segurança) | 1095 dias (auditoria) |
| Segredo 2FA (cifrado) | `users` | Execução de contrato | Enquanto ativo |
| **Tokens OAuth de contas** (cifrados) | `oauth_tokens` | Consentimento do titular na plataforma | Até desconectar ou revogar |
| Mídia enviada | S3 + `media_assets` | Execução de contrato | 365 dias após exclusão lógica |
| Conteúdo e publicações | `contents`, `posts`, `post_targets` | Execução de contrato | Enquanto a organização existir |
| **Comentários de terceiros** | `comments` | Legítimo interesse (gestão de relacionamento) | Segue a retenção de métricas |
| **Métricas agregadas** | `analytics_snapshots` | Legítimo interesse | 730 dias |
| Log de auditoria | `audit_logs` | Obrigação legal / legítimo interesse | 1095 dias |
| Relatórios gerados | S3 + `reports` | Execução de contrato | 30 dias (regeráveis) |

Cada organização pode **encurtar** os prazos de mídia, métricas e auditoria em
*Configurações*. O mínimo de auditoria é 30 dias.

---

## Retenção e expurgo

O expurgo é **automático e diário** (job `apply-retention`, 3h da manhã). Não
depende de ninguém lembrar — "guardar para sempre" não é conformidade.

O que o job remove:

- mídia em exclusão lógica há mais tempo que a retenção (arquivo **em uso por
  publicação futura nunca é tocado**);
- snapshots de métricas anteriores ao corte;
- logs de auditoria anteriores ao corte;
- notificações **lidas** com mais de 90 dias;
- tokens de verificação e reset expirados há mais de 30 dias;
- sessões expiradas;
- relatórios gerados vencidos.

**Soft-delete não é retenção.** `deletedAt` preserva a coerência de relatórios
já emitidos; o expurgo definitivo vem depois, por este job.

---

## Direito de exclusão

Uma organização pode solicitar a exclusão completa em *Configurações →
Excluir todos os dados*. O processo é **assíncrono**, e a ordem importa:

```
1. REVOGAR os tokens OAuth junto a cada plataforma
2. Apagar a mídia do storage
3. Apagar a organização (cascade leva o resto)
4. Gravar o relatório de execução
```

**O passo 1 vem primeiro porque apagar o banco antes destruiria as credenciais
necessárias para revogar** — e a autorização continuaria viva na plataforma
para sempre. Apagar a linha local não desfaz o acesso concedido no YouTube.

Há uma **janela de arrependimento** (7 dias por padrão, configurável de 1 a 30)
em que o pedido pode ser cancelado. Depois disso não há recuperação.

O `executionReport` registra, por conta, se a revogação remota deu certo. Se
uma plataforma estiver fora do ar, o relatório diz qual conta precisa de
revogação manual — em vez de fingir que tudo correu bem.

### Exclusão de um usuário individual

Remover um membro faz soft-delete do vínculo e revoga as sessões. O `User` em
si sobrevive porque pode pertencer a outras organizações. Para apagar a pessoa
por completo, é preciso removê-la de todas as organizações — e então o expurgo
de retenção cuida do registro.

---

## Transparência de consentimento

Antes de mandar o usuário para a tela de autorização de qualquer rede, a
interface mostra:

- **quais escopos** serão solicitados;
- **o que cada um permite**, em português — não o identificador técnico;
- que nenhuma senha passa por este sistema.

As descrições vivem no backend (`oauth-service.ts`), não no layout: se a lista
de escopos mudar, a explicação muda no mesmo lugar.

A tela de edição da conta mostra a qualquer momento quais permissões estão
concedidas.

---

## Subprocessadores

Serviços de terceiros que processam dados por conta desta plataforma. A lista
precisa constar no contrato com os clientes.

| Subprocessador | O que processa | Onde |
|---|---|---|
| **Provedor de banco** (Postgres gerenciado) | Todos os dados estruturados | Definido no deploy |
| **Provedor de storage** (S3/R2/MinIO) | Mídia e relatórios | Definido no deploy |
| **Redis gerenciado** | Fila; payloads contêm **apenas identificadores** | Definido no deploy |
| **Sentry** *(opcional)* | Stack traces e correlation IDs | UE/EUA |
| **Provedor de SMTP** | E-mail e nome do destinatário | Definido no deploy |
| **Anthropic** *(opcional, módulo de IA)* | Texto enviado para geração | EUA |
| **Plataformas de rede social** | Conteúdo publicado; métricas retornadas | Conforme cada plataforma |

**O payload de job carrega só identificadores**, nunca token, senha ou conteúdo
de mídia — o worker recarrega o que precisa do banco. Payload fica gravado no
Redis e aparece no painel de filas.

**O módulo de IA é opcional e vem desligado.** Sem `ANTHROPIC_API_KEY` ele se
declara indisponível. Ligá-lo significa enviar o texto do briefing para um
subprocessador nos EUA — o que precisa constar no contrato com o cliente.

---

## Transferência internacional

Dados podem sair do Brasil ao usar provedores estrangeiros ou as próprias APIs
das redes sociais (todas com infraestrutura no exterior). A LGPD permite,
desde que haja garantia adequada — cláusulas contratuais padrão ou país com
nível de proteção adequado.

Publicar num rede social **é**, por definição, transferir conteúdo para a
infraestrutura dela.

---

## Direitos do titular

| Direito (art. 18) | Como atender |
|---|---|
| Confirmação e acesso | `GET /v1/auth/me` e as telas de organização |
| Correção | Telas de perfil e configurações |
| Anonimização/eliminação | Fluxo de exclusão de dados |
| Portabilidade | Exportação em CSV pelos relatórios |
| Informação sobre compartilhamento | Este documento |
| Revogação do consentimento | Desconectar a conta revoga o token na plataforma |

**Prazo de resposta:** 15 dias, conforme o art. 19.

Titulares de dados de **terceira camada** (quem comentou numa publicação) devem
ser direcionados ao controlador — o cliente dono da conta. Este sistema é
operador nesse caso, não controlador.

---

## Papéis sob a LGPD

| Papel | Quem | Sobre quais dados |
|---|---|---|
| **Controlador** | O dono do SaaS | Dados dos usuários da plataforma |
| **Operador** | O dono do SaaS | Dados que os clientes gerenciam (comentários, métricas do público deles) |
| **Controlador** | Cada organização cliente | Dados do público das próprias contas |

Essa divisão define quem responde a um pedido de titular, e precisa estar
refletida no contrato de prestação de serviço.

---

## Privacidade desde o desenho

Decisões do sistema que existem por razão de privacidade, não de funcionalidade:

- **tokens cifrados com chave versionada**, permitindo rotação sem forçar
  reconexão em massa;
- **`redact` no logger e `sanitizeChanges` na auditoria**, aplicados por
  caminho — mais confiável que lembrar em cada chamada;
- **chave de storage prefixada por organização**, tornando o expurgo por tenant
  possível sem varrer o bucket;
- **URLs de mídia sempre assinadas e temporárias**, nunca persistidas;
- **payload de job só com identificadores**;
- **menor privilégio de OAuth** — não pedimos escopo que a funcionalidade atual
  não usa;
- **métrica ausente permanece ausente** — não inferimos nem estimamos dado que
  a plataforma não forneceu.
