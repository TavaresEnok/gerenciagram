# Integrações com as redes sociais

Matriz exigida pela **SPEC seção 3**. Cada linha veio da documentação oficial
da plataforma, consultada em **10/09/2026**. As URLs estão no fim de cada
seção.

> **Como ler este documento.** "Suportado via API oficial" descreve o que a
> plataforma oferece. "Implementado aqui" descreve o que este sistema já
> escreveu. São coisas diferentes: o Instagram tem API de publicação madura e
> mesmo assim aparece como indisponível na interface, porque o adapter ainda
> não existe.
>
> Estes valores **não são só documentação**: eles vivem em
> [`packages/core/src/platform/registry.ts`](packages/core/src/platform/registry.ts),
> são semeados na tabela `social_platforms` e alimentam diretamente as
> validações por destino do momento do agendamento (SPEC seção 6.1). Mudar a
> tabela aqui sem mudar o registro não muda o comportamento — e vice-versa.

---

## Resumo

| Rede | API oficial de publicação | Implementado aqui | Barreira principal |
|---|---|---|---|
| **YouTube** | Sim | ✅ Sim (Fase 0) | Cota de 100 uploads/dia **por projeto**, compartilhada por todos os clientes |
| **Instagram** | Sim | ❌ Fase 6 | App Review + verificação de negócio + conta profissional |
| **Facebook** | Sim | ❌ Fase 6 | App Review + permissões de Página |
| **TikTok** | Sim | ❌ Fase 7 | Auditoria do app; sem ela, tudo sai como `SELF_ONLY` |
| **X** | Sim (pago) | ❌ Fase 9 | Plano pago **e** proibição de conteúdo duplicado entre contas |
| **Kwai** | **Não** | ❌ Fora da v1 | Não existe API pública de publicação para terceiros |

---

## YouTube — implementado

| Campo | Valor |
|---|---|
| **Recurso** | Publicar vídeo, ler métricas, ler e responder comentários, excluir vídeo |
| **Suportado via API oficial?** | Sim |
| **Requer aprovação/revisão do app?** | Não para publicar. **Sim** para o vídeo sair público: sem auditoria de conformidade, todo upload fica travado em "privado" |
| **Requer conta business/creator?** | Não. Basta a conta Google ter um canal |
| **Limitação conhecida** | Métricas de alcance e retenção exigem a YouTube Analytics API (outro escopo). Responder comentários exige `youtube.force-ssl`, que não é pedido na conexão padrão |
| **Cota de publicação** | **100 chamadas `videos.insert`/dia · 100 `search.list`/dia · 10.000 unidades/dia** para os demais endpoints — os três **por projeto do Google Cloud** |
| **Conteúdo igual em várias contas** | **Permitido**, com ressalva. O YouTube não proíbe, mas as políticas de spam penalizam republicação idêntica sem valor agregado → o sistema **avisa** |
| **Requisitos de UX obrigatórios** | Mostrar o canal de destino; escolher visibilidade; escolher categoria (vinda de `videoCategories.list`, varia por região); declarar se é conteúdo para crianças (COPPA) |
| **Documentação** | https://developers.google.com/youtube/v3/docs/videos/insert |

### O ponto que muda a arquitetura

A cota é **por projeto**, não por conta. Um cliente que agende 100 vídeos
consome a cota de **todos os outros clientes do SaaS naquele dia**. Por isso a
linha de cota de app em `platform_quota_usage` tem `organizationId` nulo —
ela não pertence a tenant nenhum — e o validador informa isso na mensagem:
_"limite compartilhado por toda a plataforma"_.

O aumento de cota é pedido pelo *Quota extension request form* do Google.

### Como obter as credenciais

