'use client';

import { DateTime } from 'luxon';
import { useState } from 'react';
import {
  Aviso,
  Botao,
  Campo,
  Cartao,
  Carregando,
  Etiqueta,
  Selecao,
  Vazio,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApi, useSessao } from '@/lib/sessao';

/**
 * Relatórios (SPEC seção 6).
 *
 * A geração é assíncrona: a tela registra o pedido e acompanha o estado. Um
 * relatório de um ano varre muitos snapshots, e fazer isso no request
 * estouraria o tempo de resposta da API.
 */

interface Relatorio {
  id: string;
  scope: string;
  scopeId: string | null;
  format: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  downloadUrl: string | null;
}

const ESCOPOS = [
  { valor: 'ORGANIZATION', rotulo: 'Organização inteira' },
  { valor: 'CLIENT', rotulo: 'Cliente/Marca' },
  { valor: 'CAMPAIGN', rotulo: 'Campanha' },
  { valor: 'ACCOUNT_GROUP', rotulo: 'Grupo de contas' },
];

export default function PaginaRelatorios() {
  const { pode } = useSessao();

  const [escopo, setEscopo] = useState('ORGANIZATION');
  const [escopoId, setEscopoId] = useState('');
  const [formato, setFormato] = useState('PDF');
  const [inicio, setInicio] = useState(DateTime.now().minus({ days: 30 }).toISODate() ?? '');
  const [fim, setFim] = useState(DateTime.now().toISODate() ?? '');
  const [erro, setErro] = useState<string | null>(null);
  const [gerando, setGerando] = useState(false);

  // Enquanto houver relatório processando, atualiza sozinho.
  const { dados, carregando, recarregar } = useApi<{ reports: Relatorio[] }>(
    '/v1/reports?limit=30',
    { refreshInterval: 10_000 },
  );

  const { dados: clientes } = useApi<{ clients: Array<{ id: string; name: string }> }>(
    escopo === 'CLIENT' ? '/v1/clients' : null,
  );
  const { dados: campanhas } = useApi<{ campaigns: Array<{ id: string; name: string }> }>(
    escopo === 'CAMPAIGN' ? '/v1/campaigns' : null,
  );
  const { dados: grupos } = useApi<{ groups: Array<{ id: string; name: string }> }>(
    escopo === 'ACCOUNT_GROUP' ? '/v1/groups' : null,
  );

  const opcoesEscopo =
    escopo === 'CLIENT'
      ? (clientes?.clients ?? []).map((item) => ({ id: item.id, nome: item.name }))
      : escopo === 'CAMPAIGN'
        ? (campanhas?.campaigns ?? []).map((item) => ({ id: item.id, nome: item.name }))
        : escopo === 'ACCOUNT_GROUP'
          ? (grupos?.groups ?? []).map((item) => ({ id: item.id, nome: item.name }))
          : [];

  async function gerar(evento: React.FormEvent) {
    evento.preventDefault();
    setErro(null);
    setGerando(true);

    try {
      await api('/v1/reports', {
        method: 'POST',
        body: {
          scope: escopo,
          scopeId: escopo === 'ORGANIZATION' ? undefined : escopoId,
          format: formato,
          periodStart: inicio,
          periodEnd: fim,
        },
      });
      void recarregar();
    } catch (caught) {
      setErro(caught instanceof ApiError ? caught.message : 'Não foi possível gerar.');
    } finally {
      setGerando(false);
    }
  }

  if (carregando) return <Carregando />;

  const relatorios = dados?.reports ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Relatórios</h1>
        <p className="mt-0.5 text-sm text-suave">
          Exportação em PDF ou CSV por cliente, campanha, grupo ou organização.
        </p>
      </header>

      {erro && <Aviso tom="erro">{erro}</Aviso>}

      {pode('report:generate') && (
        <Cartao titulo="Gerar relatório">
          <form onSubmit={gerar} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Selecao
              rotulo="Escopo"
              value={escopo}
              onChange={(evento) => {
                setEscopo(evento.target.value);
                setEscopoId('');
              }}
            >
              {ESCOPOS.map((opcao) => (
                <option key={opcao.valor} value={opcao.valor}>
                  {opcao.rotulo}
                </option>
              ))}
            </Selecao>

            {escopo !== 'ORGANIZATION' && (
              <Selecao
                rotulo="Qual"
                value={escopoId}
                onChange={(evento) => setEscopoId(evento.target.value)}
                required
              >
                <option value="">Selecione…</option>
                {opcoesEscopo.map((opcao) => (
                  <option key={opcao.id} value={opcao.id}>
                    {opcao.nome}
                  </option>
                ))}
              </Selecao>
            )}

            <Campo
              rotulo="De"
              type="date"
              value={inicio}
              onChange={(evento) => setInicio(evento.target.value)}
              required
            />
            <Campo
              rotulo="Até"
              type="date"
              value={fim}
              onChange={(evento) => setFim(evento.target.value)}
              required
            />

            <Selecao
              rotulo="Formato"
              value={formato}
              onChange={(evento) => setFormato(evento.target.value)}
            >
              <option value="PDF">PDF</option>
              <option value="CSV">CSV (Excel)</option>
            </Selecao>

            <div className="flex items-end sm:col-span-2 lg:col-span-5">
              <Botao type="submit" variante="primaria" carregando={gerando}>
                Gerar relatório
              </Botao>
            </div>
          </form>
        </Cartao>
      )}

      <Cartao titulo="Relatórios gerados">
        {relatorios.length === 0 ? (
          <Vazio titulo="Nenhum relatório" descricao="Os relatórios gerados aparecem aqui." />
        ) : (
          <div className="rolagem-horizontal">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Escopo</th>
                  <th>Período</th>
                  <th>Formato</th>
                  <th>Status</th>
                  <th>Gerado em</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {relatorios.map((relatorio) => (
                  <tr key={relatorio.id}>
                    <td>
                      {ESCOPOS.find((item) => item.valor === relatorio.scope)?.rotulo ??
                        relatorio.scope}
                    </td>
                    <td className="text-xs text-suave">
                      {DateTime.fromISO(relatorio.periodStart).toFormat('dd/MM/yy')} –{' '}
                      {DateTime.fromISO(relatorio.periodEnd).toFormat('dd/MM/yy')}
                    </td>
                    <td>{relatorio.format}</td>
                    <td>
                      <Etiqueta
                        tom={
                          relatorio.status === 'READY'
                            ? 'sucesso'
                            : relatorio.status === 'FAILED'
                              ? 'erro'
                              : 'alerta'
                        }
                      >
                        {traduzir(relatorio.status)}
                      </Etiqueta>
                      {relatorio.errorMessage && (
                        <p className="mt-1 text-xs text-erro">{relatorio.errorMessage}</p>
                      )}
                    </td>
                    <td className="text-xs text-suave">
                      {relatorio.completedAt
                        ? DateTime.fromISO(relatorio.completedAt).toFormat('dd/MM/yy HH:mm')
                        : '—'}
                    </td>
                    <td>
                      {relatorio.downloadUrl && (
                        <a
                          href={relatorio.downloadUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          download
                        >
                          <Botao variante="secundaria">Baixar</Botao>
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 text-xs text-suave">
          Os arquivos são apagados automaticamente após 30 dias, conforme a política de
          retenção. Gere novamente se precisar.
        </p>
      </Cartao>
    </div>
  );
}

function traduzir(status: string): string {
  const mapa: Record<string, string> = {
    PENDING: 'Na fila',
    PROCESSING: 'Gerando',
    READY: 'Pronto',
    FAILED: 'Falhou',
  };
  return mapa[status] ?? status;
}
