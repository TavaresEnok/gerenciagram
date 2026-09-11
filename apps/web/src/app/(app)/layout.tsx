'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Botao, Carregando, Etiqueta } from '@/components/ui';
import { ProvedorSessao, useApi, useExigirSessao } from '@/lib/sessao';

/**
 * Casca da aplicação: navegação lateral, seletor de organização e sino de
 * notificações.
 *
 * Os itens do menu são filtrados pela permissão do papel. Isso é conveniência
 * de interface, não segurança — o backend recusa qualquer chamada sem
 * permissão de qualquer forma.
 */

interface ItemMenu {
  href: string;
  rotulo: string;
  icone: string;
  permissao?: string;
  grupo: 'Publicação' | 'Contas' | 'Dados' | 'Organização';
}

const MENU: ItemMenu[] = [
  { href: '/painel', rotulo: 'Painel', icone: '◈', grupo: 'Publicação' },
  { href: '/compositor', rotulo: 'Novo conteúdo', icone: '✎', permissao: 'content:create', grupo: 'Publicação' },
  { href: '/calendario', rotulo: 'Calendário', icone: '▦', permissao: 'post:read', grupo: 'Publicação' },
  { href: '/fila', rotulo: 'Fila de publicação', icone: '≡', permissao: 'post:read', grupo: 'Publicação' },
  { href: '/aprovacoes', rotulo: 'Aprovações', icone: '✓', permissao: 'approval:read', grupo: 'Publicação' },

  { href: '/contas', rotulo: 'Contas conectadas', icone: '◎', permissao: 'account:read', grupo: 'Contas' },
  { href: '/grupos', rotulo: 'Grupos de contas', icone: '⬡', permissao: 'group:read', grupo: 'Contas' },
  { href: '/biblioteca', rotulo: 'Biblioteca de mídia', icone: '▤', permissao: 'media:read', grupo: 'Contas' },
  { href: '/campanhas', rotulo: 'Campanhas', icone: '◐', permissao: 'campaign:read', grupo: 'Contas' },

  { href: '/analytics', rotulo: 'Analytics', icone: '◔', permissao: 'analytics:read', grupo: 'Dados' },
  { href: '/relatorios', rotulo: 'Relatórios', icone: '▣', permissao: 'report:read', grupo: 'Dados' },
  { href: '/inbox', rotulo: 'Inbox', icone: '✉', permissao: 'inbox:read', grupo: 'Dados' },

  { href: '/configuracoes', rotulo: 'Configurações', icone: '⚙', permissao: 'org:read', grupo: 'Organização' },
  { href: '/planos', rotulo: 'Plano e limites', icone: '◇', permissao: 'org:read', grupo: 'Organização' },
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
          className="rounded-lg border border-borda px-2.5 py-1.5 text-sm"
          aria-expanded={menuAberto}
          aria-label="Alternar menu de navegação"
        >
          ☰
        </button>
        <span className="truncate text-sm font-semibold">
          {sessao.organizations.find((o) => o.id === sessao.currentOrganizationId)?.name}
        </span>
        <Link href="/notificacoes" className="relative text-lg" aria-label="Notificações">
          ✉
          {(notificacoes?.unreadCount ?? 0) > 0 && (
            <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-erro" />
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
          <div className="hidden border-b border-borda px-4 py-4 lg:block">
            <p className="text-sm font-semibold leading-tight">Gerenciador</p>
            <p className="text-xs text-suave">de Redes Sociais</p>
          </div>

          {/* Seletor de organização: uma agência costuma ter várias. */}
          {sessao.organizations.length > 1 && (
            <div className="border-b border-borda p-3">
              <label htmlFor="org" className="mb-1 block text-xs font-medium text-suave">
                Organização
              </label>
              <select
                id="org"
                className="campo py-1.5 text-xs"
                value={sessao.currentOrganizationId}
                onChange={(evento) => {
                  // Trocar de organização emite um token novo com o papel
                  // daquela organização — o papel muda entre elas.
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
                <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-suave">
                  {grupo}
                </p>
                <ul className="space-y-0.5">
                  {itensVisiveis
                    .filter((item) => item.grupo === grupo)
                    .map((item) => {
                      const ativo = pathname === item.href || pathname.startsWith(`${item.href}/`);

                      return (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            onClick={() => setMenuAberto(false)}
                            aria-current={ativo ? 'page' : undefined}
                            className={clsx(
                              'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition',
                              ativo
                                ? 'bg-fundo font-medium text-texto'
                                : 'text-suave hover:bg-fundo hover:text-texto',
                            )}
                          >
                            <span aria-hidden="true" className="w-4 text-center">
                              {item.icone}
                            </span>
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
                <p className="truncate text-sm font-medium">{sessao.user.name}</p>
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
                <Botao variante="secundaria" className="w-full">
                  Perfil
                </Botao>
              </Link>
              <Botao
                variante="fantasma"
                onClick={() => {
                  void sair().then(() => router.replace('/entrar'));
                }}
              >
                Sair
              </Botao>
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
