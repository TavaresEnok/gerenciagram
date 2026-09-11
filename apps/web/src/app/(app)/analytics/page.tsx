'use client';

import { DateTime } from 'luxon';
import { useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Aviso, Botao, Cartao, Carregando, Etiqueta, Metrica, Selecao, Vazio } from '@/components/ui';
import { useApi } from '@/lib/sessao';

/**
 * Analytics (SPEC seção 6).
 *
 * A regra que atravessa a tela inteira: métrica que a API oficial não fornece
 * NÃO vira zero. Ela some do gráfico e aparece numa lista de "não fornecidas
 * por esta rede". Um zero num gráfico de crescimento é indistinguível de uma
 * queda real — e faria o cliente tomar decisão sobre um dado que não existe.
 */

interface Rede {
  platform: string;
  platformName: string;
  accounts: number;
  followers: number | null;
  followersGrowth: number | null;
  publishedPosts: number;
  totals: Record<string, number>;
  unavailableMetrics: string[];
}

interface Serie {
  metric: string;
  points: Array<{ date: string; value: number }>;
  missingDays: number;
}

const METRICAS: Array<{ chave: string; rotulo: string }> = [
  { chave: 'views', rotulo: 'Visualizações' },
  { chave: 'likes', rotulo: 'Curtidas' },
  { chave: 'comments', rotulo: 'Comentários' },
  { chave: 'shares', rotulo: 'Compartilhamentos' },
  { chave: 'reach', rotulo: 'Alcance' },
  { chave: 'impressions', rotulo: 'Impressões' },
  { chave: 'followers', rotulo: 'Seguidores' },
];

