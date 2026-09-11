'use client';

import { useState } from 'react';
import { Aviso, Botao, Campo, Cartao, Carregando, Modal, Vazio } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApi, useSessao } from '@/lib/sessao';

interface Campanha {
  id: string;
  name: string;
  description: string | null;
  startsAt: string | null;
  endsAt: string | null;
  goal: string | null;
  clientName: string | null;
  postCount: number;
}

interface Metricas {
  posts: { total: number; published: number; failed: number; pending: number };
  totals: Record<string, number>;
  byPlatform: Record<string, Record<string, number>>;
  unavailableMetrics: string[];
}

export default function PaginaCampanhas() {
  const { pode } = useSessao();
  const { dados, carregando, recarregar } = useApi<{ campaigns: Campanha[] }>('/v1/campaigns');

  const [criando, setCriando] = useState(false);
  const [detalhe, setDetalhe] = useState<Campanha | null>(null);

  if (carregando) return <Carregando />;

  const campanhas = dados?.campaigns ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Campanhas</h1>
          <p className="mt-0.5 text-sm text-suave">
            Agrupam publicações e consolidam as métricas delas.
          </p>
        </div>
        {pode('campaign:create') && (
          <Botao variante="primaria" onClick={() => setCriando(true)}>
            Nova campanha
          </Botao>
        )}
      </header>

      {campanhas.length === 0 ? (
        <Vazio
          titulo="Nenhuma campanha"
          descricao="Crie uma campanha para acompanhar o desempenho de um conjunto de publicações."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {campanhas.map((campanha) => (
            <Cartao
              key={campanha.id}
              titulo={campanha.name}
              descricao={`${campanha.postCount} publicação(ões)${campanha.clientName ? ` · ${campanha.clientName}` : ''}`}
              acoes={
                <Botao variante="secundaria" onClick={() => setDetalhe(campanha)}>
                  Métricas
                </Botao>
              }
            >
              {campanha.description && (
                <p className="text-sm text-suave">{campanha.description}</p>
              )}
              {campanha.goal && (
                <p className="mt-2 text-xs text-suave">
                  <strong>Objetivo:</strong> {campanha.goal}
                </p>
              )}
              {(campanha.startsAt || campanha.endsAt) && (
                <p className="mt-2 text-xs text-suave">
                  {campanha.startsAt && new Date(campanha.startsAt).toLocaleDateString('pt-BR')}
                  {' – '}
                  {campanha.endsAt
                    ? new Date(campanha.endsAt).toLocaleDateString('pt-BR')
                    : 'em aberto'}
                </p>
              )}
            </Cartao>
          ))}
        </div>
      )}

      {criando && (
        <ModalCampanha
          aoFechar={() => setCriando(false)}
          aoSalvar={() => {
            setCriando(false);
            void recarregar();
          }}
        />
      )}

      {detalhe && <ModalMetricas campanha={detalhe} aoFechar={() => setDetalhe(null)} />}
    </div>
  );
}

