> Cole tudo a partir da linha abaixo, de uma vez só, como primeira mensagem no Claude Code / Cursor.

---

Você vai atuar como uma equipe de engenharia (arquiteto, backend, frontend, devops, segurança) construindo, de forma incremental e dentro deste repositório, a plataforma descrita abaixo.

## Regras de trabalho (obrigatórias, valem para todo o projeto)

1. Antes de escrever qualquer código, salve todo o conteúdo a partir da seção "ESPECIFICAÇÃO DO PRODUTO" (até o final desta mensagem) como `SPEC.md` na raiz do repositório, e crie um `STATUS.md` vazio. **Se o repositório já tiver um `SPEC.md` e código de sessões anteriores, não sobrescreva direto:** mostre o diff entre a versão antiga e esta, levante o que o código atual já suporta e o que falta em relação à nova versão (principalmente a seção 6.1), e proponha o plano de ajuste antes de alterar qualquer coisa. A partir de agora, `SPEC.md` é a fonte da verdade do projeto — releia os dois arquivos no início de qualquer sessão futura, mesmo que eu não repita este prompt.
2. Proponha primeiro: stack final, estrutura de pastas, modelo de dados e o plano da Fase 0. Espere minha aprovação antes de codar.
3. Trabalhe uma fase por vez, na ordem do Roadmap (seção 17). Não adiante fases futuras "por eficiência", mesmo que pareça mais rápido.
4. Ao final de cada fase: garanta que o projeto builda e roda, escreva e rode os testes daquela fase, crie um commit com mensagem descritiva, e atualize o `STATUS.md` com o que foi feito, decisões técnicas tomadas e pendências.
5. Pare após cada fase e aguarde minha confirmação explícita antes de começar a próxima.
6. Nunca invente endpoints, campos, escopos ou comportamento de API. Se não tiver certeza sobre o estado atual da API de alguma plataforma (Instagram, Facebook, TikTok, YouTube, X, Kwai), pesquise a documentação oficial atual antes de implementar, ou pare e me pergunte.
7. Sempre que precisar de uma credencial, client ID/secret, chave de API ou aprovação externa que só eu posso fornecer, pare e peça explicitamente — nunca simule isso com placeholder escondido ou mock disfarçado de integração real.
8. Se em algum momento a única forma de avançar for tomar um atalho que compromete a arquitetura, pare e me avise antes de fazer isso.
9. Os requisitos não funcionais (seção 2), segurança (seção 10) e privacidade/LGPD (seção 11) não são "polimento de fim de projeto" — leve-os em conta desde a Fase 0, mesmo que de forma simples no começo.
10. Comece pela Fase 0 (walking skeleton), não pela Fase 1.

Se estiver tudo claro, comece propondo a arquitetura e o plano da Fase 0. Não implemente nada ainda.

---

## ESPECIFICAÇÃO DO PRODUTO

### 1. Objetivo

Construir uma plataforma SaaS para gerenciamento centralizado de redes sociais (conteúdo, publicação, agendamento, analytics, aprovação, multi-cliente), conceitualmente parecida com Buffer/Metricool/Publer, porém com arquitetura própria, pensada para agências e criadores no Brasil.

Regra fundamental: **isto é um produto real, não uma demo.** Nada de funções fictícias, endpoints inventados, dados hardcoded, tokens no frontend, ou "mock" disfarçado de publicação real. Quando uma integração depender de credencial ou aprovação externa que ainda não temos, implemente toda a estrutura corretamente e deixe documentado o que falta ativar — não finja que funciona.

### 2. Requisitos não funcionais

- **Escala**: API e workers stateless, escaláveis horizontalmente. A arquitetura não pode impor um teto artificial de organizações/contas conectadas.
- **Performance**: endpoints síncronos da API devem responder em até ~300ms no p95 (exceto upload/processamento, que são assíncronos via fila).
- **Confiabilidade da fila**: jobs de publicação agendados devem processar dentro de poucos minutos do horário agendado, mesmo com falha parcial em algum componente (retry automático cobre isso).
- **Disponibilidade**: documentar um alvo de disponibilidade da API principal (ex.: 99.5% na v1) e evoluir depois — não é preciso 99.99% desde o dia 1, mas nada na arquitetura pode impedir chegar lá.
- **Deploys sem downtime** na maioria das mudanças: migrations de banco compatíveis com a versão anterior ainda rodando durante o deploy.
- **Idempotência**: toda operação de escrita relevante (publicar, agendar, cancelar) deve ser idempotente — reenviar a mesma requisição não pode duplicar o efeito.

