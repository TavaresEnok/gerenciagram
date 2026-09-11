'use client';

import Link from 'next/link';
import { Botao, Cartao, Carregando, Etiqueta, Vazio } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/sessao';

interface Notificacao {
  id: string;
  type: string;
  title: string;
  body: string;
  actionUrl: string | null;
  readAt: string | null;
  createdAt: string;
}

const TONS: Record<string, 'sucesso' | 'erro' | 'alerta' | 'info'> = {
  POST_PUBLISHED: 'sucesso',
  POST_FAILED: 'erro',
  TOKEN_EXPIRED: 'erro',
  QUOTA_EXCEEDED: 'alerta',
  APPROVAL_PENDING: 'info',
  REPORT_READY: 'info',
};

export default function PaginaNotificacoes() {
  const { dados, carregando, recarregar } = useApi<{
    notifications: Notificacao[];
    unreadCount: number;
  }>('/v1/notifications?limit=50');

  if (carregando) return <Carregando />;

  const notificacoes = dados?.notifications ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Notificações</h1>
          <p className="mt-0.5 text-sm text-suave">
            {dados?.unreadCount ?? 0} não lida(s)
          </p>
        </div>

        {(dados?.unreadCount ?? 0) > 0 && (
          <Botao
            variante="secundaria"
            onClick={() => {
              void api('/v1/notifications/read', { method: 'POST', body: {} }).then(() =>
                recarregar(),
              );
            }}
          >
            Marcar todas como lidas
          </Botao>
        )}
      </header>

      {notificacoes.length === 0 ? (
        <Vazio
          titulo="Nenhuma notificação"
          descricao="Avisos de publicação concluída, falha e token expirado aparecem aqui."
        />
      ) : (
        <div className="space-y-2">
          {notificacoes.map((notificacao) => (
            <Cartao key={notificacao.id} className={notificacao.readAt ? 'opacity-70' : ''}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{notificacao.title}</p>
                    <Etiqueta tom={TONS[notificacao.type] ?? 'neutro'}>
                      {notificacao.type}
                    </Etiqueta>
                    {!notificacao.readAt && <Etiqueta tom="info">Nova</Etiqueta>}
                  </div>

                  <p className="mt-1 text-sm text-suave">{notificacao.body}</p>
                  <p className="mt-1 text-xs text-suave">
                    {new Date(notificacao.createdAt).toLocaleString('pt-BR')}
                  </p>
                </div>

                {notificacao.actionUrl && (
                  <Link href={notificacao.actionUrl}>
                    <Botao variante="secundaria">Abrir</Botao>
                  </Link>
                )}
              </div>
            </Cartao>
          ))}
        </div>
      )}
    </div>
  );
}
