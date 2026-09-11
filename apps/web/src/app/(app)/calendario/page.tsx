'use client';

import { DateTime } from 'luxon';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  Aviso,
  Botao,
  Cartao,
  Carregando,
  Etiqueta,
  EtiquetaStatus,
  Modal,
  Selecao,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApi, useSessao } from '@/lib/sessao';

/**
 * Calendário editorial (SPEC seção 7).
 *
 * Um cuidado que a tela precisa ter: o calendário é desenhado num fuso só (o
 * do usuário), mas cada destino tem o SEU fuso. Por isso o card mostra o
 * horário local da conta ao abrir, e arrastar reagenda pedindo o novo horário
 * — em vez de assumir que "mover para o dia 15" significa a mesma hora em
 * todas as contas.
 */

interface Destino {
  id: string;
  accountNickname: string;
  platformName: string;
  status: string;
  scheduledAt: string | null;
  scheduledAtLocal: string | null;
  timezone: string;
  errorMessage: string | null;
}

interface Publicacao {
  id: string;
  status: string;
  intendedScheduledAt: string | null;
  content: { title: string | null; body: string; mediaCount: number };
  targets: Destino[];
  counts: { total: number; published: number; failed: number; pending: number };
}

type Visao = 'MES' | 'SEMANA';

export default function PaginaCalendario() {
  const { sessao, pode } = useSessao();
  const fusoUsuario = sessao?.user.timezone ?? 'America/Sao_Paulo';

  const [visao, setVisao] = useState<Visao>('MES');
  const [referencia, setReferencia] = useState(() => DateTime.now().setZone(fusoUsuario));
  const [grupoId, setGrupoId] = useState('');
  const [contaId, setContaId] = useState('');
  const [aberta, setAberta] = useState<Publicacao | null>(null);
  const [mensagem, setMensagem] = useState<{ tom: 'sucesso' | 'erro'; texto: string } | null>(
    null,
  );

  const { inicio, fim, dias } = useMemo(() => {
    if (visao === 'SEMANA') {
      const primeiro = referencia.startOf('week');
      return {
        inicio: primeiro,
        fim: primeiro.plus({ days: 6 }).endOf('day'),
        dias: Array.from({ length: 7 }, (_, indice) => primeiro.plus({ days: indice })),
      };
    }

    // Grade mensal completa, incluindo os dias vizinhos que fecham as semanas.
    const primeiroDoMes = referencia.startOf('month');
    const primeiro = primeiroDoMes.startOf('week');
    const ultimo = referencia.endOf('month').endOf('week');
    const total = Math.round(ultimo.diff(primeiro, 'days').days) + 1;

    return {
      inicio: primeiro,
      fim: ultimo,
      dias: Array.from({ length: total }, (_, indice) => primeiro.plus({ days: indice })),
    };
  }, [referencia, visao]);

  const consulta = new URLSearchParams({
    from: inicio.toUTC().toISO() ?? '',
    to: fim.toUTC().toISO() ?? '',
    limit: '200',
  });
  if (grupoId) consulta.set('groupId', grupoId);
  if (contaId) consulta.set('accountId', contaId);

  const { dados, carregando, recarregar } = useApi<{ posts: Publicacao[] }>(
    `/v1/posts?${consulta.toString()}`,
  );
  const { dados: grupos } = useApi<{ groups: Array<{ id: string; name: string }> }>('/v1/groups');
  const { dados: contas } = useApi<{ accounts: Array<{ id: string; nickname: string }> }>(
    '/v1/accounts',
  );

  /** Agrupa os DESTINOS por dia — o que ocupa o calendário é o destino. */
  const porDia = useMemo(() => {
    const mapa = new Map<string, Array<{ publicacao: Publicacao; destino: Destino }>>();

    for (const publicacao of dados?.posts ?? []) {
      for (const destino of publicacao.targets) {
        if (!destino.scheduledAt) continue;

        const chave = DateTime.fromISO(destino.scheduledAt).setZone(fusoUsuario).toISODate();
        if (!chave) continue;

        const lista = mapa.get(chave) ?? [];
        lista.push({ publicacao, destino });
        mapa.set(chave, lista);
      }
    }

    return mapa;
  }, [dados, fusoUsuario]);

  async function reagendar(publicacaoId: string, novaData: DateTime, horaOriginal: DateTime) {
    const novoInstante = novaData.set({
      hour: horaOriginal.hour,
      minute: horaOriginal.minute,
    });

    try {
      await api(`/v1/posts/${publicacaoId}/schedule`, {
        method: 'POST',
        body: {
          mode: 'SPECIFIC_TIME',
          localDateTime: novoInstante.toFormat("yyyy-MM-dd'T'HH:mm"),
        },
      });

      setMensagem({
        tom: 'sucesso',
        texto: `Reagendado para ${novoInstante.toFormat('dd/MM')} às ${novoInstante.toFormat('HH:mm')} no fuso de cada conta.`,
      });
      void recarregar();
    } catch (caught) {
      setMensagem({
        tom: 'erro',
        texto: caught instanceof ApiError ? caught.message : 'Não foi possível reagendar.',
      });
    }
  }

  if (carregando) return <Carregando />;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Calendário editorial</h1>
          <p className="mt-0.5 text-sm text-suave">
            Exibido no seu fuso ({fusoUsuario}). Cada destino guarda o fuso da própria conta.
          </p>
        </div>

        {pode('content:create') && (
          <Link href="/compositor">
            <Botao variante="primaria">Novo conteúdo</Botao>
          </Link>
        )}
      </header>

      {mensagem && <Aviso tom={mensagem.tom}>{mensagem.texto}</Aviso>}

      <Cartao>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-1">
            <Botao
              variante="secundaria"
              onClick={() =>
                setReferencia((atual) =>
                  visao === 'MES' ? atual.minus({ months: 1 }) : atual.minus({ weeks: 1 }),
                )
              }
              aria-label="Período anterior"
            >
              ←
            </Botao>
            <Botao variante="secundaria" onClick={() => setReferencia(DateTime.now().setZone(fusoUsuario))}>
              Hoje
            </Botao>
            <Botao
              variante="secundaria"
              onClick={() =>
                setReferencia((atual) =>
                  visao === 'MES' ? atual.plus({ months: 1 }) : atual.plus({ weeks: 1 }),
                )
              }
              aria-label="Próximo período"
            >
              →
            </Botao>
          </div>

          <p className="min-w-40 text-sm font-medium capitalize">
            {visao === 'MES'
              ? referencia.setLocale('pt-BR').toFormat('LLLL yyyy')
              : `${inicio.toFormat('dd/MM')} – ${fim.toFormat('dd/MM/yyyy')}`}
          </p>

          <div className="ml-auto flex flex-wrap gap-3">
            <Selecao
              rotulo="Visão"
              value={visao}
              onChange={(evento) => setVisao(evento.target.value as Visao)}
              className="py-1.5"
            >
              <option value="MES">Mensal</option>
              <option value="SEMANA">Semanal</option>
            </Selecao>

            <Selecao
              rotulo="Grupo"
              value={grupoId}
              onChange={(evento) => setGrupoId(evento.target.value)}
              className="py-1.5"
            >
              <option value="">Todos</option>
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
              className="py-1.5"
            >
              <option value="">Todas</option>
              {(contas?.accounts ?? []).map((conta) => (
                <option key={conta.id} value={conta.id}>
                  {conta.nickname}
                </option>
              ))}
            </Selecao>
          </div>
        </div>
      </Cartao>

      <div className="rolagem-horizontal">
        <div className="min-w-[720px]">
          <div className="grid grid-cols-7 gap-px rounded-t-lg border border-borda bg-borda">
            {['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((dia) => (
              <div key={dia} className="bg-superficie px-2 py-1.5 text-center text-xs font-medium text-suave">
                {dia}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-px rounded-b-lg border border-t-0 border-borda bg-borda">
            {dias.map((dia) => {
              const chave = dia.toISODate() ?? '';
              const itens = porDia.get(chave) ?? [];
              const doMesAtual = visao === 'SEMANA' || dia.month === referencia.month;
              const hoje = dia.hasSame(DateTime.now().setZone(fusoUsuario), 'day');

              return (
                <div
                  key={chave}
                  onDragOver={(evento) => evento.preventDefault()}
                  onDrop={(evento) => {
                    evento.preventDefault();
                    const dados = evento.dataTransfer.getData('text/plain');
                    if (!dados) return;

                    const [publicacaoId, instante] = dados.split('|');
                    if (!publicacaoId || !instante) return;

                    void reagendar(
                      publicacaoId,
                      dia,
                      DateTime.fromISO(instante).setZone(fusoUsuario),
                    );
                  }}
                  className={
                    'min-h-28 bg-superficie p-1.5 ' +
                    (doMesAtual ? '' : 'opacity-50 ')
                  }
                >
                  <p
                    className={
                      hoje
                        ? 'mb-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-primaria text-xs text-primaria-texto'
                        : 'mb-1 text-xs text-suave'
                    }
                  >
                    {dia.day}
                  </p>

                  <ul className="space-y-1">
                    {itens.slice(0, 4).map(({ publicacao, destino }) => (
                      <li key={destino.id}>
                        <button
                          draggable={
                            pode('post:schedule') &&
                            ['SCHEDULED', 'QUEUED', 'PENDING'].includes(destino.status)
                          }
                          onDragStart={(evento) => {
                            evento.dataTransfer.setData(
                              'text/plain',
                              `${publicacao.id}|${destino.scheduledAt}`,
                            );
                          }}
                          onClick={() => setAberta(publicacao)}
                          className="w-full truncate rounded border border-borda bg-fundo px-1.5 py-1 text-left text-[11px] hover:bg-superficie"
                          title={`${destino.accountNickname} — ${destino.scheduledAtLocal ?? ''}`}
                        >
                          <span
                            className={
                              destino.status === 'FAILED'
                                ? 'mr-1 inline-block h-1.5 w-1.5 rounded-full bg-erro'
                                : destino.status === 'PUBLISHED'
                                  ? 'mr-1 inline-block h-1.5 w-1.5 rounded-full bg-sucesso'
                                  : 'mr-1 inline-block h-1.5 w-1.5 rounded-full bg-suave'
                            }
                          />
                          {DateTime.fromISO(destino.scheduledAt ?? '')
                            .setZone(fusoUsuario)
                            .toFormat('HH:mm')}{' '}
                          {destino.accountNickname}
                        </button>
                      </li>
                    ))}

                    {itens.length > 4 && (
                      <li className="px-1.5 text-[11px] text-suave">
                        + {itens.length - 4} destino(s)
                      </li>
                    )}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {aberta && (
        <Modal aberto aoFechar={() => setAberta(null)} titulo="Publicação" largura="lg">
          <div className="space-y-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">
                  {aberta.content.title || aberta.content.body.slice(0, 60) || 'Sem título'}
                </h3>
                <EtiquetaStatus status={aberta.status} />
              </div>
              {aberta.content.body && (
                <p className="mt-1 whitespace-pre-wrap text-sm text-suave">
                  {aberta.content.body.slice(0, 400)}
                </p>
              )}
            </div>

            <div className="rolagem-horizontal">
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Conta</th>
                    <th>Status</th>
                    <th>Horário no fuso da conta</th>
                  </tr>
                </thead>
                <tbody>
                  {aberta.targets.map((destino) => (
                    <tr key={destino.id}>
                      <td>
                        <p className="font-medium">{destino.accountNickname}</p>
                        <p className="text-xs text-suave">{destino.platformName}</p>
                      </td>
                      <td>
                        <EtiquetaStatus status={destino.status} />
                        {destino.errorMessage && (
                          <p className="mt-1 text-xs text-erro">{destino.errorMessage}</p>
                        )}
                      </td>
                      <td className="text-xs text-suave">{destino.scheduledAtLocal ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {new Set(aberta.targets.map((destino) => destino.timezone)).size > 1 && (
              <Aviso tom="info">
                Os destinos estão em fusos diferentes, então o mesmo agendamento cai em
                instantes distintos.
              </Aviso>
            )}

            <div className="flex flex-wrap gap-2">
              <Link href={`/fila?post=${aberta.id}`}>
                <Botao variante="primaria">Abrir na fila</Botao>
              </Link>
              {aberta.counts.failed > 0 && (
                <Etiqueta tom="erro">{aberta.counts.failed} destino(s) com falha</Etiqueta>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