### 3. Redes-alvo e regra de verificação de API

Instagram, Facebook, TikTok, YouTube, X, Kwai.

Cada uma tem regras de acesso, aprovação e limites diferentes, e isso **muda com o tempo**. Antes de implementar cada integração, pesquise a documentação oficial atual daquela plataforma — não confie apenas em conhecimento pré-treinado. Para cada plataforma, documente numa tabela `SOCIAL_INTEGRATIONS.md`:

| Campo | Descrição |
|---|---|
| Recurso | ex: publicar vídeo, ler métricas, responder comentário |
| Suportado via API oficial? | sim / não / parcial |
| Requer aprovação/revisão do app? | sim / não |
| Requer conta business/creator? | sim / não |
| Limitação conhecida | texto livre |
| Cota/limite de publicação | por conta e por app/projeto (ex.: posts por dia por conta, unidades de cota por projeto) |
| Conteúdo igual em várias contas | permitido / restrito / proibido — com link da política |
| Requisitos de UX obrigatórios | telas/campos que a plataforma exige no fluxo de publicação (ex.: TikTok Direct Post) |
| Link da documentação oficial | URL |

Se um recurso não for possível via API oficial, o sistema deve mostrar ao usuário: *"Este recurso não está disponível pela API oficial desta plataforma."* — nunca simular.

As linhas de cota, de conteúdo repetido e de requisitos de UX não são só documentação: elas alimentam diretamente as validações da seção 6.1, que acontecem no momento do agendamento.

**Kwai:** confirme logo na Fase 0 se existe API oficial de publicação disponível para terceiros. Se não existir, o Kwai sai da promessa da v1 e aparece na UI como indisponível — scraping ou automação do app não são alternativas aceitáveis (seção 19).

### 4. Arquitetura

Arquitetura modular preparada para adicionar novas redes sem reescrever o núcleo. Abstrações centrais:

- `SocialPlatform` — metadados da plataforma e capacidades suportadas
- `SocialAccount` — conta conectada (tokens, escopos, status)
- `SocialPublisher` — interface comum de publicação
- `SocialAnalytics` — interface comum de métricas
- `SocialMediaAdapter` — um adapter por plataforma (`InstagramAdapter`, `TikTokAdapter`, etc.)

O núcleo da aplicação nunca deve depender diretamente da implementação de uma rede específica — só da interface do adapter.

### 5. Multi-tenant e permissões

Hierarquia: `Platform → Organization → Users → Clients/Brands → SocialAccounts → Content → Campaigns → Posts → PostTargets → Analytics`.

- Um Client/Brand pode ter **várias contas da mesma rede** (ex.: 5 TikToks, 5 canais do YouTube). Nunca modele "uma conta por rede por marca".
- Grupos de contas (`AccountGroup`) são um atalho de seleção **transversal** a essa hierarquia, não um nível dela (ver seção 6.1). Um grupo pertence a uma Organization. Grupo nunca concede permissão: ao usar um grupo, o sistema só inclui as contas em que o usuário atual pode publicar e mostra quais ficaram de fora.

RBAC com papéis: Owner, Admin, Manager, Editor, Approver, Analyst, Viewer. Isolamento estrito de dados entre organizações (nenhum acesso cruzado).

### 6. Módulos funcionais

