'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import {
  Aviso,
  Botao,
  Campo,
  Cartao,
  Carregando,
  Etiqueta,
  EtiquetaStatus,
  Modal,
  Selecao,
  Vazio,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApi, useSessao } from '@/lib/sessao';

/**
 * Fila de publicação (SPEC seção 7).
 *
 * A tela mostra o estado de CADA DESTINO, não só o status agregado do post.
 * É a diferença entre "falhou" e "falhou em 3 das 20 contas, e são estas" —
 * e é o que torna possível reprocessar só as que falharam.
 */

interface Destino {
  id: string;
  accountId: string;
  accountNickname: string;
  remoteDisplayName: string | null;
  platform: string;
  platformName: string;
  status: string;
  scheduledAtLocal: string | null;
  timezone: string;
  attempts: number;
  maxAttempts: number;
  remoteUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorPermanent: boolean;
  publishedAt: string | null;
  issues: Array<{ code: string; severity: string; message: string }>;
}

interface Publicacao {
  id: string;
  status: string;
  scheduleMode: string;
  intendedScheduledAt: string | null;
  createdAt: string;
  clientName: string | null;
  campaignName: string | null;
  content: { id: string; title: string | null; body: string; mediaCount: number };
  targets: Destino[];
  counts: { total: number; published: number; failed: number; pending: number; cancelled: number };
}

export default function PaginaFila() {
  return (
    <Suspense fallback={<Carregando />}>
      <Conteudo />
    </Suspense>
  );
}

