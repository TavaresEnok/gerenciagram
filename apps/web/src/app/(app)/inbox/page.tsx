'use client';

import { DateTime } from 'luxon';
import { useState } from 'react';
import { Aviso, Botao, Cartao, Carregando, Etiqueta, Selecao, Vazio } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApi, useSessao } from '@/lib/sessao';

/**
 * Inbox (SPEC seção 6).
 *
 * A ressalva "quando a API permitir" aparece na tela, não só na documentação:
 * redes conectadas que não expõem comentários por API oficial são listadas
 * explicitamente, para a ausência não parecer bug.
 */

interface Item {
  id: string;
  platform: string;
  platformName: string;
  type: string;
  accountId: string;
  accountNickname: string;
  authorUsername: string | null;
  body: string;
  postedAt: string;
  isRead: boolean;
  isReplied: boolean;
  replyBody: string | null;
}

export default function PaginaInbox() {
  const { pode } = useSessao();

  const [contaId, setContaId] = useState('');
  const [apenasNaoLidos, setApenasNaoLidos] = useState(false);
  const [respondendo, setRespondendo] = useState<string | null>(null);
  const [resposta, setResposta] = useState('');
  const [mensagem, setMensagem] = useState<{ tom: 'sucesso' | 'erro'; texto: string } | null>(
    null,
  );

  const consulta = new URLSearchParams({ limit: '50' });
  if (contaId) consulta.set('accountId', contaId);
  if (apenasNaoLidos) consulta.set('unreadOnly', 'true');

  const { dados, carregando, recarregar } = useApi<{
    items: Item[];
    total: number;
    unsupportedPlatforms: Array<{ platform: string; reason: string }>;
  }>(`/v1/inbox?${consulta.toString()}`);

  const { dados: contas } = useApi<{ accounts: Array<{ id: string; nickname: string }> }>(
    '/v1/accounts',
  );

  async function responder(itemId: string) {
    if (!resposta.trim()) return;

    try {
      await api(`/v1/inbox/${itemId}/reply`, { method: 'POST', body: { body: resposta } });
      setMensagem({ tom: 'sucesso', texto: 'Resposta publicada na plataforma.' });
      setRespondendo(null);
      setResposta('');
      void recarregar();
    } catch (caught) {
      setMensagem({
        tom: 'erro',
        texto: caught instanceof ApiError ? caught.message : 'Não foi possível responder.',
      });
    }
  }

  async function marcarLido(itemId: string) {
    await api(`/v1/inbox/${itemId}/read`, { method: 'POST' }).catch(() => undefined);
    void recarregar();
  }

  if (carregando) return <Carregando />;

  const itens = dados?.items ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Inbox</h1>
          <p className="mt-0.5 text-sm text-suave">
            Comentários e menções das contas conectadas, quando a rede expõe por API oficial.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <Selecao
            rotulo="Conta"
            value={contaId}
            onChange={(evento) => setContaId(evento.target.value)}
            className="py-1.5"
          >
            <option value="">Todas</option>
            {(contas?.accounts ?? []).map((conta) => (
              <option key={conta.id} value={conta.id}>
                {conta.nickname}
              </option>
            ))}
          </Selecao>

          <label className="flex items-center gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              checked={apenasNaoLidos}
              onChange={(evento) => setApenasNaoLidos(evento.target.checked)}
            />
            Só não lidos
          </label>
        </div>
      </header>

      {mensagem && <Aviso tom={mensagem.tom}>{mensagem.texto}</Aviso>}

      {(dados?.unsupportedPlatforms.length ?? 0) > 0 && (
        <Aviso tom="info" titulo="Redes sem inbox por API oficial">
          <ul className="space-y-1">
            {dados?.unsupportedPlatforms.map((rede) => (
              <li key={rede.platform}>{rede.reason}</li>
            ))}
          </ul>
        </Aviso>
      )}

      {itens.length === 0 ? (
        <Vazio
          titulo="Caixa vazia"
          descricao="Comentários das suas publicações aparecem aqui após a sincronização."
        />
      ) : (
        <div className="space-y-3">
          {itens.map((item) => (
            <Cartao key={item.id}>
              <div className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {item.authorUsername ?? 'Autor desconhecido'}
                      {!item.isRead && (
                        <span className="ml-2">
                          <Etiqueta tom="info">Novo</Etiqueta>
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-suave">
                      {item.accountNickname} · {item.platformName} ·{' '}
                      {DateTime.fromISO(item.postedAt).toFormat('dd/MM/yyyy HH:mm')}
                    </p>
                  </div>

                  <div className="flex gap-2">
                    {!item.isRead && (
                      <Botao variante="fantasma" onClick={() => void marcarLido(item.id)}>
                        Marcar como lido
                      </Botao>
                    )}
                    {pode('inbox:reply') && !item.isReplied && (
                      <Botao
                        variante="secundaria"
                        onClick={() => {
                          setRespondendo(item.id);
                          setResposta('');
                        }}
                      >
                        Responder
                      </Botao>
                    )}
                  </div>
                </div>

                <p className="whitespace-pre-wrap text-sm">{item.body}</p>

                {item.isReplied && item.replyBody && (
                  <div className="rounded-lg border border-borda bg-fundo p-2.5">
                    <p className="text-xs font-medium text-suave">Sua resposta</p>
                    <p className="mt-0.5 whitespace-pre-wrap text-sm">{item.replyBody}</p>
                  </div>
                )}

                {respondendo === item.id && (
                  <div className="flex gap-2">
                    <input
                      className="campo"
                      value={resposta}
                      onChange={(evento) => setResposta(evento.target.value)}
                      placeholder="Sua resposta..."
                      aria-label="Resposta"
                      autoFocus
                    />
                    <Botao variante="primaria" onClick={() => void responder(item.id)}>
                      Publicar
                    </Botao>
                    <Botao variante="fantasma" onClick={() => setRespondendo(null)}>
                      Cancelar
                    </Botao>
                  </div>
                )}
              </div>
            </Cartao>
          ))}
        </div>
      )}
    </div>
  );
}