- **Contas**: conectar/reconectar/desconectar cada conta via OAuth oficial, com várias contas por rede; apelido interno e fuso horário por conta; tokens nunca expostos no frontend; renovação automática de refresh token.
- **Grupos de contas**: criar grupos com contas de qualquer rede (ex.: "Curiosidades" = TikTok 1, TikTok 2, Instagram 1, YouTube 1…) e usá-los para selecionar destinos, filtrar calendário/fila e gerar relatórios. Detalhes na seção 6.1.
- **Biblioteca de mídia**: upload, pastas, tags, busca, preview, versionamento; processamento automático (thumbnail, duração, resolução) via worker de FFmpeg.
- **Compositor de conteúdo**: um "conteúdo mestre" com variações por plataforma (legenda, título, hashtags específicas de cada rede) e **override opcional por conta** (ex.: legenda diferente só no TikTok 3). Destinos selecionados por conta individual, por grupo, ou pelos dois combinados.
- **Calendário editorial**: visão mensal/semanal/diária, drag-and-drop, filtro por grupo e por conta, status do post (rascunho → revisão → aprovado → agendado → publicando → publicado → falhou → cancelado) e status de cada destino.
- **Agendamento e fila de publicação**: dois modos — horário específico por post, e fila por slots (grade semanal de horários; o post entra no próximo slot livre). Jobs em fila com retry com backoff exponencial, idempotência, prevenção de duplicidade. Detalhes na seção 6.1.
- **Workflow de aprovação**: comentários internos, aprovação/rejeição por papel.
- **Campanhas**: agrupar posts/mídias com métricas consolidadas.
- **Analytics**: métricas por rede e comparativas, gráficos de crescimento/alcance/engajamento.
- **Relatórios**: exportação PDF/CSV por cliente/período/campanha.
- **Inbox**: comentários/mensagens centralizados (quando a API permitir).
- **Módulo de IA**: geração de legendas/títulos/hashtags/variações por rede, sempre com revisão humana obrigatória antes de publicar.
- **Reaproveitamento de conteúdo**: duplicar post publicado para outra data/rede/campanha.
- **Notificações**: publicação concluída/falhou, token expirado, conteúdo aguardando aprovação, etc.
- **Painel admin da plataforma**: visão de organizações, uso, erros, filas, custo estimado.
- **Billing**: planos (Free/Starter/Pro/Agency/Enterprise) com limites configuráveis — nunca hardcoded.

### 6.1 Multicontas, grupos de contas e publicação em lote (requisito central)

**Caso de uso de referência** — o sistema tem que atender isto de ponta a ponta: uma organização tem 20 contas do mesmo nicho, com nomes diferentes (5 no TikTok, 5 canais no YouTube, 5 no Instagram, 5 Páginas no Facebook). O usuário cria um grupo "Curiosidades" com parte dessas contas, cria **uma única publicação**, seleciona o grupo e agenda. Depois agenda várias publicações para o mesmo grupo, cada uma com seu dia e horário (ex.: segunda 10h, segunda 18h, terça 12h, quarta 20h), e cada uma sai automaticamente em todas as contas do grupo.

**Referência de mercado**: o modelo abaixo segue o que as ferramentas maduras fazem — separar o contêiner de permissão (Client/Brand) do atalho de seleção (grupo), como nos "Groups" e "Profile Collections" do Sprout Social, e ter fila por slots com fuso por conta, como no Buffer. O Metricool **não** serve de referência aqui, porque limita cada marca a uma conta por rede.

**Modelo obrigatório:**

- **Conta** (`SocialAccount`): N contas por rede por Client/Brand, cada uma com apelido interno editável (ex.: "TikTok 3 – Curiosidades") e fuso horário próprio (herdado do Client/Brand, sobrescrevível).
- **Grupo** (`AccountGroup` + `AccountGroupMember`): relação N:N — a mesma conta pode estar em "Curiosidades" e em "Todos os TikToks". É um atalho usado no compositor, como filtro no calendário/fila e como fonte em relatórios. Não concede permissão (seção 5).
- **Publicação** (`Post`): o conteúdo mestre com suas variações. Não publica nada sozinha.
- **Destino** (`PostTarget`): a unidade real de publicação — **uma por conta**. Cada destino tem status, horário agendado (em UTC), tentativas, ID/link remoto e erro próprios. Uma publicação para um grupo de 20 contas gera 20 destinos; falha em 3 não afeta os outros 17, e "tentar novamente" reprocessa só os que falharam. Idempotência por destino: a chave é (publicação, conta) — reenviar a requisição ou reprocessar um job nunca publica duas vezes na mesma conta.
- **Agendamento**, sempre por destino, em dois modos:
  - *Horário específico*: o usuário escolhe data/hora; por padrão vale para todos os destinos, com opção de ajustar por conta.
  - *Fila por slots*: cada conta tem uma grade semanal de horários (o grupo serve como atalho para configurar a grade de várias contas de uma vez); "adicionar à fila" coloca a publicação no próximo slot livre de cada conta.
