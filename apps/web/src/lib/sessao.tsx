'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import useSWR, { type SWRConfiguration } from 'swr';
import { api, definirToken, restaurarSessao, sair as sairDaApi } from './api';

/**
 * Sessão do usuário no navegador.
 *
 * Ao montar, tenta restaurar a sessão pelo cookie httpOnly de refresh. É isso
 * que faz um F5 não jogar a pessoa para a tela de login — sem precisar
 * guardar token em localStorage, que qualquer XSS leria.
 */

export interface Usuario {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  timezone: string;
  locale: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
}

export interface OrganizacaoResumo {
  id: string;
  name: string;
  slug: string;
  role: string;
}

interface SessaoAtual {
  user: Usuario;
  currentOrganizationId: string;
  role: string;
  scopedClientIds: string[];
  mfaSatisfied: boolean;
  organizations: OrganizacaoResumo[];
}

interface ContextoSessao {
  carregando: boolean;
  sessao: SessaoAtual | null;
  entrar: (accessToken: string) => Promise<void>;
  sair: () => Promise<void>;
  recarregar: () => Promise<void>;
  /** Permissões do papel atual, para a UI esconder o que não pode ser feito. */
  pode: (permissao: string) => boolean;
}

const Contexto = createContext<ContextoSessao | null>(null);

/**
 * Espelho da tabela de permissões do backend.
 *
 * A autorização REAL acontece no servidor — isto aqui só decide o que
 * aparece na tela. Esconder um botão não é controle de acesso; o backend
 * recusa a chamada de qualquer jeito.
 */
const PERMISSOES_POR_PAPEL: Record<string, string[]> = {
  VIEWER: ['org:read', 'client:read', 'account:read', 'group:read', 'media:read', 'content:read', 'post:read', 'campaign:read', 'approval:read'],
  ANALYST: ['org:read', 'client:read', 'account:read', 'group:read', 'media:read', 'content:read', 'post:read', 'campaign:read', 'approval:read', 'analytics:read', 'report:read', 'report:generate'],
  APPROVER: ['org:read', 'client:read', 'account:read', 'group:read', 'media:read', 'content:read', 'post:read', 'campaign:read', 'approval:read', 'analytics:read', 'report:read', 'approval:decide', 'approval:comment', 'inbox:read'],
  EDITOR: ['org:read', 'client:read', 'account:read', 'group:read', 'media:read', 'media:upload', 'media:update', 'content:read', 'content:create', 'content:update', 'post:read', 'post:create', 'post:update', 'campaign:read', 'approval:read', 'approval:request', 'approval:comment', 'ai:generate', 'inbox:read', 'analytics:read'],
  MANAGER: ['org:read', 'client:read', 'client:create', 'client:update', 'account:read', 'account:connect', 'account:update', 'account:disconnect', 'account:publish', 'group:read', 'group:create', 'group:update', 'group:delete', 'media:read', 'media:upload', 'media:update', 'media:delete', 'content:read', 'content:create', 'content:update', 'content:delete', 'post:read', 'post:create', 'post:update', 'post:delete', 'post:schedule', 'post:publish_now', 'post:cancel', 'post:retry', 'campaign:read', 'campaign:create', 'campaign:update', 'campaign:delete', 'approval:read', 'approval:request', 'approval:decide', 'approval:comment', 'analytics:read', 'report:read', 'report:generate', 'inbox:read', 'inbox:reply', 'ai:generate'],
  ADMIN: [],
  OWNER: [],
};

// Admin herda Manager + gestão de membros; Owner herda Admin + billing.
PERMISSOES_POR_PAPEL['ADMIN'] = [
  ...(PERMISSOES_POR_PAPEL['MANAGER'] ?? []),
  'org:update',
  'org:manage_members',
  'org:manage_roles',
  'org:view_audit_log',
  'client:delete',
];
PERMISSOES_POR_PAPEL['OWNER'] = [
  ...(PERMISSOES_POR_PAPEL['ADMIN'] ?? []),
  'org:delete',
  'org:manage_billing',
  'org:request_data_deletion',
];

export function ProvedorSessao({ children }: { children: ReactNode }) {
  const [carregando, setCarregando] = useState(true);
  const [sessao, setSessao] = useState<SessaoAtual | null>(null);

  const carregarSessao = useCallback(async () => {
    try {
      const dados = await api<SessaoAtual>('/v1/auth/me');
      setSessao(dados);
    } catch {
      setSessao(null);
      definirToken(null);
    }
  }, []);

  useEffect(() => {
    let ativo = true;

    void (async () => {
      const restaurou = await restaurarSessao();
      if (!ativo) return;

      if (restaurou) await carregarSessao();
      if (ativo) setCarregando(false);
    })();

    return () => {
      ativo = false;
    };
  }, [carregarSessao]);

  const valor = useMemo<ContextoSessao>(
    () => ({
      carregando,
      sessao,
      entrar: async (accessToken: string) => {
        definirToken(accessToken);
        await carregarSessao();
      },
      sair: async () => {
        await sairDaApi();
        setSessao(null);
      },
      recarregar: carregarSessao,
      pode: (permissao: string) =>
        (PERMISSOES_POR_PAPEL[sessao?.role ?? ''] ?? []).includes(permissao),
    }),
    [carregando, sessao, carregarSessao],
  );

  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

export function useSessao(): ContextoSessao {
  const contexto = useContext(Contexto);
  if (!contexto) throw new Error('useSessao precisa estar dentro de <ProvedorSessao>');
  return contexto;
}

/** Redireciona para o login quando não há sessão. */
export function useExigirSessao(): ContextoSessao {
  const contexto = useSessao();
  const router = useRouter();

  useEffect(() => {
    if (!contexto.carregando && !contexto.sessao) router.replace('/entrar');
  }, [contexto.carregando, contexto.sessao, router]);

  return contexto;
}

// ---------------------------------------------------------------------------

/** `useSWR` já apontado para a API, com o tratamento de erro do projeto. */
export function useApi<T>(
  chave: string | null,
  opcoes?: SWRConfiguration<T>,
): {
  dados: T | undefined;
  erro: Error | undefined;
  carregando: boolean;
  recarregar: () => Promise<T | undefined>;
} {
  const { data, error, isLoading, mutate } = useSWR<T>(
    chave,
    (caminho: string) => api<T>(caminho),
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      ...opcoes,
    },
  );

  return {
    dados: data,
    erro: error as Error | undefined,
    carregando: isLoading,
    recarregar: () => mutate(),
  };
}
