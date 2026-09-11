'use client';

import Link from 'next/link';
import { Aviso, Botao, Cartao, Carregando, Etiqueta, Metrica, Vazio } from '@/components/ui';
import { useApi, useSessao } from '@/lib/sessao';

interface Dashboard {
  accounts: {
    total: number;
    needingReconnect: number;
    byPlatform: Record<string, number>;
  };
  posts: {
    published7d: number;
    scheduled: number;
    failed: number;
    awaitingApproval: number;
  };
  queue: {
    nextPublications: Array<{
      postId: string;
      accountNickname: string;
      scheduledAtLocal: string;
    }>;
  };
}

interface Plataforma {
  key: string;
  displayName: string;
  isAvailable: boolean;
  credentialsConfigured: boolean;
  canConnect: boolean;
  unavailableReason: string | null;
}

const NOMES_REDES: Record<string, string> = {
  YOUTUBE: 'YouTube',
  INSTAGRAM: 'Instagram',
  FACEBOOK: 'Facebook',
  TIKTOK: 'TikTok',
  X: 'X',
  KWAI: 'Kwai',
};

export default function PaginaPainel() {
  const { pode } = useSessao();
  const { dados, carregando } = useApi<Dashboard>('/v1/dashboard', { refreshInterval: 60_000 });
  const { dados: plataformas } = useApi<{ platforms: Plataforma[] }>('/v1/platforms');

  if (carregando) return <Carregando />;
  if (!dados) return <Aviso tom="erro">Não foi possível carregar o painel.</Aviso>;

  const semCredenciais = (plataformas?.platforms ?? []).filter(
    (plataforma) => plataforma.isAvailable && !plataforma.credentialsConfigured,
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Painel</h1>
        <p className="mt-0.5 text-sm text-suave">
          Resumo das contas conectadas e do que está por publicar.
        </p>
      </header>

      {/*
        Aviso honesto e no topo: enquanto faltarem credenciais de aplicativo,
        conectar conta e publicar não funcionam. É melhor a pessoa saber aqui
        do que descobrir depois de montar uma publicação inteira.
      */}
      {semCredenciais.length > 0 && (
        <Aviso tom="alerta" titulo="Integrações aguardando credenciais">
          <p>
            {semCredenciais.map((plataforma) => plataforma.displayName).join(', ')}{' '}
            {semCredenciais.length === 1 ? 'está implementado' : 'estão implementados'}, mas sem
            as credenciais do aplicativo neste ambiente. Conectar contas e publicar ficam
            indisponíveis até que sejam preenchidas.
          </p>
          <p className="mt-1 text-suave">
            Consulte <code className="rounded bg-fundo px-1">SOCIAL_INTEGRATIONS.md</code> para o
            passo a passo de cada rede.
          </p>
        </Aviso>
      )}

      {dados.accounts.needingReconnect > 0 && (
        <Aviso tom="erro" titulo="Contas precisando de reconexão">
          <p>
            {dados.accounts.needingReconnect}{' '}
            {dados.accounts.needingReconnect === 1 ? 'conta teve' : 'contas tiveram'} o acesso
            revogado ou expirado. As publicações agendadas para{' '}
            {dados.accounts.needingReconnect === 1 ? 'ela' : 'elas'} não vão sair.
          </p>
          <Link href="/contas" className="mt-2 inline-block">
            <Botao variante="secundaria">Ver contas</Botao>
          </Link>
        </Aviso>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metrica
          rotulo="Contas conectadas"
          valor={dados.accounts.total}
          detalhe={
            Object.entries(dados.accounts.byPlatform)
              .map(([rede, quantidade]) => `${NOMES_REDES[rede] ?? rede}: ${quantidade}`)
              .join(' · ') || 'Nenhuma conta conectada'
          }
        />
        <Metrica
          rotulo="Publicados (7 dias)"
          valor={dados.posts.published7d}
          tom={dados.posts.published7d > 0 ? 'sucesso' : undefined}
        />
        <Metrica rotulo="Agendados" valor={dados.posts.scheduled} />
        <Metrica
          rotulo="Com falha"
          valor={dados.posts.failed}
          tom={dados.posts.failed > 0 ? 'erro' : undefined}
          detalhe={dados.posts.failed > 0 ? 'Reprocesse na fila de publicação' : undefined}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Cartao
          titulo="Próximas publicações"
          descricao="Horário exibido no fuso de cada conta de destino."
          acoes={
            <Link href="/fila">
              <Botao variante="secundaria">Ver fila</Botao>
            </Link>
          }
        >
          {dados.queue.nextPublications.length === 0 ? (
            <Vazio
              titulo="Nada agendado"
              descricao="Quando você agendar uma publicação, os próximos destinos aparecem aqui."
              acao={
                pode('content:create') ? (
                  <Link href="/compositor">
                    <Botao variante="primaria">Criar conteúdo</Botao>
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <ul className="divide-y divide-borda">
              {dados.queue.nextPublications.map((publicacao, indice) => (
                <li
                  key={`${publicacao.postId}-${indice}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{publicacao.accountNickname}</p>
                    <p className="text-xs text-suave">{publicacao.scheduledAtLocal}</p>
                  </div>
                  <Link href={`/fila?post=${publicacao.postId}`}>
                    <Botao variante="fantasma">Detalhes</Botao>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Cartao>

        <Cartao
          titulo="Aprovações pendentes"
          acoes={
            pode('approval:read') ? (
              <Link href="/aprovacoes">
                <Botao variante="secundaria">Abrir</Botao>
              </Link>
            ) : undefined
          }
        >
          {dados.posts.awaitingApproval === 0 ? (
            <p className="py-4 text-center text-sm text-suave">
              Nenhum conteúdo aguardando revisão.
            </p>
          ) : (
            <div className="flex items-center gap-3 py-2">
              <span className="text-3xl font-semibold tabular-nums">
                {dados.posts.awaitingApproval}
              </span>
              <p className="text-sm text-suave">
                {dados.posts.awaitingApproval === 1
                  ? 'publicação aguardando revisão'
                  : 'publicações aguardando revisão'}
              </p>
            </div>
          )}
        </Cartao>
      </div>

      <Cartao titulo="Redes disponíveis" descricao="O que cada integração permite neste ambiente.">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {(plataformas?.platforms ?? []).map((plataforma) => (
            <div
              key={plataforma.key}
              className="flex items-start justify-between gap-2 rounded-lg border border-borda p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{plataforma.displayName}</p>
                {!plataforma.isAvailable && plataforma.unavailableReason && (
                  <p className="mt-0.5 text-xs leading-snug text-suave">
                    {plataforma.unavailableReason}
                  </p>
                )}
                {plataforma.isAvailable && !plataforma.credentialsConfigured && (
                  <p className="mt-0.5 text-xs leading-snug text-suave">
                    Implementada, mas sem credenciais neste ambiente.
                  </p>
                )}
              </div>

              <Etiqueta
                tom={
                  plataforma.canConnect
                    ? 'sucesso'
                    : plataforma.isAvailable
                      ? 'alerta'
                      : 'neutro'
                }
              >
                {plataforma.canConnect
                  ? 'Pronta'
                  : plataforma.isAvailable
                    ? 'Sem credenciais'
                    : 'Indisponível'}
              </Etiqueta>
            </div>
          ))}
        </div>
      </Cartao>
    </div>
  );
}