- **Snapshot do grupo no agendamento**: ao agendar para um grupo, o sistema resolve o grupo em destinos naquele momento. Adicionar uma conta ao grupo depois **não** faz ela herdar agendamentos antigos; remover uma conta **não** cancela silenciosamente o que já estava agendado para ela. Se o grupo mudar e houver agendamentos futuros, a UI oferece a ação explícita "aplicar esta mudança aos agendamentos futuros", com preview do que muda.
- **Preview antes de confirmar**: ao selecionar um grupo, o compositor mostra a lista resolvida de destinos (conta por conta, com o nome real de cada perfil) e o resultado da validação de cada um.

**Validações por destino no momento do agendamento** (nunca deixar para descobrir às 3h da manhã, quando o job roda):

- Requisitos de mídia e de campos de cada rede (formato, proporção, duração, tamanho, título obrigatório etc.), a partir das capacidades declaradas em `SocialPlatform`.
- Cota de publicação da conta e do app/projeto naquele dia (seção 3). Se o agendamento estourar a cota, avisar e bloquear ou sugerir outro horário.
- Regra da plataforma sobre conteúdo igual em várias contas (seção 3). Onde a plataforma proíbe (ex.: X), o sistema bloqueia a publicação igual ou substancialmente semelhante em mais de uma conta e explica o motivo. Onde não há proibição explícita mas há risco, mostra um aviso.
- Requisitos de UX obrigatórios de cada plataforma. Exemplo: o Direct Post do TikTok exige que a tela de publicação mostre o perfil de destino, que a privacidade seja escolhida pelo usuário entre as opções retornadas pela API e que haja consentimento explícito antes do envio (confirme os detalhes atuais nas diretrizes oficiais). Selecionar um grupo **não** pode pular esses requisitos: o compositor precisa exibir e coletar essas escolhas para cada conta TikTok do grupo.

**Fuso horário**: todo horário é armazenado em UTC e exibido e interpretado no fuso da conta de destino. "Segunda às 10h" significa 10h no fuso configurado de cada conta — deixar isso explícito na UI. O Brasil tem mais de um fuso, e contas de outros países podem ter horário de verão.

### 7. Telas do produto (frontend)

Lista de telas esperadas — nem todas existem desde a Fase 0, elas vão sendo criadas conforme o roadmap avança:

- Login / Cadastro / Recuperação de senha
- Onboarding (criar organização)
- Dashboard (contas conectadas, posts publicados/agendados/com erro, resumo de métricas)
- Contas conectadas (lista agrupada por rede — Instagram, Facebook, TikTok, YouTube, X, Kwai — com **várias contas por rede**, apelido interno, fuso, status do token; conectar nova conta, reconectar e desconectar cada uma individualmente)
- Grupos de contas (criar/editar grupos, adicionar/remover contas de qualquer rede, configurar a grade de horários da fila para as contas do grupo)
- Biblioteca de mídia (grid de arquivos, upload, pastas, tags, preview)
- Novo conteúdo / Compositor (conteúdo mestre + variação por rede e override por conta; seleção de destinos por conta e/ou grupo; preview da lista resolvida de destinos com a validação de cada um; campos obrigatórios específicos de cada rede)
- Calendário editorial (visão mensal/semanal/diária, drag-and-drop, filtro por grupo/conta, status do post e de cada destino)
- Fila de publicação (lista de posts agendados, filtrável por grupo e por conta; status por destino; ações rápidas: editar, pausar, cancelar, duplicar, tentar novamente só os destinos que falharam)
- Aprovações (fila de conteúdo pendente + comentários internos)
- Campanhas (lista + página de detalhe com métricas consolidadas)
- Analytics (comparativo entre redes, gráficos de crescimento/alcance/engajamento)
- Relatórios (gerar e baixar PDF/CSV por cliente/período/campanha)
- Inbox (comentários/mensagens centralizados por rede)
- Configurações da organização (usuários, papéis/RBAC, clientes/marcas)
- Billing / Planos
- Painel admin da plataforma (visão interna do dono do SaaS: organizações, uso, erros, filas, custo estimado)

