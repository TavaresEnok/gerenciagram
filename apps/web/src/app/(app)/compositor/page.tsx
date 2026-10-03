'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import {
  AreaTexto,
  Aviso,
  Botao,
  Campo,
  Cartao,
  Carregando,
  Etiqueta,
  Modal,
  Selecao,
  Vazio,
} from '@/components/ui';
import { Check, Copy, Sparkles, Wand2 } from 'lucide-react';
import { useToast } from '@/components/toast';
import { ApiError, api } from '@/lib/api';
import { useApi } from '@/lib/sessao';

/**
 * Compositor de conteúdo (SPEC seções 6 e 6.1).
 *
 * O fluxo segue exatamente a exigência da especificação:
 *
 *   1. conteúdo mestre (texto + mídia)
 *   2. variação por rede e override por conta
 *   3. seleção de destinos por grupo E/OU por conta
 *   4. PREVIEW da lista resolvida — conta por conta, com o nome real do
 *      perfil, o horário no fuso DAQUELA conta e a validação de cada uma
 *   5. só então o agendamento
 *
 * O passo 4 não é enfeite: é onde formato de mídia, cota, conteúdo duplicado
 * e campo obrigatório da rede são detectados, com a pessoa olhando a tela —
 * em vez de às 3h da manhã, quando o job roda.
 */

interface Conta {
  id: string;
  platform: string;
  platformName: string;
  nickname: string;
  remoteDisplayName: string | null;
  timezone: string;
  status: string;
  clientName: string;
}

interface Grupo {
  id: string;
  name: string;
  memberCount: number;
  countByPlatform: Record<string, number>;
}

interface Midia {
  id: string;
  originalFilename: string;
  type: string;
  mimeType: string;
  processingStatus: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  url: string;
}

interface CampoObrigatorio {
  key: string;
  label: string;
  type: 'SELECT' | 'BOOLEAN' | 'TEXT' | 'CONSENT';
  required: boolean;
  optionsFromApi: boolean;
  options: Array<{ value: string; label: string }>;
  helpText?: string;
  consentText?: string;
}

interface Plataforma {
  key: string;
  displayName: string;
  requiredUxFields: { fields: CampoObrigatorio[]; mustShowTargetProfile: boolean };
  mediaRequirements: {
    maxTitleLength?: number;
    maxCaptionLength?: number;
    titleRequired?: boolean;
  };
}

interface DestinoPreview {
  accountId: string;
  nickname: string;
  remoteDisplayName: string | null;
  platform: string;
  platformName: string;
  timezone: string;
  accountStatus: string;
  scheduledAt: string | null;
  scheduledAtLocal: string | null;
  title: string | null;
  body: string;
  hashtags: string[];
  platformFields: Record<string, unknown>;
  issues: Array<{ code: string; severity: string; message: string; field?: string }>;
  canSchedule: boolean;
}

interface Preview {
  targets: DestinoPreview[];
  excluded: Array<{ accountId: string; nickname: string; reason: string }>;
  allValid: boolean;
  timezoneDiverges: boolean;
  summary: { total: number; schedulable: number; blocked: number; warnings: number };
}

type Modo = 'SPECIFIC_TIME' | 'QUEUE_SLOT';