function Conteudo() {
  const parametros = useSearchParams();
  const { pode } = useSessao();

  const [status, setStatus] = useState('');
  const [grupoId, setGrupoId] = useState('');
  const [contaId, setContaId] = useState('');
  const [mensagem, setMensagem] = useState<{ tom: 'sucesso' | 'erro'; texto: string } | null>(
    null,
  );

  const postDestacado = parametros.get('post');

  const consulta = new URLSearchParams({ limit: '50' });
  if (status) consulta.set('status', status);
  if (grupoId) consulta.set('groupId', grupoId);
  if (contaId) consulta.set('accountId', contaId);

  const { dados, carregando, recarregar } = useApi<{ posts: Publicacao[]; total: number }>(
    `/v1/posts?${consulta.toString()}`,
    { refreshInterval: 30_000 },
  );

  const { dados: grupos } = useApi<{ groups: Array<{ id: string; name: string }> }>('/v1/groups');
  const { dados: contas } = useApi<{ accounts: Array<{ id: string; nickname: string }> }>(
    '/v1/accounts',
  );

  if (carregando) return <Carregando />;

  const publicacoes = dados?.posts ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Fila de publicação</h1>
          <p className="mt-0.5 text-sm text-suave">
            Estado de cada destino. Horários no fuso da conta de destino.
          </p>
        </div>
      </header>

      {mensagem && <Aviso tom={mensagem.tom}>{mensagem.texto}</Aviso>}

      <Cartao>
        <div className="grid gap-3 sm:grid-cols-3">
          <Selecao
            rotulo="Status"
            value={status}
            onChange={(evento) => setStatus(evento.target.value)}
          >
            <option value="">Todos</option>
            <option value="SCHEDULED">Agendados</option>
            <option value="PUBLISHING">Publicando</option>
            <option value="PUBLISHED">Publicados</option>
            <option value="PARTIALLY_PUBLISHED">Publicados em parte</option>
            <option value="FAILED">Com falha</option>
            <option value="DRAFT">Rascunhos</option>
            <option value="IN_REVIEW">Em revisão</option>
            <option value="CANCELLED">Cancelados</option>
          </Selecao>

          <Selecao
            rotulo="Grupo"
            value={grupoId}
            onChange={(evento) => setGrupoId(evento.target.value)}
          >
            <option value="">Todos os grupos</option>
            {(grupos?.groups ?? []).map((grupo) => (
              <option key={grupo.id} value={grupo.id}>
                {grupo.name}
              </option>
            ))}
          </Selecao>

          <Selecao
            rotulo="Conta"
            value={contaId}
            onChange={(evento) => setContaId(evento.target.value)}
          >
            <option value="">Todas as contas</option>
            {(contas?.accounts ?? []).map((conta) => (
              <option key={conta.id} value={conta.id}>
                {conta.nickname}
              </option>
            ))}
          </Selecao>
        </div>
      </Cartao>

      {publicacoes.length === 0 ? (
        <Vazio
          titulo="Nada na fila"
          descricao="Publicações agendadas e publicadas aparecem aqui, com o estado de cada conta."
        />
      ) : (
        <div className="space-y-4">
          {publicacoes.map((publicacao) => (
            <CartaoPublicacao
              key={publicacao.id}
              publicacao={publicacao}
              destacado={publicacao.id === postDestacado}
              podeAgir={pode('post:retry')}
              podeCancelar={pode('post:cancel')}
              podeDuplicar={pode('post:create')}
              aoMudar={() => void recarregar()}
              aoAvisar={setMensagem}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function CartaoPublicacao({
  publicacao,
  destacado,
  podeAgir,
  podeCancelar,
  podeDuplicar,
  aoMudar,
  aoAvisar,
}: {
  publicacao: Publicacao;
  destacado: boolean;
  podeAgir: boolean;
  podeCancelar: boolean;
  podeDuplicar: boolean;
  aoMudar: () => void;
  aoAvisar: (mensagem: { tom: 'sucesso' | 'erro'; texto: string }) => void;
}) {
  const [expandido, setExpandido] = useState(destacado || publicacao.counts.failed > 0);
  const [processando, setProcessando] = useState(false);
  const [duplicando, setDuplicando] = useState(false);
  const [novaData, setNovaData] = useState('');

  /**
   * Reaproveita a publicação numa nova data, nas MESMAS contas.
   *
   * O horário é local e vale no fuso de cada conta de destino — é o mesmo
   * contrato do compositor, e é por isso que o campo não tem fuso: "10h" quer
   * dizer 10h para cada conta, não um instante único.
   */
  async function duplicar() {
    setProcessando(true);

    try {
      const resultado = await api<{ postId: string; scheduled: number; skipped: number }>(
        `/v1/posts/${publicacao.id}/duplicate`,
        {
          method: 'POST',
          body: novaData
            ? {
                schedule: {
                  mode: 'SPECIFIC_TIME',
                  // Alguns navegadores acrescentam segundos ao datetime-local;
                  // a API aceita exatamente AAAA-MM-DDTHH:MM.
                  localDateTime: novaData.slice(0, 16),
                },
              }
            : {},
        },
      );

      setDuplicando(false);
      setNovaData('');

      aoAvisar({
        tom: 'sucesso',
        texto: novaData
          ? `Publicação duplicada para ${resultado.scheduled} destino(s) na nova data.`
          : 'Publicação duplicada como rascunho. Agende quando quiser.',
      });

      aoMudar();
    } catch (caught) {
      aoAvisar({
        tom: 'erro',
        texto:
          caught instanceof ApiError ? caught.message : 'Não foi possível duplicar a publicação.',
      });
    } finally {
      setProcessando(false);
    }
  }

  async function executar(acao: 'retry' | 'cancel') {
    setProcessando(true);

    try {
      if (acao === 'retry') {
        const resultado = await api<{ retried: number }>(
          `/v1/posts/${publicacao.id}/retry`,
          { method: 'POST', body: {} },
        );
        aoAvisar({
          tom: 'sucesso',
          texto: `${resultado.retried} destino(s) reenfileirado(s). As contas já publicadas não foram tocadas.`,
        });
      } else {
        const resultado = await api<{ cancelled: number }>(
          `/v1/posts/${publicacao.id}/cancel`,
          { method: 'POST', body: {} },
        );
        aoAvisar({
          tom: 'sucesso',
          texto: `${resultado.cancelled} destino(s) cancelado(s).`,
        });
      }

      aoMudar();
    } catch (caught) {
      aoAvisar({
        tom: 'erro',
        texto: caught instanceof ApiError ? caught.message : 'Não foi possível concluir a ação.',
      });
    } finally {
      setProcessando(false);
    }
  }

  return (
    <section
      className={
        destacado ? 'cartao ring-2 ring-primaria' : 'cartao'
      }
      id={publicacao.id}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-borda px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-sm font-semibold">
              {publicacao.content.title || publicacao.content.body.slice(0, 60) || 'Sem título'}
            </h2>
            <EtiquetaStatus status={publicacao.status} />
          </div>

          <p className="mt-0.5 text-xs text-suave">
            {publicacao.counts.total} destino(s)
            {publicacao.counts.published > 0 && ` · ${publicacao.counts.published} publicado(s)`}
            {publicacao.counts.failed > 0 && ` · ${publicacao.counts.failed} com falha`}
            {publicacao.counts.pending > 0 && ` · ${publicacao.counts.pending} pendente(s)`}
            {publicacao.clientName && ` · ${publicacao.clientName}`}
            {publicacao.campaignName && ` · ${publicacao.campaignName}`}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {podeAgir && publicacao.counts.failed > 0 && (
            <Botao
              variante="primaria"
              carregando={processando}
              onClick={() => void executar('retry')}
            >
              Tentar novamente ({publicacao.counts.failed})
            </Botao>
          )}
          {podeCancelar && publicacao.counts.pending > 0 && (
            <Botao
              variante="secundaria"
              carregando={processando}
              onClick={() => void executar('cancel')}
            >
              Cancelar pendentes
            </Botao>
          )}
          {podeDuplicar && (
            <Botao variante="secundaria" onClick={() => setDuplicando(true)}>
              Duplicar
            </Botao>
          )}
          <Botao variante="fantasma" onClick={() => setExpandido((atual) => !atual)}>
            {expandido ? 'Ocultar' : 'Ver destinos'}
          </Botao>
        </div>
      </header>

      <Modal
        aberto={duplicando}
        aoFechar={() => setDuplicando(false)}
        titulo="Duplicar publicação"
        largura="sm"
      >
        <div className="space-y-4">
          <p className="text-xs text-suave">
            Cria uma publicação nova com uma cópia do conteúdo, nas mesmas{' '}
            {publicacao.counts.total} conta(s) desta. Editar a cópia não altera o texto da
            original. Se algum grupo mudou depois, a cópia continua com as contas de agora —
            a composição nova só entra se você escolher os destinos no compositor.
          </p>

          <Campo
            rotulo="Nova data e hora"
            type="datetime-local"
            value={novaData}
            onChange={(evento) => setNovaData(evento.target.value)}
            dica="Horário local de cada conta de destino. Em branco, a cópia fica como rascunho."
          />

          <div className="flex justify-end gap-2">
            <Botao variante="fantasma" onClick={() => setDuplicando(false)}>
              Cancelar
            </Botao>
            <Botao variante="primaria" carregando={processando} onClick={() => void duplicar()}>
              Duplicar
            </Botao>
          </div>
        </div>
      </Modal>

      {expandido && (
        <div className="p-4">
          <div className="rolagem-horizontal">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Conta</th>
                  <th>Rede</th>
                  <th>Status</th>
                  <th>Horário (fuso da conta)</th>
                  <th>Tentativas</th>
                  <th>Resultado</th>
                </tr>
              </thead>
              <tbody>
                {publicacao.targets.map((destino) => (
                  <tr key={destino.id}>
                    <td>
                      <p className="font-medium">{destino.accountNickname}</p>
                      {destino.remoteDisplayName && (
                        <p className="text-xs text-suave">{destino.remoteDisplayName}</p>
                      )}
                    </td>
                    <td className="text-suave">{destino.platformName}</td>
                    <td>
                      <EtiquetaStatus status={destino.status} />
                    </td>
                    <td className="text-xs text-suave">{destino.scheduledAtLocal ?? '—'}</td>
                    <td className="tabular-nums text-xs text-suave">
                      {destino.attempts}/{destino.maxAttempts}
                    </td>
                    <td>
                      {destino.remoteUrl ? (
                        <a
                          href={destino.remoteUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-xs underline"
                        >
                          Ver publicação
                        </a>
                      ) : destino.errorMessage ? (
                        <div>
                          <p className="text-xs text-erro">{destino.errorMessage}</p>
                          {destino.errorPermanent && (
                            <Etiqueta tom="erro" titulo="Re-tentar não resolve sem uma ação sua">
                              Erro definitivo
                            </Etiqueta>
                          )}
                        </div>
                      ) : destino.issues.length > 0 ? (
                        <ul className="space-y-0.5">
                          {destino.issues.slice(0, 2).map((problema, indice) => (
                            <li
                              key={indice}
                              className={
                                problema.severity === 'ERROR'
                                  ? 'text-xs text-erro'
                                  : 'text-xs text-alerta'
                              }
                            >
                              {problema.message}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-xs text-suave">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
