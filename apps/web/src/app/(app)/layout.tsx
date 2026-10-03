'use client';

import clsx from 'clsx';
import {
  BarChart3,
  Bell,
  Calendar,
  CheckCircle,
  CreditCard,
  FileText,
  FileImage,
  Inbox,
  Layers,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  PenSquare,
  Settings,
  Share2,
  Sparkles,
  User,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import React, { useState, type ReactNode } from 'react';
import { Carregando, Etiqueta } from '@/components/ui';
import { ProvedorSessao, useApi, useExigirSessao } from '@/lib/sessao';

/**
 * Casca da aplicação: navegação lateral, seletor de organização e sino de notificações.
 */

interface ItemMenu {
  href: string;
  rotulo: string;
  icone: React.ComponentType<{ className?: string }>;
  permissao?: string;
  grupo: 'Publicação' | 'Contas' | 'Dados' | 'Organização';
}

const MENU: ItemMenu[] = [
  { href: '/painel', rotulo: 'Painel', icone: LayoutDashboard, grupo: 'Publicação' },
  { href: '/compositor', rotulo: 'Novo conteúdo', icone: PenSquare, permissao: 'content:create', grupo: 'Publicação' },
  { href: '/calendario', rotulo: 'Calendário', icone: Calendar, permissao: 'post:read', grupo: 'Publicação' },
  { href: '/fila', rotulo: 'Fila de publicação', icone: Layers, permissao: 'post:read', grupo: 'Publicação' },
  { href: '/aprovacoes', rotulo: 'Aprovações', icone: CheckCircle, permissao: 'approval:read', grupo: 'Publicação' },

  { href: '/contas', rotulo: 'Contas conectadas', icone: Share2, permissao: 'account:read', grupo: 'Contas' },
  { href: '/grupos', rotulo: 'Grupos de contas', icone: Layers, permissao: 'group:read', grupo: 'Contas' },
  { href: '/biblioteca', rotulo: 'Biblioteca de mídia', icone: FileImage, permissao: 'media:read', grupo: 'Contas' },
  { href: '/campanhas', rotulo: 'Campanhas', icone: Megaphone, permissao: 'campaign:read', grupo: 'Contas' },

  { href: '/analytics', rotulo: 'Analytics', icone: BarChart3, permissao: 'analytics:read', grupo: 'Dados' },
  { href: '/relatorios', rotulo: 'Relatórios', icone: FileText, permissao: 'report:read', grupo: 'Dados' },
  { href: '/inbox', rotulo: 'Inbox', icone: Inbox, permissao: 'inbox:read', grupo: 'Dados' },

  { href: '/configuracoes', rotulo: 'Configurações', icone: Settings, permissao: 'org:read', grupo: 'Organização' },
  { href: '/planos', rotulo: 'Plano e limites', icone: CreditCard, permissao: 'org:read', grupo: 'Organização' },
];

export default function LayoutApp({ children }: { children: ReactNode }) {
  return (
    <ProvedorSessao>
      <Casca>{children}</Casca>
    </ProvedorSessao>
  );
}

function Casca({ children }: { children: ReactNode }) {
  const { carregando, sessao, sair, pode } = useExigirSessao();
  const pathname = usePathname();
  const router = useRouter();
  const [menuAberto, setMenuAberto] = useState(false);

  const { dados: notificacoes } = useApi<{ unreadCount: number }>(
    sessao ? '/v1/notifications?unreadOnly=true&limit=1' : null,
    { refreshInterval: 60_000 },
  );

  if (carregando) return <Carregando rotulo="Restaurando sua sessão..." />;
  if (!sessao) return null;

  const itensVisiveis = MENU.filter((item) => !item.permissao || pode(item.permissao));
  const grupos = [...new Set(itensVisiveis.map((item) => item.grupo))];

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* --- Barra superior no mobile --- */}
      <header className="flex items-center justify-between gap-2 border-b border-borda bg-superficie px-4 py-3 lg:hidden">
        <button
          onClick={() => setMenuAberto((aberto) => !aberto)}
          className="rounded-lg border border-borda p-2 text-sm text-texto"
          aria-expanded={menuAberto}
          aria-label="Alternar menu de navegação"
        >
          {menuAberto ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
        <span className="truncate text-sm font-semibold">
          {sessao.organizations.find((o) => o.id === sessao.currentOrganizationId)?.name}
        </span>
        <Link href="/notificacoes" className="relative p-1.5 text-texto" aria-label="Notificações">
          <Bell className="h-5 w-5 text-suave" />
          {(notificacoes?.unreadCount ?? 0) > 0 && (
            <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-erro ring-2 ring-superficie" />
          )}
        </Link>
      </header>

      {/* --- Navegação lateral --- */}
      <nav
        className={clsx(
          'w-full shrink-0 border-borda bg-superficie lg:block lg:w-64 lg:border-r',
          menuAberto ? 'block border-b' : 'hidden',
        )}
        aria-label="Navegação principal"
      >
        <div className="flex h-full flex-col">
          <div className="hidden border-b border-borda px-4 py-4 lg:flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primaria text-primaria-texto shadow-sm">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-bold tracking-tight">Gerenciador</p>
              <p className="text-[11px] font-medium text-suave">Redes Sociais & IA</p>
            </div>
          </div>

          {/* Seletor de organização: uma agência costuma ter várias. */}
          {sessao.organizations.length > 1 && (
            <div className="border-b border-borda p-3">
              <label htmlFor="org" className="mb-1 block text-xs font-medium text-suave">
                Organização
              </label>
              <select
                id="org"
                className="campo py-1.5 text-xs font-medium"
                value={sessao.currentOrganizationId}
                onChange={(evento) => {
                  void trocarOrganizacao(evento.target.value, router);
                }}
              >
                {sessao.organizations.map((organizacao) => (
                  <option key={organizacao.id} value={organizacao.id}>
                    {organizacao.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex-1 space-y-4 overflow-y-auto p-3">
            {grupos.map((grupo) => (
              <div key={grupo}>
                <p className="mb-1 px-2.5 text-[10px] font-bold uppercase tracking-wider text-suave/80">
                  {grupo}
                </p>
                <ul className="space-y-0.5">
                  {itensVisiveis
                    .filter((item) => item.grupo === grupo)
                    .map((item) => {
                      const Icone = item.icone;
                      const ativo = pathname === item.href || pathname.startsWith(`${item.href}/`);

                      return (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            onClick={() => setMenuAberto(false)}
                            aria-current={ativo ? 'page' : undefined}
                            className={clsx(
                              'group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-all duration-150',
                              ativo
                                ? 'bg-primaria text-primaria-texto shadow-sm'
                                : 'text-suave hover:bg-fundo hover:text-texto',
                            )}
                          >
                            <Icone
                              className={clsx(
                                'h-4 w-4 shrink-0 transition-transform group-hover:scale-110',
                                ativo ? 'text-primaria-texto' : 'text-suave group-hover:text-texto',
                              )}
                            />
                            {item.rotulo}
                          </Link>
                        </li>
                      );
                    })}
                </ul>
              </div>
            ))}
          </div>

          <div className="border-t border-borda p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{sessao.user.name}</p>
                <p className="truncate text-xs text-suave">{sessao.user.email}</p>
              </div>
              <Etiqueta tom="info">{traduzirPapel(sessao.role)}</Etiqueta>
            </div>

            {!sessao.user.emailVerified && (
              <p className="mb-2 rounded-md bg-alerta/10 px-2 py-1.5 text-xs text-texto">
                Confirme seu e-mail para receber avisos de falha de publicação.
              </p>
            )}

            <div className="flex gap-2">
              <Link href="/perfil" className="flex-1">
                <button
                  type="button"
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-borda py-1.5 text-xs font-medium text-texto hover:bg-fundo transition"
                >
                  <User className="h-3.5 w-3.5 text-suave" />
                  Perfil
                </button>
              </Link>
              <button
                type="button"
                className="flex items-center justify-center gap-1.5 rounded-lg border border-transparent px-3 py-1.5 text-xs font-medium text-erro hover:bg-erro/10 transition"
                onClick={() => {
                  void sair().then(() => router.replace('/entrar'));
                }}
              >
                <LogOut className="h-3.5 w-3.5" />
                Sair
              </button>
            </div>
          </div>
        </div>
      </nav>

      <main className="min-w-0 flex-1 bg-fundo">
        <div className="mx-auto max-w-7xl p-4 sm:p-6">{children}</div>
      </main>
    </div>
  );
}

async function trocarOrganizacao(organizationId: string, router: ReturnType<typeof useRouter>) {
  const { api, definirToken } = await import('@/lib/api');

  const resposta = await api<{ accessToken: string }>('/v1/auth/refresh', {
    method: 'POST',
    body: { organizationId },
  });

  definirToken(resposta.accessToken);
  router.refresh();
  window.location.reload();
}

function traduzirPapel(papel: string): string {
  const mapa: Record<string, string> = {
    OWNER: 'Proprietário',
    ADMIN: 'Administrador',
    MANAGER: 'Gestor',
    EDITOR: 'Editor',
    APPROVER: 'Aprovador',
    ANALYST: 'Analista',
    VIEWER: 'Leitor',
  };
  return mapa[papel] ?? papel;
}
