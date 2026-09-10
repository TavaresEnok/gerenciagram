/**
 * RBAC (SPEC seção 5).
 *
 * Permissões são declaradas explicitamente por papel, não derivadas de uma
 * hierarquia numérica. Papéis reais não são uma linha reta: o Approver aprova
 * conteúdo mas não conecta contas; o Analyst lê métricas mas não vê rascunho.
 * Um esquema de "nível >= 3" erraria os dois casos.
 */

export const ROLES = [
  'OWNER',
  'ADMIN',
  'MANAGER',
  'EDITOR',
  'APPROVER',
  'ANALYST',
  'VIEWER',
] as const;

export type RoleName = (typeof ROLES)[number];

export const PERMISSIONS = [
  // Organização
  'org:read',
  'org:update',
  'org:delete',
  'org:manage_billing',
  'org:manage_members',
  'org:manage_roles',
  'org:view_audit_log',
  'org:request_data_deletion',

  // Clientes/Marcas
  'client:read',
  'client:create',
  'client:update',
  'client:delete',

  // Contas sociais
  'account:read',
  'account:connect',
  'account:update',
  'account:disconnect',
  /** Publicar POR ESTA CONTA. É a permissão que o grupo NÃO concede. */
  'account:publish',

  // Grupos de contas
  'group:read',
  'group:create',
  'group:update',
  'group:delete',

  // Mídia
  'media:read',
  'media:upload',
  'media:update',
  'media:delete',

  // Conteúdo e posts
  'content:read',
  'content:create',
  'content:update',
  'content:delete',
  'post:read',
  'post:create',
  'post:update',
  'post:delete',
  'post:schedule',
  'post:publish_now',
  'post:cancel',
  'post:retry',

  // Aprovação
  'approval:read',
  'approval:request',
  'approval:decide',
  'approval:comment',

  // Campanhas
  'campaign:read',
  'campaign:create',
  'campaign:update',
  'campaign:delete',

  // Analytics e relatórios
  'analytics:read',
  'report:read',
  'report:generate',

  // Inbox
  'inbox:read',
  'inbox:reply',

  // IA
  'ai:generate',

  // Painel admin da plataforma (dono do SaaS, fora do tenant)
  'platform_admin:access',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = [
  'org:read',
  'client:read',
  'account:read',
  'group:read',
  'media:read',
  'content:read',
  'post:read',
  'campaign:read',
  'approval:read',
];

const ANALYST: Permission[] = [
  ...VIEWER,
  'analytics:read',
  'report:read',
  'report:generate',
];

/**
 * Approver revisa e decide, e comenta — mas não cria nem edita conteúdo, e
 * não agenda. Separar "aprovar" de "publicar" é o ponto do workflow.
 */
const APPROVER: Permission[] = [
  ...VIEWER,
  'analytics:read',
  'report:read',
  'approval:decide',
  'approval:comment',
  'inbox:read',
];

const EDITOR: Permission[] = [
  ...VIEWER,
  'media:upload',
  'media:update',
  'content:create',
  'content:update',
  'post:create',
  'post:update',
  'approval:request',
  'approval:comment',
  'ai:generate',
  'inbox:read',
  'analytics:read',
];

/**
 * Manager é quem toca a operação do dia a dia: agenda, publica, cancela,
 * reprocessa, gerencia grupos e campanhas. Não mexe em membros nem billing.
 */
const MANAGER: Permission[] = [
  ...EDITOR,
  'client:create',
  'client:update',
  'account:connect',
  'account:update',
  'account:disconnect',
  'account:publish',
  'group:create',
  'group:update',
  'group:delete',
  'media:delete',
  'content:delete',
  'post:delete',
  'post:schedule',
  'post:publish_now',
  'post:cancel',
  'post:retry',
  'approval:decide',
  'campaign:create',
  'campaign:update',
  'campaign:delete',
  'report:generate',
  'inbox:reply',
];

const ADMIN: Permission[] = [
  ...MANAGER,
  'org:update',
  'org:manage_members',
  'org:manage_roles',
  'org:view_audit_log',
  'client:delete',
];

const OWNER: Permission[] = [
  ...ADMIN,
  'org:delete',
  'org:manage_billing',
  'org:request_data_deletion',
];

const ROLE_PERMISSIONS: Record<RoleName, ReadonlySet<Permission>> = {
  OWNER: new Set(OWNER),
  ADMIN: new Set(ADMIN),
  MANAGER: new Set(MANAGER),
  EDITOR: new Set(EDITOR),
  APPROVER: new Set(APPROVER),
  ANALYST: new Set(ANALYST),
  VIEWER: new Set(VIEWER),
};

export function permissionsForRole(role: RoleName): ReadonlySet<Permission> {
  return ROLE_PERMISSIONS[role];
}

export function roleHasPermission(role: RoleName, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/**
 * Escopo por cliente: um membro pode ser limitado a alguns Clients da
 * organização. Lista vazia = acesso a todos.
 */
export function canAccessClient(scopedClientIds: string[], clientId: string | null): boolean {
  if (scopedClientIds.length === 0) return true;
  if (clientId === null) return false;
  return scopedClientIds.includes(clientId);
}

/**
 * A regra que a SPEC seção 5 destaca: **grupo nunca concede permissão**.
 *
 * Ao resolver um grupo em destinos, o sistema fica só com as contas em que o
 * usuário pode publicar e devolve as excluídas para a UI mostrar quais
 * ficaram de fora — em vez de falhar o agendamento inteiro ou, pior,
 * publicar onde o usuário não podia.
 */
export interface AccountAccessInput {
  accountId: string;
  clientId: string;
}

export interface FilterAccessResult<T extends AccountAccessInput> {
  allowed: T[];
  denied: Array<{ account: T; reason: string }>;
}

export function filterAccountsUserCanPublishTo<T extends AccountAccessInput>(
  accounts: T[],
  role: RoleName,
  scopedClientIds: string[],
): FilterAccessResult<T> {
  const allowed: T[] = [];
  const denied: Array<{ account: T; reason: string }> = [];

  const canPublish = roleHasPermission(role, 'account:publish');

  for (const account of accounts) {
    if (!canPublish) {
      denied.push({
        account,
        reason: `Seu papel (${role}) não permite publicar em contas conectadas.`,
      });
      continue;
    }
    if (!canAccessClient(scopedClientIds, account.clientId)) {
      denied.push({
        account,
        reason: 'Seu acesso está limitado a outros clientes desta organização.',
      });
      continue;
    }
    allowed.push(account);
  }

  return { allowed, denied };
}