### 8. Modelo de dados (entidades principais)

`User, Organization, Membership, Role, Client, SocialAccount, SocialPlatform, AccountGroup, AccountGroupMember, PostingSchedule (slots semanais por conta), MediaAsset, Content, ContentVariant (por plataforma, com override opcional por conta), Post, PostTarget (destino: 1 por conta), Campaign, Approval, ApprovalComment, AnalyticsSnapshot, Comment, Notification, AuditLog, OAuthToken, PlatformQuotaUsage`

`PostTarget` substitui o antigo `ScheduledPost`: horário, status, tentativas, ID remoto e erro vivem no destino, não no post. Esse desenho vale **desde a Fase 0**, mesmo que no começo exista uma conta só — migrar depois de "um post, um horário" para "um post, N destinos" é caro.

Todas as entidades com dado de usuário devem suportar soft-delete (para permitir exclusão sob LGPD sem quebrar histórico/relatórios já emitidos) e `organizationId` indexado para garantir isolamento multi-tenant em nível de consulta, não só de aplicação.

### 9. Stack sugerida (pode ser trocada, mas justifique tecnicamente)

- Frontend: Next.js + TypeScript + Tailwind + shadcn/ui
- Backend: Node.js + TypeScript (NestJS ou arquitetura modular equivalente)
- Banco: PostgreSQL + Prisma (ou Drizzle)
- Fila: Redis + BullMQ
- Storage: S3-compatible (S3/R2/MinIO) por trás de uma interface `StorageProvider`
- Vídeo: FFmpeg em worker separado
- Auth: Auth.js ou equivalente seguro
- Observabilidade: logs estruturados + correlation ID + Sentry/OpenTelemetry
- Containers: Docker (Compose em dev, preparado para orquestração em produção)

### 10. Segurança

- HTTPS, criptografia de tokens em repouso, secrets só no backend (`.env`, nunca no código — criar `.env.example`).
- RBAC, rate limiting na API própria, proteção CSRF/XSS, validação e limite de upload, controle de MIME type.
- Logs de auditoria e isolamento rígido entre tenants.
- Autenticação de dois fatores (2FA) disponível para usuários da plataforma, obrigatória para papéis Owner/Admin a partir de determinado plano.
- Rotação periódica de secrets e credenciais de aplicativo (não confundir com tokens de conta de usuário, que seguem regra própria de expiração/renovação).
- Verificação automática de vulnerabilidades em dependências (SCA) rodando no pipeline de CI.
- Princípio do menor privilégio: nunca solicitar escopo de OAuth além do que a funcionalidade atual exige.

### 11. Privacidade e conformidade (LGPD)

- O sistema trata dados pessoais — do usuário da plataforma e, indiretamente, de terceiros via métricas/comentários vindos das redes sociais. Tratar como dado sensível desde o desenho do banco.
- Definir política de retenção: por quanto tempo mídia, tokens revogados, logs e snapshots de métricas ficam armazenados, com expurgo automático.
- Direito de exclusão: uma organização deve poder solicitar exclusão completa de seus dados (conta, mídia, tokens, histórico), incluindo revogação dos tokens OAuth junto às plataformas conectadas.
- Transparência de consentimento: mostrar claramente ao usuário quais permissões cada conexão de rede social concede, antes de autorizar.
- Documentar quais dados são compartilhados com subprocessadores (storage, fila, observabilidade/Sentry) — necessário para conformidade com a LGPD.
- Ter um processo documentado, mesmo que simples na v1, de resposta a incidente/vazamento de dados.

