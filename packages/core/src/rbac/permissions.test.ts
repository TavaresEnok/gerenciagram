import { describe, expect, it } from 'vitest';
import {
  canAccessClient,
  filterAccountsUserCanPublishTo,
  permissionsForRole,
  roleHasPermission,
} from './permissions.js';

describe('papéis', () => {
  it('Owner tem tudo que Admin tem, mais billing e exclusão da organização', () => {
    const owner = permissionsForRole('OWNER');
    const admin = permissionsForRole('ADMIN');

    for (const permission of admin) expect(owner.has(permission)).toBe(true);

    expect(roleHasPermission('OWNER', 'org:manage_billing')).toBe(true);
    expect(roleHasPermission('ADMIN', 'org:manage_billing')).toBe(false);
  });

  it('Approver decide aprovação mas não agenda nem publica', () => {
    expect(roleHasPermission('APPROVER', 'approval:decide')).toBe(true);
    expect(roleHasPermission('APPROVER', 'post:schedule')).toBe(false);
    expect(roleHasPermission('APPROVER', 'account:publish')).toBe(false);
  });

  it('Editor cria conteúdo mas não publica sozinho', () => {
    expect(roleHasPermission('EDITOR', 'content:create')).toBe(true);
    expect(roleHasPermission('EDITOR', 'post:create')).toBe(true);
    expect(roleHasPermission('EDITOR', 'post:schedule')).toBe(false);
    expect(roleHasPermission('EDITOR', 'account:publish')).toBe(false);
  });

  it('Analyst lê métricas mas não toca em conteúdo', () => {
    expect(roleHasPermission('ANALYST', 'analytics:read')).toBe(true);
    expect(roleHasPermission('ANALYST', 'content:create')).toBe(false);
    expect(roleHasPermission('ANALYST', 'media:upload')).toBe(false);
  });

  it('quem pode gerar relatório também pode lê-lo', () => {
    // Gerar sem poder listar nem baixar deixaria o arquivo inalcançável.
    for (const role of ['MANAGER', 'ADMIN', 'OWNER', 'ANALYST'] as const) {
      if (roleHasPermission(role, 'report:generate')) {
        expect(roleHasPermission(role, 'report:read')).toBe(true);
      }
    }
  });

  it('Viewer não escreve nada', () => {
    const viewer = permissionsForRole('VIEWER');
    for (const permission of viewer) {
      expect(permission.endsWith(':read')).toBe(true);
    }
  });

  it('nenhum papel de tenant acessa o painel admin da plataforma', () => {
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'EDITOR', 'APPROVER', 'ANALYST', 'VIEWER'] as const) {
      expect(roleHasPermission(role, 'platform_admin:access')).toBe(false);
    }
  });
});

describe('escopo por cliente', () => {
  it('lista vazia significa acesso a todos os clientes', () => {
    expect(canAccessClient([], 'qualquer')).toBe(true);
  });

  it('lista preenchida restringe', () => {
    expect(canAccessClient(['c1', 'c2'], 'c1')).toBe(true);
    expect(canAccessClient(['c1', 'c2'], 'c3')).toBe(false);
  });
});

describe('grupo nunca concede permissão (SPEC seção 5)', () => {
  const accounts = [
    { accountId: 'a1', clientId: 'c1' },
    { accountId: 'a2', clientId: 'c2' },
    { accountId: 'a3', clientId: 'c1' },
  ];

  it('inclui só as contas em que o usuário pode publicar e devolve as excluídas', () => {
    const result = filterAccountsUserCanPublishTo(accounts, 'MANAGER', ['c1']);

    expect(result.allowed.map((a) => a.accountId)).toEqual(['a1', 'a3']);
    expect(result.denied).toHaveLength(1);
    expect(result.denied[0]?.account.accountId).toBe('a2');
    expect(result.denied[0]?.reason).toContain('outros clientes');
  });

  it('papel sem permissão de publicar exclui todas, com motivo', () => {
    const result = filterAccountsUserCanPublishTo(accounts, 'EDITOR', []);

    expect(result.allowed).toEqual([]);
    expect(result.denied).toHaveLength(3);
    expect(result.denied[0]?.reason).toContain('EDITOR');
  });

  it('grupo com conta sem permissão não derruba o agendamento inteiro', () => {
    // Cenário obrigatório da SPEC seção 21.
    const result = filterAccountsUserCanPublishTo(accounts, 'MANAGER', ['c1']);
    expect(result.allowed.length).toBeGreaterThan(0);
    expect(result.denied.length).toBeGreaterThan(0);
  });
});