export default function PaginaAnalytics() {
  const [dias, setDias] = useState(30);
  const [metrica, setMetrica] = useState('views');
  const [grupoId, setGrupoId] = useState('');

  const ate = DateTime.now();
  const de = ate.minus({ days: dias });

  const periodo = `from=${de.toISODate()}&to=${ate.toISODate()}`;
  const filtroGrupo = grupoId ? `&groupId=${grupoId}` : '';

  const { dados, carregando } = useApi<{ byPlatform: Rede[] }>(
    `/v1/analytics/overview?${periodo}${filtroGrupo}`,
  );
  const { dados: serie } = useApi<Serie>(
    `/v1/analytics/series?metric=${metrica}&${periodo}${filtroGrupo}`,
  );
  const { dados: grupos } = useApi<{ groups: Array<{ id: string; name: string }> }>('/v1/groups');

  if (carregando) return <Carregando />;

  const redes = dados?.byPlatform ?? [];
  const totalPublicado = redes.reduce((soma, rede) => soma + rede.publishedPosts, 0);
  const totalSeguidores = redes.reduce((soma, rede) => soma + (rede.followers ?? 0), 0);
  const crescimento = redes.reduce((soma, rede) => soma + (rede.followersGrowth ?? 0), 0);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Analytics</h1>
          <p className="mt-0.5 text-sm text-suave">
            {de.toFormat('dd/MM/yyyy')} a {ate.toFormat('dd/MM/yyyy')}
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Selecao
            rotulo="Período"
            value={String(dias)}
            onChange={(evento) => setDias(Number(evento.target.value))}
            className="py-1.5"
          >
            <option value="7">7 dias</option>
            <option value="30">30 dias</option>
            <option value="90">90 dias</option>
            <option value="365">1 ano</option>
          </Selecao>

          <Selecao
            rotulo="Grupo"
            value={grupoId}
            onChange={(evento) => setGrupoId(evento.target.value)}
            className="py-1.5"
          >
            <option value="">Todas as contas</option>
            {(grupos?.groups ?? []).map((grupo) => (
              <option key={grupo.id} value={grupo.id}>
                {grupo.name}
              </option>
            ))}
          </Selecao>
        </div>
      </header>

      {redes.length === 0 ? (
        <Vazio
          titulo="Sem dados no período"
          descricao="As métricas são coletadas diariamente das contas conectadas. Conecte uma conta e aguarde a primeira coleta."
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Metrica
              rotulo="Seguidores"
              valor={totalSeguidores > 0 ? totalSeguidores.toLocaleString('pt-BR') : '—'}
              detalhe={
                crescimento !== 0
                  ? `${crescimento > 0 ? '+' : ''}${crescimento.toLocaleString('pt-BR')} no período`
                  : 'Sem variação registrada'
              }
              {...(crescimento > 0 ? { tom: 'sucesso' as const } : {})}
            />
            <Metrica rotulo="Publicações" valor={totalPublicado} />
            <Metrica rotulo="Redes ativas" valor={redes.length} />
          </div>

          <Cartao
            titulo="Evolução"
            acoes={
              <Selecao
                rotulo=""
                aria-label="Métrica"
                value={metrica}
                onChange={(evento) => setMetrica(evento.target.value)}
                className="py-1"
              >
                {METRICAS.map((item) => (
                  <option key={item.chave} value={item.chave}>
                    {item.rotulo}
                  </option>
                ))}
              </Selecao>
            }
          >
            {!serie || serie.points.length === 0 ? (
              <p className="py-10 text-center text-sm text-suave">
                Nenhum dado desta métrica no período. As redes conectadas podem não fornecê-la
                pela API oficial.
              </p>
            ) : (
              <>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={serie.points}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--borda))" />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 11, fill: 'rgb(var(--suave))' }}
                        tickFormatter={(valor: string) =>
                          DateTime.fromISO(valor).toFormat('dd/MM')
                        }
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: 'rgb(var(--suave))' }}
                        tickFormatter={(valor: number) => valor.toLocaleString('pt-BR')}
                      />
                      <Tooltip
                        contentStyle={{
                          background: 'rgb(var(--superficie))',
                          border: '1px solid rgb(var(--borda))',
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                        labelFormatter={(valor: string) =>
                          DateTime.fromISO(valor).toFormat('dd/MM/yyyy')
                        }
                        formatter={(valor: number) => [valor.toLocaleString('pt-BR'), '']}
                      />
                      {/* connectNulls fica FALSO: dia sem coleta é buraco no
                          gráfico, não uma linha reta que sugere continuidade. */}
                      <Line
                        type="monotone"
                        dataKey="value"
                        stroke="rgb(var(--texto))"
                        strokeWidth={2}
                        dot={false}
                        connectNulls={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                {serie.missingDays > 0 && (
                  <p className="mt-2 text-xs text-suave">
                    {serie.missingDays} dia(s) do período sem coleta — esses pontos não aparecem
                    no gráfico em vez de virarem zero.
                  </p>
                )}
              </>
            )}
          </Cartao>

          <Cartao titulo="Comparativo entre redes">
            <div className="rolagem-horizontal">
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Rede</th>
                    <th>Contas</th>
                    <th>Seguidores</th>
                    <th>Publicações</th>
                    <th>Visualizações</th>
                    <th>Curtidas</th>
                    <th>Comentários</th>
                  </tr>
                </thead>
                <tbody>
                  {redes.map((rede) => (
                    <tr key={rede.platform}>
                      <td className="font-medium">{rede.platformName}</td>
                      <td className="tabular-nums">{rede.accounts}</td>
                      <td className="tabular-nums">
                        {rede.followers?.toLocaleString('pt-BR') ?? '—'}
                        {rede.followersGrowth !== null && rede.followersGrowth !== 0 && (
                          <span
                            className={
                              rede.followersGrowth > 0
                                ? 'ml-1 text-xs text-sucesso'
                                : 'ml-1 text-xs text-erro'
                            }
                          >
                            {rede.followersGrowth > 0 ? '+' : ''}
                            {rede.followersGrowth}
                          </span>
                        )}
                      </td>
                      <td className="tabular-nums">{rede.publishedPosts}</td>
                      <td className="tabular-nums">
                        {rede.totals['views']?.toLocaleString('pt-BR') ?? '—'}
                      </td>
                      <td className="tabular-nums">
                        {rede.totals['likes']?.toLocaleString('pt-BR') ?? '—'}
                      </td>
                      <td className="tabular-nums">
                        {rede.totals['comments']?.toLocaleString('pt-BR') ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/*
              Transparência sobre o que não veio. É o contrário do que a maioria
              das ferramentas faz — e o que a SPEC exige.
            */}
            {redes.some((rede) => rede.unavailableMetrics.length > 0) && (
              <Aviso tom="info" titulo="Métricas não fornecidas pela API oficial">
                <ul className="space-y-1">
                  {redes
                    .filter((rede) => rede.unavailableMetrics.length > 0)
                    .map((rede) => (
                      <li key={rede.platform}>
                        <strong>{rede.platformName}</strong>:{' '}
                        {rede.unavailableMetrics
                          .map(
                            (chave) =>
                              METRICAS.find((item) => item.chave === chave)?.rotulo ?? chave,
                          )
                          .join(', ')}
                      </li>
                    ))}
                </ul>
                <p className="mt-2 text-suave">
                  Estes campos ficam vazios de propósito. Preenchê-los com zero criaria uma
                  queda que não existe.
                </p>
              </Aviso>
            )}
          </Cartao>
        </>
      )}
    </div>
  );
}