### 12. Resiliência e tratamento de falhas

- Cada `SocialMediaAdapter` implementa um circuit breaker: se uma plataforma falhar repetidamente, o sistema para de tentar por um tempo (evita martelar uma API fora do ar) e sinaliza isso no painel.
- Fila com dead-letter queue: jobs que esgotam as tentativas de retry vão para uma fila separada, visível no painel admin — nunca somem silenciosamente.
- Retry com backoff exponencial + jitter, limite máximo de tentativas configurável por tipo de operação.
- Toda chamada a API externa tem timeout explícito — nunca espera indefinidamente.
- Falha em uma plataforma ou conta não pode travar a publicação nas demais: publicação para várias contas é tratada **por destino (uma unidade por conta)** — não por plataforma, e nunca como transação única. Token expirado no TikTok 3 não afeta TikTok 1, 2, 4 e 5.
- Cotas de publicação (por conta e por app/projeto) são controladas pelo próprio sistema (`PlatformQuotaUsage`), consultadas no agendamento e respeitadas pelo worker, que reagenda em vez de gastar tentativas contra um limite já estourado. Atenção especial a cotas que são por app/projeto e não por conta (ex.: a do YouTube é por projeto do Google Cloud, ou seja, compartilhada por todos os clientes do SaaS).

### 13. Observabilidade e SLOs

- Logs estruturados com correlation ID atravessando API → fila → worker → chamada externa, para rastrear uma publicação específica ponta a ponta.
- Métricas técnicas mínimas: taxa de erro por plataforma, tamanho da fila, tempo médio de processamento de job, taxa de tokens expirados.
- Alertas automáticos para: fila acima de um limite, taxa de falha de publicação acima de um limiar, worker parado, token de aplicativo (não de usuário) perto de expirar.
- Health checks (`/healthz`, `/readyz`) para orquestração de containers saber quando a aplicação está pronta.

### 14. CI/CD e ambientes

- Três ambientes — desenvolvimento local, staging e produção — com variáveis e credenciais de app separadas por ambiente (nunca usar credencial de produção em staging/dev).
- Pipeline de CI obrigatório antes de merge: lint, type-check, testes automatizados. Nenhum merge direto na branch principal sem passar por isso.
- Migrations de banco versionadas, aplicadas automaticamente no deploy, com estratégia de rollback documentada.
- Feature flags para ativar/desativar uma integração de plataforma ou funcionalidade por organização sem precisar de novo deploy — importante porque cada rede social pode ficar fora do ar ou com aprovação pendente em momentos diferentes.

### 15. Backup e disaster recovery

- Backup automático e periódico do banco de dados, com teste de restauração documentado (backup nunca restaurado não é um backup confiável).
- Definir metas de RPO (quanto dado se pode perder) e RTO (quanto tempo para recuperar), mesmo que modestas na v1.
- Mídia armazenada em storage com redundância (replicação do provedor S3-compatible).
- Tokens e credenciais críticas devem poder ser revogados em massa em caso de incidente de segurança.

### 16. API interna e webhooks

API REST documentada via OpenAPI/Swagger, com versionamento explícito (`/v1/...`) para permitir evoluir sem quebrar integrações futuras. Endpoints de webhook por plataforma (`/webhooks/instagram`, `/webhooks/tiktok`, etc.) com validação de assinatura e processamento assíncrono.

### 17. Roadmap de fases

**Fase 0 — Walking skeleton (fazer antes de tudo o resto)**
Um fluxo mínimo ponta a ponta funcionando de verdade: login → conectar UMA rede social real via OAuth → publicar UM post de teste através da API oficial → ver o resultado. Escolha a plataforma mais simples de validar primeiro (avalie qual tem menor barreira de aprovação para uma conta de teste — confirme isso na documentação atual antes de decidir). O objetivo aqui não é cobertura, é validar que auth, fila, worker e adapter pattern funcionam de ponta a ponta antes de replicar para as outras redes. O modelo de dados já nasce com `Post` → `PostTarget` (seção 8), mesmo publicando para uma conta só. Nesta fase, confirme também a situação do Kwai (seção 3).