export default function PaginaCompositor() {
  const router = useRouter();

  const { dados: contasResposta, carregando: carregandoContas } = useApi<{ accounts: Conta[] }>(
    '/v1/accounts',
  );
  const { dados: gruposResposta } = useApi<{ groups: Grupo[] }>('/v1/groups');
  const { dados: midiasResposta } = useApi<{ assets: Midia[] }>('/v1/media?limit=60');
  const { dados: plataformasResposta } = useApi<{ platforms: Plataforma[] }>('/v1/platforms');

  // --- Conteúdo mestre ---
  const [titulo, setTitulo] = useState('');
  const [corpo, setCorpo] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [midiasSelecionadas, setMidiasSelecionadas] = useState<string[]>([]);

  // --- Destinos ---
  const [gruposSelecionados, setGruposSelecionados] = useState<string[]>([]);
  const [contasSelecionadas, setContasSelecionadas] = useState<string[]>([]);

  // --- Variações e overrides ---
  const [variacoes, setVariacoes] = useState<
    Record<string, { title?: string; body?: string; platformFields?: Record<string, unknown> }>
  >({});

  // --- Agendamento ---
  const [modo, setModo] = useState<Modo>('SPECIFIC_TIME');
  const [dataHoraLocal, setDataHoraLocal] = useState(proximaHoraCheia());
  const [espacamentoMinutos, setEspacamentoMinutos] = useState<number>(0);

  // --- Notificações & Feedback ---
  const { sucesso, erro: toastErro, info: toastInfo } = useToast();

  // --- Assistente Criativo com IA ---
  const [modalIaAberto, setModalIaAberto] = useState(false);
  const [iaBrief, setIaBrief] = useState('');
  const [iaKind, setIaKind] = useState<'CAPTION' | 'TITLE' | 'HASHTAGS' | 'VARIATIONS'>('CAPTION');
  const [iaPlatform, setIaPlatform] = useState<string>('INSTAGRAM');
  const [iaTone, setIaTone] = useState<string>('descontraído e envolvente');
  const [iaGerando, setIaGerando] = useState(false);
  const [iaSugestoes, setIaSugestoes] = useState<string[]>([]);
  const [iaProvider, setIaProvider] = useState<string | null>(null);
  const [iaCopiado, setIaCopiado] = useState<number | null>(null);
  /**
   * Proveniência do texto: true depois que uma sugestão da IA foi APLICADA
   * a este conteúdo nesta tela. É isso que vai no `aiGenerated` do save —
   * sem isto, o texto sugerido entrava como se tivesse sido digitado.
   */
  const [conteudoUsouIa, setConteudoUsouIa] = useState(false);
  /** Estado de revisão gravado no servidor (vem da resposta do save). */
  const [iaRevisao, setIaRevisao] = useState<{
    aiGenerated: boolean;
    aiReviewedAt: string | null;
  } | null>(null);
  const [registrandoRevisao, setRegistrandoRevisao] = useState(false);

  // --- Preview ---
  const [preview, setPreview] = useState<Preview | null>(null);
  const [contentId, setContentId] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [processando, setProcessando] = useState(false);
  const [seletorMidia, setSeletorMidia] = useState(false);

  const contas = useMemo(() => contasResposta?.accounts ?? [], [contasResposta]);
  const grupos = useMemo(() => gruposResposta?.groups ?? [], [gruposResposta]);
  const midias = midiasResposta?.assets ?? [];
  const plataformas = plataformasResposta?.platforms ?? [];

  /** Redes efetivamente atingidas pela seleção atual. */
  const redesAlvo = useMemo(() => {
    const ids = new Set(contasSelecionadas);
    for (const grupo of grupos) {
      if (gruposSelecionados.includes(grupo.id)) {
        for (const rede of Object.keys(grupo.countByPlatform)) ids.add(`rede:${rede}`);
      }
    }

    const redes = new Set<string>();
    for (const conta of contas) {
      if (ids.has(conta.id)) redes.add(conta.platform);
    }
    for (const item of ids) {
      if (item.startsWith('rede:')) redes.add(item.slice(5));
    }
    return [...redes];
  }, [contas, grupos, contasSelecionadas, gruposSelecionados]);

  const temDestino = gruposSelecionados.length > 0 || contasSelecionadas.length > 0;

  /**
   * Cria (ou atualiza) o conteúdo e pede o preview.
   *
   * O conteúdo precisa existir no servidor para o preview resolver a cascata
   * de variações exatamente como o worker vai resolver na hora de publicar.
   */
  const gerarPreview = useCallback(async () => {
    setErro(null);
    setProcessando(true);

    try {
      const listaHashtags = hashtags
        .split(/[\s,]+/)
        .map((tag) => tag.replace(/^#/, '').trim())
        .filter(Boolean);

      const corpoConteudo = {
        title: titulo || undefined,
        body: corpo,
        hashtags: listaHashtags,
        mediaAssetIds: midiasSelecionadas,
        // Proveniência: se uma sugestão da IA foi aplicada nesta tela, o
        // conteúdo É de IA e o servidor passa a exigir revisão humana antes
        // de agendar/publicar. Sem este campo a revisão seria burlável.
        ...(conteudoUsouIa ? { aiGenerated: true } : {}),
      };

      const conteudo = contentId
        ? await api<{ id: string; aiGenerated: boolean; aiReviewedAt: string | null }>(
            `/v1/contents/${contentId}`,
            {
              method: 'PATCH',
              body: corpoConteudo,
            },
          )
        : await api<{ id: string; aiGenerated: boolean; aiReviewedAt: string | null }>(
            '/v1/contents',
            { method: 'POST', body: corpoConteudo },
          );

      setContentId(conteudo.id);
      // O servidor é a fonte da verdade da revisão: editar depois de revisar
      // derruba a aprovação, e é a resposta dele que reflete isso na tela.
      setIaRevisao({ aiGenerated: conteudo.aiGenerated, aiReviewedAt: conteudo.aiReviewedAt });

      // Variações por rede (e overrides por conta) num único PUT.
      const listaVariacoes = Object.entries(variacoes).map(([chave, valor]) => {
        const [plataforma, contaId] = chave.split('|');
        return {
          platform: plataforma,
          socialAccountId: contaId ?? null,
          title: valor.title ?? null,
          body: valor.body ?? null,
          platformFields: valor.platformFields ?? {},
        };
      });

      if (listaVariacoes.length > 0) {
        await api(`/v1/contents/${conteudo.id}/variants`, {
          method: 'PUT',
          body: { variants: listaVariacoes },
        });
      }

      const resultado = await api<Preview>('/v1/posts/preview', {
        method: 'POST',
        body: {
          contentId: conteudo.id,
          selection: {
            groupIds: gruposSelecionados.length > 0 ? gruposSelecionados : undefined,
            accountIds: contasSelecionadas.length > 0 ? contasSelecionadas : undefined,
          },
          schedule: {
            mode: modo,
            localDateTime: modo === 'SPECIFIC_TIME' ? dataHoraLocal : undefined,
            staggerMinutes: espacamentoMinutos > 0 ? espacamentoMinutos : undefined,
          },
        },
      });

      setPreview(resultado);
    } catch (caught) {
      setErro(caught instanceof ApiError ? caught.message : 'Não foi possível gerar o preview.');
    } finally {
      setProcessando(false);
    }
  }, [
    titulo,
    corpo,
    hashtags,
    midiasSelecionadas,
    contentId,
    conteudoUsouIa,
    variacoes,
    gruposSelecionados,
    contasSelecionadas,
    modo,
    dataHoraLocal,
    espacamentoMinutos,
  ]);

  async function agendar(parcial: boolean) {
    if (!contentId) return;
    setErro(null);
    setProcessando(true);

    try {
      const resultado = await api<{ postId: string; scheduled: number; skipped: number }>(
        '/v1/posts',
        {
          method: 'POST',
          // Chave de idempotência: um duplo clique não cria duas publicações
          // para as mesmas contas (SPEC seção 2).
          idempotencyKey: `composer-${contentId}-${dataHoraLocal}-${modo}-${espacamentoMinutos}`,
          body: {
            contentId,
            selection: {
              groupIds: gruposSelecionados.length > 0 ? gruposSelecionados : undefined,
              accountIds: contasSelecionadas.length > 0 ? contasSelecionadas : undefined,
            },
            schedule: {
              mode: modo,
              localDateTime: modo === 'SPECIFIC_TIME' ? dataHoraLocal : undefined,
              staggerMinutes: espacamentoMinutos > 0 ? espacamentoMinutos : undefined,
            },
            allowPartial: parcial,
          },
        },
      );

      sucesso('Publicação agendada com sucesso!');
      router.push(`/fila?post=${resultado.postId}`);
    } catch (caught) {
      setErro(caught instanceof ApiError ? caught.message : 'Não foi possível agendar.');
      setProcessando(false);
    }
  }

  async function gerarSugestaoIa() {
    if (!iaBrief.trim()) {
      toastErro('Informe o assunto ou briefing para a IA.');
      return;
    }
    setIaGerando(true);
    setIaSugestoes([]);

    try {
      const resp = await api<{
        suggestions: string[];
        provider: string;
        requiresHumanReview: boolean;
      }>('/v1/ai/suggest', {
        method: 'POST',
        body: {
          kind: iaKind,
          platform: iaPlatform,
          brief: iaBrief,
          tone: iaTone || undefined,
          count: 3,
        },
      });

      setIaSugestoes(resp.suggestions);
      setIaProvider(resp.provider);
      sucesso('Sugestões geradas!', `Motor ativo: ${resp.provider}`);
    } catch (caught) {
      toastErro(
        'Falha ao gerar sugestões',
        caught instanceof ApiError ? caught.message : String(caught),
      );
    } finally {
      setIaGerando(false);
    }
  }

  function aplicarSugestao(texto: string) {
    if (iaKind === 'TITLE') {
      setTitulo(texto);
    } else if (iaKind === 'CAPTION' || iaKind === 'VARIATIONS') {
      setCorpo(texto);
    } else if (iaKind === 'HASHTAGS') {
      setHashtags(texto.replace(/#/g, '').trim());
    }
    // Proveniência: o texto aplicado veio da IA. O save manda isso ao
    // servidor, que passa a exigir revisão humana antes de publicar.
    setConteudoUsouIa(true);
    setModalIaAberto(false);
    sucesso('Conteúdo aplicado ao post!', 'Lembre-se: conteúdo de IA requer revisão humana.');
  }

  /**
   * Revisão humana é uma AÇÃO explícita — nunca um efeito colateral de
   * editar ou salvar. Vinculada à versão revisada no servidor: mexer no
   * texto depois exige revisar de novo.
   */
  async function registrarRevisaoIa() {
    if (!contentId) return;
    setRegistrandoRevisao(true);
    setErro(null);

    try {
      const resposta = await api<{ reviewedAt: string }>(`/v1/contents/${contentId}/ai-review`, {
        method: 'POST',
      });
      setIaRevisao((atual) =>
        atual ? { ...atual, aiReviewedAt: resposta.reviewedAt } : atual,
      );
      sucesso('Revisão registrada', 'O conteúdo foi aprovado para publicação.');
    } catch (caught) {
      toastErro(
        'Não foi possível registrar a revisão',
        caught instanceof ApiError ? caught.message : String(caught),
      );
    } finally {
      setRegistrandoRevisao(false);
    }
  }

  function copiarSugestao(texto: string, idx: number) {
    void navigator.clipboard.writeText(texto);
    setIaCopiado(idx);
    setTimeout(() => setIaCopiado(null), 2000);
    toastInfo('Copiado para a área de transferência!');
  }

  if (carregandoContas) return <Carregando />;

  if (contas.length === 0) {
    return (
      <Vazio
        titulo="Nenhuma conta conectada"
        descricao="Conecte pelo menos uma conta antes de criar conteúdo."
        acao={
          <Link href="/contas">
            <Botao variante="primaria">Conectar conta</Botao>
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Novo conteúdo</h1>
        <p className="mt-0.5 text-sm text-suave">
          Um conteúdo mestre, variações por rede e um destino por conta.
        </p>
      </header>

      {erro && <Aviso tom="erro">{erro}</Aviso>}

      {iaRevisao?.aiGenerated && iaRevisao.aiReviewedAt === null && (
        <Aviso tom="alerta" titulo="Revisão humana pendente">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>
              Este conteúdo foi gerado com ajuda da IA. Revise o texto e as variações e registre
              a revisão — sem isso, o agendamento e a publicação são bloqueados.
            </p>
            <Botao variante="primaria" onClick={() => void registrarRevisaoIa()} disabled={registrandoRevisao}>
              {registrandoRevisao ? 'Registrando…' : 'Registrar revisão humana'}
            </Botao>
          </div>
        </Aviso>
      )}

      {iaRevisao?.aiGenerated && iaRevisao.aiReviewedAt !== null && (
        <Aviso tom="sucesso">
          Conteúdo de IA revisado por um integrante da equipe. Se o texto ou as variações forem
          alterados, uma nova revisão será exigida.
        </Aviso>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr,380px]">
        <div className="space-y-6">
          {/* --- 1. Conteúdo mestre --- */}
          <Cartao
            titulo="1. Conteúdo mestre"
            descricao="O texto base. Cada rede pode ter a própria variação depois."
            acoes={
              <Botao
                variante="secundaria"
                onClick={() => setModalIaAberto(true)}
                className="flex items-center gap-1.5 text-xs py-1 px-2.5"
              >
                <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                Assistente de IA
              </Botao>
            }
          >
            <div className="space-y-4">
              <Campo
                rotulo="Título"
                value={titulo}
                onChange={(evento) => setTitulo(evento.target.value)}
                maxLength={300}
                dica="Obrigatório em algumas redes (YouTube, por exemplo)."
              />

              <AreaTexto
                rotulo="Legenda / descrição"
                value={corpo}
                onChange={(evento) => setCorpo(evento.target.value)}
                contador={corpo.length}
                rows={6}
              />

              <Campo
                rotulo="Hashtags"
                value={hashtags}
                onChange={(evento) => setHashtags(evento.target.value)}
                placeholder="curiosidades ciencia espaco"
                dica="Separe por espaço ou vírgula. O # é opcional."
              />

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="rotulo">Mídia</span>
                  <Botao variante="secundaria" onClick={() => setSeletorMidia(true)}>
                    Escolher da biblioteca
                  </Botao>
                </div>

                {midiasSelecionadas.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-borda px-3 py-6 text-center text-sm text-suave">
                    Nenhum arquivo selecionado.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {midiasSelecionadas.map((id) => {
                      const midia = midias.find((item) => item.id === id);
                      if (!midia) return null;

                      return (
                        <li
                          key={id}
                          className="flex items-center justify-between gap-3 rounded-lg border border-borda p-2"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            {midia.thumbnailUrl && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={midia.thumbnailUrl}
                                alt=""
                                className="h-10 w-16 rounded object-cover"
                              />
                            )}
                            <div className="min-w-0">
                              <p className="truncate text-sm">{midia.originalFilename}</p>
                              <p className="text-xs text-suave">
                                {midia.type === 'VIDEO' ? 'Vídeo' : 'Imagem'}
                                {midia.width && ` · ${midia.width}×${midia.height}`}
                                {midia.durationMs && ` · ${formatarDuracao(midia.durationMs)}`}
                                {midia.processingStatus !== 'READY' &&
                                  ` · ${traduzirProcessamento(midia.processingStatus)}`}
                              </p>
                            </div>
                          </div>

                          <Botao
                            variante="fantasma"
                            onClick={() =>
                              setMidiasSelecionadas((atual) =>
                                atual.filter((item) => item !== id),
                              )
                            }
                          >
                            Remover
                          </Botao>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </Cartao>

          {/* --- 2. Destinos --- */}
          <Cartao
            titulo="2. Destinos"
            descricao="Escolha por grupo, por conta, ou os dois. Um destino é criado por conta."
          >
            <div className="space-y-4">
              {grupos.length > 0 && (
                <div>
                  <p className="rotulo mb-2">Grupos</p>
                  <div className="flex flex-wrap gap-2">
                    {grupos.map((grupo) => {
                      const marcado = gruposSelecionados.includes(grupo.id);

                      return (
                        <button
                          key={grupo.id}
                          onClick={() =>
                            setGruposSelecionados((atual) =>
                              marcado
                                ? atual.filter((id) => id !== grupo.id)
                                : [...atual, grupo.id],
                            )
                          }
                          aria-pressed={marcado}
                          className={
                            marcado
                              ? 'rounded-lg border border-primaria bg-primaria px-3 py-1.5 text-sm text-primaria-texto'
                              : 'rounded-lg border border-borda px-3 py-1.5 text-sm hover:bg-fundo'
                          }
                        >
                          {grupo.name}
                          <span className="ml-1.5 opacity-70">{grupo.memberCount}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div>
                <p className="rotulo mb-2">Contas avulsas</p>
                <div className="max-h-60 space-y-1 overflow-y-auto rounded-lg border border-borda p-2">
                  {contas.map((conta) => {
                    const marcado = contasSelecionadas.includes(conta.id);

                    return (
                      <label
                        key={conta.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-fundo"
                      >
                        <input
                          type="checkbox"
                          checked={marcado}
                          onChange={() =>
                            setContasSelecionadas((atual) =>
                              marcado
                                ? atual.filter((id) => id !== conta.id)
                                : [...atual, conta.id],
                            )
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {conta.nickname}
                          <span className="ml-1.5 text-xs text-suave">
                            {conta.platformName}
                            {conta.remoteDisplayName && ` · ${conta.remoteDisplayName}`}
                          </span>
                        </span>
                        {conta.status !== 'ACTIVE' && <Etiqueta tom="erro">!</Etiqueta>}
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          </Cartao>

          {/* --- 3. Campos obrigatórios por rede --- */}
          {redesAlvo.length > 0 && (
            <CamposPorRede
              redesAlvo={redesAlvo}
              plataformas={plataformas}
              variacoes={variacoes}
              aoMudar={setVariacoes}
            />
          )}
        </div>

        {/* --- Coluna lateral: agendamento e preview --- */}
        <div className="space-y-6">
          <Cartao titulo="3. Quando publicar">
            <div className="space-y-4">
              <Selecao
                rotulo="Modo"
                value={modo}
                onChange={(evento) => setModo(evento.target.value as Modo)}
              >
                <option value="SPECIFIC_TIME">Horário específico</option>
                <option value="QUEUE_SLOT">Próximo slot livre da fila</option>
              </Selecao>

              {modo === 'SPECIFIC_TIME' ? (
                <>
                  <Campo
                    rotulo="Data e hora"
                    type="datetime-local"
                    value={dataHoraLocal}
                    onChange={(evento) => setDataHoraLocal(evento.target.value)}
                    dica="Interpretado no fuso de CADA conta de destino."
                  />
                  <Campo
                    rotulo="Anti-Spam / Intervalo entre contas (min)"
                    type="number"
                    min="0"
                    max="180"
                    value={espacamentoMinutos.toString()}
                    onChange={(evento) =>
                      setEspacamentoMinutos(Math.max(0, parseInt(evento.target.value, 10) || 0))
                    }
                    dica="Adiciona um espaçamento progressivo entre contas para evitar disparo simultâneo."
                  />
                </>
              ) : (
                <Aviso tom="info">
                  Cada conta entra no próximo horário livre da própria grade semanal. Contas sem
                  grade configurada aparecem no preview com o motivo.
                </Aviso>
              )}

              <Botao
                variante="primaria"
                className="w-full"
                carregando={processando}
                disabled={!temDestino || (!corpo && !titulo && midiasSelecionadas.length === 0)}
                onClick={() => void gerarPreview()}
              >
                Ver destinos e validar
              </Botao>

              {!temDestino && (
                <p className="text-center text-xs text-suave">
                  Selecione ao menos um grupo ou uma conta.
                </p>
              )}
            </div>
          </Cartao>

          {preview && (
            <PainelPreview
              preview={preview}
              processando={processando}
              aoAgendar={agendar}
            />
          )}
        </div>
      </div>

      {seletorMidia && (
        <Modal
          aberto
          aoFechar={() => setSeletorMidia(false)}
          titulo="Escolher da biblioteca"
          largura="lg"
        >
          {midias.length === 0 ? (
            <Vazio
              titulo="Biblioteca vazia"
              descricao="Envie arquivos na Biblioteca de mídia antes de compor."
              acao={
                <Link href="/biblioteca">
                  <Botao variante="primaria">Abrir biblioteca</Botao>
                </Link>
              }
            />
          ) : (
            <div className="grid max-h-[60vh] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3 md:grid-cols-4">
              {midias.map((midia) => {
                const marcado = midiasSelecionadas.includes(midia.id);

                return (
                  <button
                    key={midia.id}
                    onClick={() =>
                      setMidiasSelecionadas((atual) =>
                        marcado ? atual.filter((id) => id !== midia.id) : [...atual, midia.id],
                      )
                    }
                    aria-pressed={marcado}
                    className={
                      marcado
                        ? 'overflow-hidden rounded-lg border-2 border-primaria text-left'
                        : 'overflow-hidden rounded-lg border border-borda text-left hover:bg-fundo'
                    }
                  >
                    <div className="aspect-video bg-fundo">
                      {midia.thumbnailUrl || midia.type === 'IMAGE' ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={midia.thumbnailUrl ?? midia.url}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-2xl text-suave">
                          ▶
                        </div>
                      )}
                    </div>
                    <p className="truncate px-2 py-1.5 text-xs">{midia.originalFilename}</p>
                  </button>
                );
              })}
            </div>
          )}

          <div className="mt-4 flex justify-end">
            <Botao variante="primaria" onClick={() => setSeletorMidia(false)}>
              Concluir ({midiasSelecionadas.length})
            </Botao>
          </div>
        </Modal>
      )}

      {modalIaAberto && (
        <Modal
          aberto
          aoFechar={() => setModalIaAberto(false)}
          titulo="Assistente Criativo com IA ✨"
          largura="lg"
        >
          <div className="space-y-4">
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 text-xs text-texto leading-relaxed">
              <span className="font-semibold">Revisão humana obrigatória:</span> Todo conteúdo sugerido pela IA nasce como rascunho e exige validação de um integrante da equipe antes da publicação.
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Selecao
                rotulo="Tipo de geração"
                value={iaKind}
                onChange={(e) => setIaKind(e.target.value as typeof iaKind)}
              >
                <option value="CAPTION">Legenda completa</option>
                <option value="TITLE">Título atraente</option>
                <option value="HASHTAGS">Conjunto de hashtags</option>
                <option value="VARIATIONS">Variações criativas</option>
              </Selecao>

              <Selecao
                rotulo="Rede de destino"
                value={iaPlatform}
                onChange={(e) => setIaPlatform(e.target.value)}
              >
                <option value="INSTAGRAM">Instagram</option>
                <option value="TIKTOK">TikTok</option>
                <option value="YOUTUBE">YouTube</option>
                <option value="FACEBOOK">Facebook</option>
                <option value="THREADS">Threads</option>
                <option value="X">X (Twitter)</option>
                <option value="LINKEDIN">LinkedIn</option>
                <option value="PINTEREST">Pinterest</option>
              </Selecao>
            </div>

            <Campo
              rotulo="Tom de voz"
              value={iaTone}
              onChange={(e) => setIaTone(e.target.value)}
              placeholder="Ex.: profissional, persuasivo, bem-humorado, informativo"
            />

            <AreaTexto
              rotulo="Assunto / Briefing do post"
              value={iaBrief}
              onChange={(e) => setIaBrief(e.target.value)}
              placeholder="Ex.: Lançamento da nova funcionalidade de agendamento automático com anti-spam fan-out..."
              rows={3}
            />

            <div className="flex items-center justify-between pt-2">
              {iaProvider ? (
                <span className="text-xs text-suave">
                  Motor ativo: <span className="font-mono text-texto">{iaProvider}</span>
                </span>
              ) : (
                <span className="text-xs text-suave">Motor Universal Híbrido: Gemini, Claude ou Heurístico Local</span>
              )}
              <Botao
                variante="primaria"
                carregando={iaGerando}
                disabled={!iaBrief.trim()}
                onClick={() => void gerarSugestaoIa()}
                className="flex items-center gap-1.5"
              >
                <Wand2 className="h-4 w-4" />
                Gerar sugestões
              </Botao>
            </div>

            {iaSugestoes.length > 0 && (
              <div className="mt-4 space-y-3 border-t border-borda pt-4">
                <p className="text-xs font-semibold text-suave uppercase tracking-wide">
                  Opções geradas ({iaSugestoes.length})
                </p>
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {iaSugestoes.map((sugestao, idx) => (
                    <div
                      key={idx}
                      className="rounded-xl border border-borda bg-fundo p-3 transition hover:border-primaria/50"
                    >
                      <p className="whitespace-pre-wrap text-xs text-texto leading-relaxed">
                        {sugestao}
                      </p>
                      <div className="mt-3 flex items-center justify-end gap-2 border-t border-borda/60 pt-2">
                        <button
                          type="button"
                          onClick={() => copiarSugestao(sugestao, idx)}
                          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-suave hover:bg-superficie hover:text-texto transition"
                        >
                          {iaCopiado === idx ? (
                            <>
                              <Check className="h-3.5 w-3.5 text-sucesso" />
                              Copiado!
                            </>
                          ) : (
                            <>
                              <Copy className="h-3.5 w-3.5" />
                              Copiar
                            </>
                          )}
                        </button>
                        <Botao
                          variante="secundaria"
                          onClick={() => aplicarSugestao(sugestao)}
                          className="text-xs py-1 px-2.5"
                        >
                          Aplicar no post
                        </Botao>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Campos que a plataforma EXIGE, renderizados por rede.
 *
 * A SPEC seção 6.1 é explícita: selecionar um grupo não pode pular isto. Se o
 * grupo tem cinco contas do TikTok, os campos obrigatórios do TikTok
 * aparecem — e o agendamento é bloqueado enquanto não forem preenchidos.
 */
function CamposPorRede({
  redesAlvo,
  plataformas,
  variacoes,
  aoMudar,
}: {
  redesAlvo: string[];
  plataformas: Plataforma[];
  variacoes: Record<string, { title?: string; body?: string; platformFields?: Record<string, unknown> }>;
  aoMudar: (
    atualizar: (
      atual: Record<string, { title?: string; body?: string; platformFields?: Record<string, unknown> }>,
    ) => Record<string, { title?: string; body?: string; platformFields?: Record<string, unknown> }>,
  ) => void;
}) {
  const comCampos = plataformas.filter(
    (plataforma) =>
      redesAlvo.includes(plataforma.key) && plataforma.requiredUxFields.fields.length > 0,
  );

  if (comCampos.length === 0) return null;

  return (
    <Cartao
      titulo="Campos exigidos pelas redes"
      descricao="Sem eles a plataforma recusa a publicação — o agendamento fica bloqueado."
    >
      <div className="space-y-5">
        {comCampos.map((plataforma) => {
          const chave = plataforma.key;
          const campos = variacoes[chave]?.platformFields ?? {};

          const definir = (nome: string, valor: unknown) =>
            aoMudar((atual) => ({
              ...atual,
              [chave]: {
                ...atual[chave],
                platformFields: { ...(atual[chave]?.platformFields ?? {}), [nome]: valor },
              },
            }));

          return (
            <div key={chave} className="space-y-3 rounded-lg border border-borda p-3">
              <p className="text-sm font-medium">{plataforma.displayName}</p>

              {plataforma.requiredUxFields.fields.map((campo) => {
                if (campo.type === 'BOOLEAN') {
                  return (
                    <label key={campo.key} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={campos[campo.key] === true}
                        onChange={(evento) => definir(campo.key, evento.target.checked)}
                      />
                      <span>
                        {campo.label}
                        {campo.helpText && (
                          <span className="block text-xs text-suave">{campo.helpText}</span>
                        )}
                      </span>
                    </label>
                  );
                }

                if (campo.type === 'CONSENT') {
                  return (
                    <label key={campo.key} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={campos[campo.key] === true}
                        onChange={(evento) => definir(campo.key, evento.target.checked)}
                      />
                      <span>{campo.consentText ?? campo.label}</span>
                    </label>
                  );
                }

                if (campo.type === 'SELECT') {
                  return (
                    <Selecao
                      key={campo.key}
                      rotulo={campo.label}
                      value={String(campos[campo.key] ?? '')}
                      onChange={(evento) => definir(campo.key, evento.target.value)}
                      required={campo.required}
                      dica={
                        campo.optionsFromApi
                          ? // Opções que variam por conta/região vêm da API na
                            // conexão. Enquanto não vierem, o campo aceita o
                            // valor digitado — hardcodear a lista seria
                            // inventar comportamento de API.
                            `${campo.helpText ?? ''} As opções são carregadas da plataforma.`.trim()
                          : campo.helpText
                      }
                    >
                      <option value="">Selecione…</option>
                      {campo.options.map((opcao) => (
                        <option key={opcao.value} value={opcao.value}>
                          {opcao.label}
                        </option>
                      ))}
                    </Selecao>
                  );
                }

                return (
                  <Campo
                    key={campo.key}
                    rotulo={campo.label}
                    value={String(campos[campo.key] ?? '')}
                    onChange={(evento) => definir(campo.key, evento.target.value)}
                    required={campo.required}
                    dica={campo.helpText}
                  />
                );
              })}

              <details className="text-sm">
                <summary className="cursor-pointer text-suave hover:text-texto">
                  Variação do texto para {plataforma.displayName}
                </summary>
                <div className="mt-3 space-y-3">
                  <Campo
                    rotulo="Título específico"
                    value={variacoes[chave]?.title ?? ''}
                    onChange={(evento) =>
                      aoMudar((atual) => ({
                        ...atual,
                        [chave]: { ...atual[chave], title: evento.target.value },
                      }))
                    }
                    maxLength={plataforma.mediaRequirements.maxTitleLength ?? 300}
                    dica="Vazio usa o título do conteúdo mestre."
                  />
                  <AreaTexto
                    rotulo="Legenda específica"
                    value={variacoes[chave]?.body ?? ''}
                    onChange={(evento) =>
                      aoMudar((atual) => ({
                        ...atual,
                        [chave]: { ...atual[chave], body: evento.target.value },
                      }))
                    }
                    contador={(variacoes[chave]?.body ?? '').length}
                    {...(plataforma.mediaRequirements.maxCaptionLength
                      ? { limite: plataforma.mediaRequirements.maxCaptionLength }
                      : {})}
                    rows={4}
                    dica="Vazio usa a legenda do conteúdo mestre."
                  />
                </div>
              </details>
            </div>
          );
        })}
      </div>
    </Cartao>
  );
}

/** Lista resolvida de destinos com a validação de cada um. */
function PainelPreview({
  preview,
  processando,
  aoAgendar,
}: {
  preview: Preview;
  processando: boolean;
  aoAgendar: (parcial: boolean) => Promise<void>;
}) {
  return (
    <Cartao
      titulo="4. Destinos resolvidos"
      descricao={`${preview.summary.total} destino(s) · ${preview.summary.schedulable} podem ser agendados`}
    >
      <div className="space-y-3">
        {preview.timezoneDiverges && (
          <Aviso tom="info">
            As contas estão em fusos diferentes, então o mesmo horário cai em instantes
            diferentes. Confira a hora de cada uma abaixo.
          </Aviso>
        )}

        {preview.excluded.length > 0 && (
          <Aviso tom="alerta" titulo="Contas fora da seleção">
            <ul className="space-y-1">
              {preview.excluded.map((excluida) => (
                <li key={excluida.accountId}>
                  <strong>{excluida.nickname}</strong>: {excluida.reason}
                </li>
              ))}
            </ul>
          </Aviso>
        )}

        <ul className="max-h-[420px] space-y-2 overflow-y-auto">
          {preview.targets.map((destino) => {
            const erros = destino.issues.filter((problema) => problema.severity === 'ERROR');
            const avisos = destino.issues.filter((problema) => problema.severity === 'WARNING');

            return (
              <li
                key={destino.accountId}
                className={
                  destino.canSchedule
                    ? 'rounded-lg border border-borda p-2.5'
                    : 'rounded-lg border border-erro/40 bg-erro/5 p-2.5'
                }
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{destino.nickname}</p>
                    {/* Nome real do perfil: exigência da SPEC 6.1 */}
                    <p className="truncate text-xs text-suave">
                      {destino.remoteDisplayName ?? destino.platformName} · {destino.platformName}
                    </p>
                  </div>
                  <Etiqueta tom={destino.canSchedule ? 'sucesso' : 'erro'}>
                    {destino.canSchedule ? 'OK' : 'Bloqueado'}
                  </Etiqueta>
                </div>

                {destino.scheduledAtLocal && (
                  <p className="mt-1 text-xs text-suave">{destino.scheduledAtLocal}</p>
                )}

                {erros.length > 0 && (
                  <ul className="mt-1.5 space-y-1">
                    {erros.map((problema, indice) => (
                      <li key={indice} className="text-xs text-erro">
                        {problema.message}
                      </li>
                    ))}
                  </ul>
                )}

                {avisos.length > 0 && (
                  <ul className="mt-1.5 space-y-1">
                    {avisos.map((problema, indice) => (
                      <li key={indice} className="text-xs text-alerta">
                        {problema.message}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>

        {preview.summary.schedulable === 0 ? (
          <Aviso tom="erro">
            Nenhum destino pode ser agendado. Corrija os problemas acima.
          </Aviso>
        ) : preview.summary.blocked > 0 ? (
          <div className="space-y-2">
            <Aviso tom="alerta">
              {preview.summary.blocked} de {preview.summary.total} destino(s) estão bloqueados.
              Você pode agendar só os válidos.
            </Aviso>
            <Botao
              variante="primaria"
              className="w-full"
              carregando={processando}
              onClick={() => void aoAgendar(true)}
            >
              Agendar {preview.summary.schedulable} destino(s) válidos
            </Botao>
          </div>
        ) : (
          <Botao
            variante="primaria"
            className="w-full"
            carregando={processando}
            onClick={() => void aoAgendar(false)}
          >
            Agendar {preview.summary.total} destino(s)
          </Botao>
        )}
      </div>
    </Cartao>
  );
}

// ---------------------------------------------------------------------------

function proximaHoraCheia(): string {
  const data = new Date();
  data.setMinutes(0, 0, 0);
  data.setHours(data.getHours() + 2);

  const parte = (valor: number) => String(valor).padStart(2, '0');
  return `${data.getFullYear()}-${parte(data.getMonth() + 1)}-${parte(data.getDate())}T${parte(data.getHours())}:${parte(data.getMinutes())}`;
}

function formatarDuracao(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutos = Math.floor(total / 60);
  const segundos = total % 60;
  return `${minutos}:${String(segundos).padStart(2, '0')}`;
}

function traduzirProcessamento(status: string): string {
  const mapa: Record<string, string> = {
    PENDING: 'aguardando processamento',
    PROCESSING: 'processando',
    FAILED: 'falha no processamento',
  };
  return mapa[status] ?? status;
}
