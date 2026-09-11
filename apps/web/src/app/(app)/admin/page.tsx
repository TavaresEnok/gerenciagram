'use client';

import { useState } from 'react';
import { Aviso, Botao, Cartao, Carregando, Etiqueta, Metrica, Vazio } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApi } from '@/lib/sessao';

/**
 * Painel interno do dono do SaaS (SPEC seção 6).
 *
 * O acesso não vem do RBAC de tenant: é a flag `isPlatformAdmin` no usuário.
 * Quem não tem recebe a mesma resposta de "não existe", para o painel não se
 * anunciar a quem está sondando.
 */

interface Visao {
  organizations: { total: number; active30d: number; byPlan: Record<string, number> };
  usage: {
    users: number;
    socialAccounts: number;
    accountsByPlatform: Record<string, number>;
    storageBytes: number;
    publishedLast7d: number;
  };
  errors: {
    failedTargets7d: number;
    deadLetterOpen: number;
    accountsNeedingReconnect: number;
    failureRateByPlatform: Record<string, number>;
  };
  queues: Array<{ name: string; waiting: number; active: number; delayed: number; failed: number }>;
  circuits: Array<{ platform: string; state: string; failureCount: number; openedAt: string | null }>;
}

interface JobMorto {
  id: string;
  queueName: string;
  jobName: string;
  organizationId: string | null;
  attemptsMade: number;
  failedReason: string | null;
  correlationId: string | null;
  createdAt: string;
}