**Fase 1 — Núcleo**: autenticação, organizações, usuários, RBAC.

**Fase 2 — Social Accounts**: OAuth genérico + primeira rede real (a mesma da Fase 0, agora completa), já com várias contas da mesma rede, apelido e fuso por conta, e grupos de contas (seção 6.1).

**Fase 3 — Biblioteca de mídia**

**Fase 4 — Compositor de conteúdo** (incluindo seleção de destinos por conta/grupo, preview da lista resolvida e override por conta)

**Fase 5 — Agendamento e engine de publicação** (fila, retry, idempotência por destino, circuit breaker, dead-letter queue, agendamento para grupos com snapshot, fila por slots, controle de cota e validações por destino no agendamento — seção 6.1)

**Fase 6 a 10 — Demais integrações, uma por vez**: Instagram/Facebook (Meta Graph API costuma compartilhar boa parte da infraestrutura), TikTok, YouTube, X, Kwai — nessa ordem ou na que fizer mais sentido após a Fase 0 revelar as barreiras reais de cada uma.

**Fase 11 — Analytics**

**Fase 12 — Workflow de aprovação**

**Fase 13 — Módulo de IA**

**Fase 14 — Billing**

**Fase 15 — Hardening e preparação para produção real**: revisão de segurança (seção 10), checklist de LGPD (seção 11), teste de restauração de backup (seção 15), teste de carga contra os alvos de performance (seção 2), revisão de alertas/SLOs (seção 13).

### 18. Definition of Done (aplicar em toda fase)

- Projeto builda e roda localmente sem passos manuais escondidos.
- Testes da fase escritos e passando.
- `.env.example` atualizado se novas variáveis foram criadas.
- Toda nova chamada a serviço externo tem timeout, tratamento de erro e, quando fizer sentido, retry/circuit breaker.
- `STATUS.md` atualizado (o que foi feito, decisões técnicas, pendências, o que depende de mim).
- Commit feito com mensagem descritiva.
- Nenhuma funcionalidade da fase está "fingindo" funcionar — se algo depende de aprovação externa ainda não obtida, isso está explicitamente sinalizado na UI e no código.

### 19. O que nunca fazer

Inventar endpoints ou comportamento de API; scraping quando existir API oficial; tokens no frontend; dados hardcoded que deveriam ser configuráveis (limites de plano, por exemplo); mocks disfarçados de integração real; pular a confirmação entre fases; ignorar timeout/retry em chamadas externas "para simplificar"; permitir publicação igual em várias contas onde a plataforma proíbe; deixar mudanças em um grupo alterarem silenciosamente agendamentos já feitos; modelar "uma conta por rede" em qualquer camada.

### 20. Documentação exigida

`README.md`, `ARCHITECTURE.md`, `SOCIAL_INTEGRATIONS.md` (matriz da seção 3), `API_DOCUMENTATION.md`, `DEPLOYMENT.md`, `SECURITY.md`, `PRIVACY.md` (retenção de dados e conformidade LGPD), `STATUS.md` (vivo, atualizado a cada fase).

### 21. Testes

Unitários, integração, testes de autenticação, de agendamento/retry, de publicação, de isolamento multi-tenant, de circuit breaker/dead-letter queue. Cenários obrigatórios: API indisponível, token expirado, upload interrompido, publicação duplicada, timeout, rate limit, webhook inválido, usuário sem permissão. Cenários obrigatórios de multicontas (a partir das fases em que se aplicam): publicação para um grupo de 20 contas em que 3 falham (só as 3 são reprocessadas, sem duplicar nas outras 17); conta adicionada e conta removida de um grupo que tem agendamentos futuros (nada muda sem ação explícita); grupo contendo conta sem permissão do usuário; mesmo conteúdo para duas contas do X (bloqueado no agendamento); cota do dia estourada detectada no agendamento; post agendado para conta com fuso diferente do fuso do usuário. A partir da Fase 5, incluir um teste de carga básico contra a fila de publicação, validando os alvos da seção 2.
