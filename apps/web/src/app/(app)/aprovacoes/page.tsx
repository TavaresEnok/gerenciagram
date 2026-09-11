'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  AreaTexto,
  Aviso,
  Botao,
  Cartao,
  Carregando,
  EtiquetaStatus,
  Selecao,
  Vazio,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApi, useSessao } from '@/lib/sessao';

/**
 * Fila de aprovação (SPEC seção 6).
 *
 * Aprovar aqui LIBERA a publicação para ser agendada — não publica. Quando
 * publicar continua sendo decisão de quem tem a permissão de agendamento.
 * Rejeitar cancela os agendamentos pendentes, senão o conteúdo rejeitado
 * sairia mesmo assim no horário marcado.
 */

interface Comentario {
  id: string;
  body: string;
  authorName: string | null;
  createdAt: string;
}

interface Aprovacao {
  id: string;
  postId: string;
  status: string;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  createdAt: string;
  post: {
    id: string;
    status: string;
    contentTitle: string | null;
    contentBody: string;
    targetCount: number;
    intendedScheduledAt: string | null;
  };
  comments: Comentario[];
}

export default function PaginaAprovacoes() {
  const { pode } = useSessao();
  const [status, setStatus] = useState('PENDING');
  const [mensagem, setMensagem] = useState<{ tom: 'sucesso' | 'erro'; texto: string } | null>(
    null,
  );

  const { dados, carregando, recarregar } = useApi<{ approvals: Aprovacao[]; total: number }>(
    `/v1/approvals?status=${status}&limit=50`,
  );

  if (carregando) return <Carregando />;

  const aprovacoes = dados?.approvals ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Aprovações</h1>
          <p className="mt-0.5 text-sm text-suave">
            Aprovar libera a publicação para agendamento — não publica.
          </p>
        </div>

        <Selecao
          rotulo="Status"
          value={status}
          onChange={(evento) => setStatus(evento.target.value)}
          className="py-1.5"
        >
          <option value="PENDING">Pendentes</option>
          <option value="APPROVED">Aprovadas</option>
          <option value="CHANGES_REQUESTED">Com alterações pedidas</option>
          <option value="REJECTED">Rejeitadas</option>
        </Selecao>
      </header>

      {mensagem && <Aviso tom={mensagem.tom}>{mensagem.texto}</Aviso>}

      {aprovacoes.length === 0 ? (
        <Vazio
          titulo="Nada por aqui"
          descricao="Conteúdos enviados para revisão aparecem nesta fila."
        />
      ) : (
        <div className="space-y-4">
          {aprovacoes.map((aprovacao) => (
            <CartaoAprovacao
              key={aprovacao.id}
              aprovacao={aprovacao}
              podeDecidir={pode('approval:decide')}
              podeComentar={pode('approval:comment')}
              aoMudar={() => void recarregar()}
              aoAvisar={setMensagem}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CartaoAprovacao({
  aprovacao,
  podeDecidir,
  podeComentar,
  aoMudar,
  aoAvisar,
}: {
  aprovacao: Aprovacao;
  podeDecidir: boolean;
  podeComentar: boolean;
  aoMudar: () => void;
  aoAvisar: (mensagem: { tom: 'sucesso' | 'erro'; texto: string }) => void;
}) {
  const [nota, setNota] = useState('');
  const [comentario, setComentario] = useState('');
  const [processando, setProcessando] = useState(false);

  async function decidir(decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED') {
    setProcessando(true);

    try {
      await api(`/v1/approvals/${aprovacao.id}/decide`, {
        method: 'POST',
        body: { decision, note: nota || undefined },
      });

      const textos: Record<string, string> = {
        APPROVED: 'Publicação aprovada. Ela já pode ser agendada.',
        REJECTED: 'Publicação rejeitada. Os agendamentos pendentes foram cancelados.',
        CHANGES_REQUESTED: 'Alterações solicitadas. A publicação voltou para rascunho.',
      };

      aoAvisar({ tom: 'sucesso', texto: textos[decision] ?? 'Decisão registrada.' });
      setNota('');
      aoMudar();
    } catch (caught) {
      aoAvisar({
        tom: 'erro',
        texto: caught instanceof ApiError ? caught.message : 'Não foi possível decidir.',
      });
    } finally {
      setProcessando(false);
    }
  }

  async function comentar() {
    if (!comentario.trim()) return;
    setProcessando(true);

    try {
      await api(`/v1/approvals/${aprovacao.id}/comments`, {
        method: 'POST',
        body: { body: comentario },
      });
      setComentario('');
      aoMudar();
    } catch (caught) {
      aoAvisar({
        tom: 'erro',
        texto: caught instanceof ApiError ? caught.message : 'Não foi possível comentar.',
      });
    } finally {
      setProcessando(false);
    }
  }

  return (
    <Cartao
      titulo={aprovacao.post.contentTitle || aprovacao.post.contentBody.slice(0, 60) || 'Sem título'}
      descricao={`${aprovacao.post.targetCount} destino(s)`}
      acoes={<EtiquetaStatus status={aprovacao.status} />}
    >
      <div className="space-y-4">
        <p className="whitespace-pre-wrap text-sm text-suave">
          {aprovacao.post.contentBody.slice(0, 600)}
        </p>

        <Link href={`/fila?post=${aprovacao.postId}`} className="inline-block">
          <Botao variante="fantasma">Ver destinos na fila</Botao>
        </Link>

        {/* Comentários internos — nunca vão para a rede social. */}
        {aprovacao.comments.length > 0 && (
          <div className="space-y-2 rounded-lg border border-borda p-3">
            <p className="text-xs font-medium text-suave">Comentários internos</p>
            <ul className="space-y-2">
              {aprovacao.comments.map((item) => (
                <li key={item.id} className="text-sm">
                  <p className="text-xs text-suave">
                    {item.authorName ?? 'Alguém'} ·{' '}
                    {new Date(item.createdAt).toLocaleString('pt-BR')}
                  </p>
                  <p className="whitespace-pre-wrap">{item.body}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {aprovacao.status === 'PENDING' && podeDecidir && (
          <div className="space-y-3 border-t border-borda pt-4">
            <AreaTexto
              rotulo="Observação da decisão"
              value={nota}
              onChange={(evento) => setNota(evento.target.value)}
              rows={2}
              dica="Aparece no histórico e nos comentários internos."
            />

            <div className="flex flex-wrap gap-2">
              <Botao
                variante="primaria"
                carregando={processando}
                onClick={() => void decidir('APPROVED')}
              >
                Aprovar
              </Botao>
              <Botao
                variante="secundaria"
                carregando={processando}
                onClick={() => void decidir('CHANGES_REQUESTED')}
              >
                Pedir alterações
              </Botao>
              <Botao
                variante="perigo"
                carregando={processando}
                onClick={() => void decidir('REJECTED')}
              >
                Rejeitar
              </Botao>
            </div>
          </div>
        )}

        {podeComentar && (
          <div className="flex gap-2 border-t border-borda pt-4">
            <input
              className="campo"
              value={comentario}
              onChange={(evento) => setComentario(evento.target.value)}
              placeholder="Comentário interno..."
              aria-label="Comentário interno"
            />
            <Botao variante="secundaria" carregando={processando} onClick={() => void comentar()}>
              Enviar
            </Botao>
          </div>
        )}

        {aprovacao.decidedAt && (
          <p className="text-xs text-suave">
            Decidido por {aprovacao.decidedByName ?? 'alguém'} em{' '}
            {new Date(aprovacao.decidedAt).toLocaleString('pt-BR')}
            {aprovacao.decisionNote && ` — "${aprovacao.decisionNote}"`}
          </p>
        )}
      </div>
    </Cartao>
  );
}