function ModalCampanha({ aoFechar, aoSalvar }: { aoFechar: () => void; aoSalvar: () => void }) {
  const { dados: clientes } = useApi<{ clients: Array<{ id: string; name: string }> }>(
    '/v1/clients',
  );

  const [nome, setNome] = useState('');
  const [descricao, setDescricao] = useState('');
  const [objetivo, setObjetivo] = useState('');
  const [clienteId, setClienteId] = useState('');
  const [inicio, setInicio] = useState('');
  const [fim, setFim] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function criar(evento: React.FormEvent) {
    evento.preventDefault();
    setErro(null);
    setEnviando(true);

    try {
      await api('/v1/campaigns', {
        method: 'POST',
        body: {
          name: nome,
          description: descricao || undefined,
          goal: objetivo || undefined,
          clientId: clienteId || undefined,
          startsAt: inicio || undefined,
          endsAt: fim || undefined,
        },
      });
      aoSalvar();
    } catch (caught) {
      setErro(caught instanceof ApiError ? caught.message : 'Não foi possível criar.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Modal aberto aoFechar={aoFechar} titulo="Nova campanha">
      <form onSubmit={criar} className="space-y-4">
        {erro && <Aviso tom="erro">{erro}</Aviso>}

        <Campo
          rotulo="Nome"
          value={nome}
          onChange={(evento) => setNome(evento.target.value)}
          required
          autoFocus
        />
        <Campo
          rotulo="Descrição"
          value={descricao}
          onChange={(evento) => setDescricao(evento.target.value)}
        />
        <Campo
          rotulo="Objetivo"
          value={objetivo}
          onChange={(evento) => setObjetivo(evento.target.value)}
          placeholder="Ex.: aumentar seguidores em 20%"
        />

        <div>
          <label className="rotulo" htmlFor="cliente-campanha">
            Cliente
          </label>
          <select
            id="cliente-campanha"
            className="campo"
            value={clienteId}
            onChange={(evento) => setClienteId(evento.target.value)}
          >
            <option value="">Nenhum</option>
            {(clientes?.clients ?? []).map((cliente) => (
              <option key={cliente.id} value={cliente.id}>
                {cliente.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Campo
            rotulo="Início"
            type="date"
            value={inicio}
            onChange={(evento) => setInicio(evento.target.value)}
          />
          <Campo
            rotulo="Fim"
            type="date"
            value={fim}
            onChange={(evento) => setFim(evento.target.value)}
          />
        </div>

        <div className="flex gap-2">
          <Botao type="submit" variante="primaria" carregando={enviando} className="flex-1">
            Criar
          </Botao>
          <Botao type="button" variante="secundaria" onClick={aoFechar}>
            Cancelar
          </Botao>
        </div>
      </form>
    </Modal>
  );
}

function ModalMetricas({ campanha, aoFechar }: { campanha: Campanha; aoFechar: () => void }) {
  const { dados, carregando } = useApi<Metricas>(`/v1/campaigns/${campanha.id}/metrics`);

  const ROTULOS: Record<string, string> = {
    views: 'Visualizações',
    likes: 'Curtidas',
    comments: 'Comentários',
    shares: 'Compartilhamentos',
    saves: 'Salvamentos',
    reach: 'Alcance',
    impressions: 'Impressões',
    clicks: 'Cliques',
  };

  return (
    <Modal aberto aoFechar={aoFechar} titulo={`Métricas — ${campanha.name}`} largura="lg">
      {carregando || !dados ? (
        <Carregando />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-borda p-3">
              <p className="text-xs text-suave">Destinos</p>
              <p className="text-xl font-semibold tabular-nums">{dados.posts.total}</p>
            </div>
            <div className="rounded-lg border border-borda p-3">
              <p className="text-xs text-suave">Publicados</p>
              <p className="text-xl font-semibold tabular-nums text-sucesso">
                {dados.posts.published}
              </p>
            </div>
            <div className="rounded-lg border border-borda p-3">
              <p className="text-xs text-suave">Com falha</p>
              <p className="text-xl font-semibold tabular-nums text-erro">{dados.posts.failed}</p>
            </div>
            <div className="rounded-lg border border-borda p-3">
              <p className="text-xs text-suave">Pendentes</p>
              <p className="text-xl font-semibold tabular-nums">{dados.posts.pending}</p>
            </div>
          </div>

          {Object.keys(dados.totals).length > 0 && (
            <div>
              <p className="mb-2 text-sm font-medium">Totais</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {Object.entries(dados.totals).map(([chave, valor]) => (
                  <div key={chave} className="rounded-lg border border-borda p-2.5">
                    <p className="text-xs text-suave">{ROTULOS[chave] ?? chave}</p>
                    <p className="text-lg font-semibold tabular-nums">
                      {valor.toLocaleString('pt-BR')}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {dados.unavailableMetrics.length > 0 && (
            <Aviso tom="info">
              Métricas não fornecidas pela API oficial das redes desta campanha:{' '}
              {dados.unavailableMetrics
                .map((chave) => ROTULOS[chave] ?? chave)
                .join(', ')}
              . Ficam vazias em vez de virarem zero.
            </Aviso>
          )}
        </div>
      )}
    </Modal>
  );
}