1. Crie um projeto no [Google Cloud Console](https://console.cloud.google.com/).
2. Ative a **YouTube Data API v3**.
3. Em *APIs & Services → OAuth consent screen*, configure o app. Em modo
   **Testing**, até 100 usuários de teste funcionam sem verificação.
4. Em *Credentials → Create credentials → OAuth client ID → Web application*,
   cadastre a redirect URI:
   `http://localhost:3001/v1/oauth/youtube/callback`
   (o YouTube **aceita `http://localhost`** — é a única das seis redes que
   dispensa túnel HTTPS para desenvolver).
5. Preencha `YOUTUBE_CLIENT_ID` e `YOUTUBE_CLIENT_SECRET` no `.env`.

**Fontes:**
[Getting started](https://developers.google.com/youtube/v3/getting-started) ·
[Quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost) ·
[Upload retomável](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)

---

## Instagram — Fase 6

| Campo | Valor |
|---|---|
| **Recurso** | Publicar imagem, Reels, carrossel e story; ler métricas; ler e responder comentários |
| **Suportado via API oficial?** | Sim |
| **Requer aprovação/revisão do app?** | **Sim** — App Review da Meta + verificação de negócio |
| **Requer conta business/creator?** | **Sim** — conta profissional vinculada a uma Página, com *Page Publishing Authorization* concluída |
| **Limitação conhecida** | Só **JPEG** (MPO e JPS não são aceitos). A mídia precisa estar numa **URL pública** acessível pela Meta. Não há exclusão de mídia publicada pela API. Sem agendamento nativo |
| **Cota de publicação** | **100 publicações por conta em 24h** (janela móvel). Carrossel conta como 1. Consultável em `GET /content_publishing_limit` |
| **Conteúdo igual em várias contas** | **Restrito** — não há proibição explícita, mas as políticas de spam e comportamento inautêntico penalizam publicação repetitiva coordenada → o sistema **avisa** |
| **Requisitos de UX obrigatórios** | Mostrar o perfil de destino |
| **Documentação** | https://developers.facebook.com/docs/instagram-platform/content-publishing |

**Escopos:** `instagram_business_basic`, `instagram_business_content_publish`
(login pelo Instagram) ou `instagram_basic`, `instagram_content_publish`,
`pages_read_engagement` (login pelo Facebook).

> ⚠️ A Meta **não aceita `http://localhost`** como redirect URI. Para
> desenvolver é preciso um túnel HTTPS público (Cloudflare Tunnel, ngrok) e
> apontar `OAUTH_PUBLIC_URL` para ele.

---

## Facebook — Fase 6

| Campo | Valor |
|---|---|
| **Recurso** | Publicar texto, link, foto e vídeo numa Página; agendar nativamente; ler métricas; responder comentários; excluir publicação |
| **Suportado via API oficial?** | Sim |
| **Requer aprovação/revisão do app?** | **Sim** para publicar em Páginas de terceiros (*Page Public Content Access*) |
| **Requer conta business/creator?** | **Sim** — publicação é em Página, não em perfil pessoal |
| **Limitação conhecida** | Não há carrossel orgânico direto (várias fotos viram álbum). Stories de Página têm API própria |
| **Cota de publicação** | **Não documentada como número fixo.** O rate limit da Graph API é por app e calculado dinamicamente → marcado como **não verificado**, e o sistema apenas avisa |
| **Conteúdo igual em várias contas** | **Restrito** — mesma ressalva do Instagram → o sistema **avisa** |
| **Requisitos de UX obrigatórios** | Mostrar a Página de destino |
| **Documentação** | https://developers.facebook.com/docs/pages-api/posts |

**Escopos:** `pages_manage_posts`, `pages_read_engagement`, `publish_video`.

**Particularidade útil:** é a única das seis com **agendamento nativo**
documentado — `scheduled_publish_time`, que precisa ficar entre **10 minutos e
30 dias** da chamada. Fora dessa janela a API recusa, então o agendamento
longo continua sendo da nossa fila.

---

## TikTok — Fase 7

| Campo | Valor |
|---|---|
| **Recurso** | Publicar vídeo (Direct Post) e fotos |
| **Suportado via API oficial?** | Sim — Content Posting API |
| **Requer aprovação/revisão do app?** | **Sim, e é a barreira mais dura.** Sem auditoria, **todo conteúdo sai como `SELF_ONLY` (privado)**, o cliente fica limitado a **5 usuários publicando em 24h** e todas as contas precisam estar privadas no momento da publicação |
| **Requer conta business/creator?** | Não |
| **Limitação conhecida** | Sem agendamento nativo. Sem exclusão pela API. Métricas dependem de escopos liberados caso a caso |
| **Cota de publicação** | **Varia por criador** (a documentação indica ~15/dia como ordem de grandeza, sem fixar número) → marcado como **não verificado**; o sistema avisa e deixa a plataforma decidir |
| **Conteúdo igual em várias contas** | **Restrito** — as diretrizes penalizam conteúdo duplicado e não original, sem proibir explicitamente contas próprias → o sistema **avisa** |
| **Requisitos de UX obrigatórios** | **Os mais extensos das seis redes** — ver abaixo |
| **Documentação** | https://developers.tiktok.com/doc/content-posting-api-get-started |

### Requisitos de UX que o compositor precisa cumprir

Estas exigências estão nas *Content Sharing Guidelines* e são o exemplo que a
**SPEC seção 6.1** cita nominalmente. Selecionar um grupo **não pula nenhuma
delas**: o compositor coleta os campos **por conta**.

1. **Mostrar o apelido do criador**, para a pessoa saber em qual conta o
   conteúdo vai ser publicado.
2. **Privacidade escolhida manualmente, sem valor padrão.** As opções precisam
   vir de `creator_info` — uma conta privada não oferece `PUBLIC_TO_EVERYONE`.
   Por isso o campo está no registro como `optionsFromApi: true` com lista
   vazia: **fixar as opções no código seria inventar comportamento de API**.
3. **Consentimento explícito antes do envio**, com o texto:
   _"Ao publicar, você concorda com a Confirmação de Uso de Música do
   TikTok"_ — e, se houver conteúdo de marca, também com a Política de
   Conteúdo de Marca.
4. **Controles de interação**: permitir comentário, Duet e Stitch.
5. **Divulgação de conteúdo comercial**: caixas para "sua marca" e "conteúdo
   de marca".

**Fonte:** https://developers.tiktok.com/doc/content-sharing-guidelines

---

## X — Fase 9

| Campo | Valor |
|---|---|
| **Recurso** | Publicar texto, imagem e vídeo; responder; excluir |
| **Suportado via API oficial?** | Sim, **mas o acesso de escrita é pago** |
| **Requer aprovação/revisão do app?** | Não há review formal, mas é preciso um **plano pago** com permissão de escrita |
| **Requer conta business/creator?** | Não |
| **Limitação conhecida** | Até 4 imagens por post. Vídeo em upload por pedaços. Métricas dependem do nível do plano contratado |
| **Cota de publicação** | **Depende do plano contratado**, sem número universal → marcado como **não verificado** |
| **Conteúdo igual em várias contas** | 🚫 **PROIBIDO** — ver abaixo |
| **Requisitos de UX obrigatórios** | Mostrar o perfil de destino |
| **Documentação** | https://docs.x.com/x-api |

### A regra que o sistema BLOQUEIA

A política de automação do X é literal:

> _"You may not post duplicative or substantially similar posts on one account
> or over multiple accounts you operate."_

É o caso que a **SPEC seção 6.1** manda barrar, e o único das seis redes com
`policy: FORBIDDEN` no registro. Consequências no produto:

- agendar o **mesmo conteúdo — ou texto substancialmente semelhante** — para
  duas contas do X é **recusado no momento do agendamento**, com o motivo e o
  link da política;
- a detecção usa similaridade de trigramas (limiar 0,9), não igualdade exata:
  trocar um emoji ou uma hashtag não escapa da checagem;
- automatizar contas para fins **relacionados mas não duplicativos** é
  permitido pelo X — o sistema não impede isso, só o conteúdo repetido.

Violar a regra pode suspender as contas envolvidas **e** o acesso à API.

**Fontes:**
[Regras de automação](https://help.x.com/en/rules-and-policies/x-automation) ·
[Política do desenvolvedor](https://docs.x.com/developer-terms/policy)

---

## Kwai — fora da v1

| Campo | Valor |
|---|---|
| **Recurso** | Publicar vídeo |
| **Suportado via API oficial?** | ❌ **Não** |
| **Requer aprovação/revisão do app?** | — |
| **Requer conta business/creator?** | — |
| **Limitação conhecida** | Não existe API pública de publicação de conteúdo orgânico para terceiros |
| **Cota de publicação** | — |
| **Conteúdo igual em várias contas** | Não verificado (sem integração) |
| **Requisitos de UX obrigatórios** | — |
| **Documentação** | https://www.kwai.com/third-party |

### Verificação exigida pela SPEC seção 3

Consulta feita em **10/09/2026**. O que o Kwai documenta publicamente:

- uma **API de anúncios**, com escopos `ad_mapi_campaign_*`, `ad_mapi_unit_*`,
  `ad_mapi_creative_*`, `ad_mapi_material_*` e `ad_mapi_report`;
- um **Kwai OpenID Connect** para autenticação;
- acesso concedido **caso a caso**, por solicitação a `Kwaiapi@kuaishou.com`.

Nenhum desses recursos publica vídeo orgânico numa conta de usuário.

**Conclusão:** o Kwai **sai da promessa da v1**. Na interface ele aparece como
indisponível, com a mensagem que a SPEC exige:

> _"Este recurso não está disponível pela API oficial desta plataforma."_

Scraping ou automação do aplicativo **não são alternativas aceitáveis**
(SPEC seção 19) e não serão implementados.

Se o Kwai publicar uma API de conteúdo no futuro, o caminho é: pesquisar a
documentação, preencher a definição em `registry.ts`, escrever o adapter e
virar `isAvailable: true`. Nada mais no sistema precisa mudar.

---

## O que falta para cada rede sair do papel

Tudo abaixo depende de **credenciais e aprovações externas** que só o dono do
projeto pode obter. O código está preparado para todas — falta a credencial.

| Rede | Pendências |
|---|---|
| **YouTube** | Projeto no Google Cloud + OAuth client. *(Opcional: auditoria de conformidade para o vídeo sair público, e aumento de cota.)* |
| **Instagram / Facebook** | App na Meta + verificação de negócio + App Review das permissões de publicação + conta profissional vinculada a Página + **túnel HTTPS** para o callback |
| **TikTok** | App no TikTok for Developers + **auditoria** para o Direct Post sair do modo `SELF_ONLY` + túnel HTTPS |
| **X** | **Plano pago** da API com permissão de escrita |
| **Kwai** | Nada a fazer até existir uma API oficial de publicação |

### Callback de OAuth

| Rede | Aceita `http://localhost`? |
|---|---|
| YouTube | ✅ Sim |
| Instagram / Facebook | ❌ Não — exige HTTPS público |
| TikTok | ❌ Não — exige HTTPS público |
| X | ❌ Não — exige HTTPS público |

Para as que exigem HTTPS, use um túnel e aponte `OAUTH_PUBLIC_URL` para ele:

```bash
cloudflared tunnel --url http://localhost:3001
```

A URI a cadastrar no console de cada plataforma segue sempre o mesmo formato:

```
${OAUTH_PUBLIC_URL}/v1/oauth/<rede>/callback
```