export default function PaginaAdmin() {
  const { dados, carregando, erro, recarregar } = useApi<Visao>('/v1/admin/overview', {
    refreshInterval: 30_000,
  });
  const { dados: mortos, recarregar: recarregarMortos } = useApi<{ jobs: JobMorto[] }>(
    '/v1/admin/dead-letter?limit=30',
  );

  const [mensagem, setMensagem] = useState<{ tom: 'sucesso' | 'erro'; texto: string } | null>(
    null,
  );

  if (carregando) return <Carregando />;

  if (erro || !dados) {
    return (
      <Vazio
        titulo="Sem acesso"
        descricao="Este painel é restrito à administração da plataforma."
      />
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Painel da plataforma</h1>
        <p className="mt-0.5 text-sm text-suave">
          Visão interna: organizações, uso, erros e filas.
        </p>
      </header>

      {mensagem && <Aviso tom={mensagem.tom}>{mensagem.texto}</Aviso>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metrica
          rotulo="Organizações"
          valor={dados.organizations.total}
          detalhe={`${dados.organizations.active30d} ativas em 30 dias`}
        />
        <Metrica rotulo="Contas conectadas" valor={dados.usage.socialAccounts} />
        <Metrica rotulo="Publicados (7d)" valor={dados.usage.publishedLast7d} tom="sucesso" />
        <Metrica
          rotulo="Falhas (7d)"
          valor={dados.errors.failedTargets7d}
          tom={dados.errors.failedTargets7d > 0 ? 'erro' : undefined}
        />
      </div>

      {/* --- Circuitos --- */}
      <Cartao
        titulo="Circuit breakers"
        descricao="Aberto significa que paramos de chamar a plataforma por falhas repetidas."
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {dados.circuits.map((circuito) => (
            <div
              key={circuito.platform}
              className="flex items-center justify-between gap-2 rounded-lg border border-borda p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{circuito.platform}</p>
                <p className="text-xs text-suave">
                  {circuito.failureCount} falha(s) consecutiva(s)
                  {circuito.openedAt &&
                    ` · aberto em ${new Date(circuito.openedAt).toLocaleString('pt-BR')}`}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <Etiqueta
                  tom={
                    circuito.state === 'CLOSED'
                      ? 'sucesso'
                      : circuito.state === 'HALF_OPEN'
                        ? 'alerta'
                        : 'erro'
                  }
                >
                  {circuito.state === 'CLOSED'
                    ? 'Fechado'
                    : circuito.state === 'HALF_OPEN'
                      ? 'Sondando'
                      : 'Aberto'}
                </Etiqueta>

                {circuito.state !== 'CLOSED' && (
                  <Botao
                    variante="fantasma"
                    onClick={() => {
                      void api(`/v1/admin/circuits/${circuito.platform}/reset`, { method: 'POST' })
                        .then(() => {
                          setMensagem({
                            tom: 'sucesso',
                            texto: `Circuito de ${circuito.platform} fechado.`,
                          });
                          void recarregar();
                        })
                        .catch((caught: unknown) =>
                          setMensagem({
                            tom: 'erro',
                            texto:
                              caught instanceof ApiError
                                ? caught.message
                                : 'Não foi possível fechar.',
                          }),
                        );
                    }}
                  >
                    Fechar
                  </Botao>
                )}
              </div>
            </div>
          ))}
        </div>

        {Object.keys(dados.errors.failureRateByPlatform).length > 0 && (
          <div className="mt-3 border-t border-borda pt-3">
            <p className="mb-1.5 text-xs font-medium text-suave">Taxa de falha (7 dias)</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(dados.errors.failureRateByPlatform).map(([rede, taxa]) => (
                <Etiqueta key={rede} tom={taxa > 20 ? 'erro' : taxa > 5 ? 'alerta' : 'sucesso'}>
                  {rede}: {taxa}%
                </Etiqueta>
              ))}
            </div>
          </div>
        )}
      </Cartao>

      {/* --- Filas --- */}
      <Cartao titulo="Filas">
        <div className="rolagem-horizontal">
          <table className="tabela">
            <thead>
              <tr>
                <th>Fila</th>
                <th>Aguardando</th>
                <th>Ativos</th>
                <th>Adiados</th>
                <th>Falhos</th>
              </tr>
            </thead>
            <tbody>
              {dados.queues.map((fila) => (
                <tr key={fila.name}>
                  <td className="font-medium">{fila.name}</td>
                  <td className="tabular-nums">{fila.waiting}</td>
                  <td className="tabular-nums">{fila.active}</td>
                  <td className="tabular-nums">{fila.delayed}</td>
                  <td
                    className={fila.failed > 0 ? 'tabular-nums text-erro' : 'tabular-nums'}
                  >
                    {fila.failed}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Cartao>

      {/* --- Dead letter --- */}
      <Cartao
        titulo="Dead-letter queue"
        descricao={`${dados.errors.deadLetterOpen} job(s) em aberto. Nada some silenciosamente.`}
      >
        {(mortos?.jobs.length ?? 0) === 0 ? (
          <p className="py-4 text-center text-sm text-suave">
            Nenhum job esgotou as tentativas.
          </p>
        ) : (
          <div className="space-y-2">
            {mortos?.jobs.map((job) => (
              <div key={job.id} className="rounded-lg border border-borda p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {job.queueName} / {job.jobName}
                    </p>
                    <p className="text-xs text-suave">
                      {job.attemptsMade} tentativa(s) ·{' '}
                      {new Date(job.createdAt).toLocaleString('pt-BR')}
                      {job.correlationId && ` · ${job.correlationId}`}
                    </p>
                    {job.failedReason && (
                      <p className="mt-1 text-xs text-erro">{job.failedReason}</p>
                    )}
                  </div>

                  <Botao
                    variante="secundaria"
                    onClick={() => {
                      const resolucao = window.prompt('Como este job foi tratado?');
                      if (!resolucao) return;

                      void api(`/v1/admin/dead-letter/${job.id}/resolve`, {
                        method: 'POST',
                        body: { resolution: resolucao },
                      }).then(() => void recarregarMortos());
                    }}
                  >
                    Marcar como tratado
                  </Botao>
                </div>
              </div>
            ))}
          </div>
        )}
      </Cartao>
    </div>
  );
}
