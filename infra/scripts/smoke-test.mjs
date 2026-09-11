#!/usr/bin/env node
/**
 * Teste de fumaça contra a API em execução.
 *
 * Exercita o caso de uso de referência da SPEC seção 6.1 ponta a ponta, pela
 * mesma superfície HTTP que o frontend usa: cadastro, cliente, contas,
 * grupo, conteúdo, preview e validação por destino.
 *
 * Não substitui os testes automatizados — serve para confirmar que a API
 * montada está de pé e coerente depois de subir o ambiente.
 *
 *   node infra/scripts/smoke-test.mjs [http://localhost:3001]
 */

const BASE = process.argv[2] ?? 'http://localhost:3001';

let accessToken = null;
let falhas = 0;
let passos = 0;

function ok(mensagem, detalhe = '') {
  passos += 1;
  console.log(`  ✓ ${mensagem}${detalhe ? ` — ${detalhe}` : ''}`);
}

function falhou(mensagem, detalhe = '') {
  passos += 1;
  falhas += 1;
  console.log(`  ✗ ${mensagem}${detalhe ? ` — ${detalhe}` : ''}`);
}

async function chamar(caminho, opcoes = {}) {
  const headers = { Accept: 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (opcoes.body) headers['Content-Type'] = 'application/json';
  if (opcoes.idempotencyKey) headers['Idempotency-Key'] = opcoes.idempotencyKey;

  const resposta = await fetch(`${BASE}${caminho}`, {
    method: opcoes.method ?? (opcoes.body ? 'POST' : 'GET'),
    headers,
    ...(opcoes.body ? { body: JSON.stringify(opcoes.body) } : {}),
  });

  const texto = await resposta.text();
  const dados = texto ? JSON.parse(texto) : null;

  return { status: resposta.status, dados };
}

async function main() {
  console.log(`Teste de fumaça contra ${BASE}\n`);

  // --- Infraestrutura ------------------------------------------------------
  console.log('Infraestrutura');
  const saude = await chamar('/readyz');
  if (saude.status === 200 && saude.dados.status === 'ready') {
    const checks = saude.dados.checks;
    ok(
      'dependências respondendo',
      `banco ${checks.database.latencyMs}ms · redis ${checks.redis.latencyMs}ms · storage ${checks.storage.latencyMs}ms`,
    );
  } else {
    falhou('readyz', JSON.stringify(saude.dados));
    process.exit(1);
  }

  // --- Autenticação --------------------------------------------------------
  console.log('\nAutenticação');
  const email = `fumaca-${Date.now()}@exemplo.invalid`;
  const senha = 'uma-senha-de-teste-2026';

  const cadastro = await chamar('/v1/auth/register', {
    body: {
      email,
      password: senha,
      name: 'Teste de Fumaça',
      organizationName: `Fumaça ${Date.now()}`,
    },
  });
  cadastro.status === 201
    ? ok('cadastro cria usuário e organização')
    : falhou('cadastro', JSON.stringify(cadastro.dados));

  const senhaFraca = await chamar('/v1/auth/register', {
    body: { email: `x${Date.now()}@a.b`, password: 'senha123', name: 'X', organizationName: 'Y' },
  });
  senhaFraca.status === 422 || senhaFraca.status === 400
    ? ok('senha fraca é recusada')
    : falhou('senha fraca deveria ser recusada', String(senhaFraca.status));

  const login = await chamar('/v1/auth/login', { body: { email, password: senha } });
  if (login.status === 200 && login.dados.accessToken) {
    accessToken = login.dados.accessToken;
    ok('login devolve token de acesso');
  } else {
    falhou('login', JSON.stringify(login.dados));
    process.exit(1);
  }

  const inexistente = await chamar('/v1/auth/login', {
    body: { email: 'ninguem@exemplo.invalid', password: 'errada-errada-errada' },
  });
  const senhaErrada = await chamar('/v1/auth/login', { body: { email, password: 'errada-errada' } });
  inexistente.dados?.error?.message === senhaErrada.dados?.error?.message
    ? ok('e-mail inexistente e senha errada dão a MESMA resposta (sem enumeração)')
    : falhou('respostas de login diferem e permitem enumerar contas');

  const semToken = accessToken;
  accessToken = null;
  const protegido = await chamar('/v1/accounts');
  accessToken = semToken;
  protegido.status === 401
    ? ok('rota protegida recusa sem token')
    : falhou('rota protegida sem token', String(protegido.status));

  // --- Plataformas ---------------------------------------------------------
  console.log('\nPlataformas');
  const plataformas = await chamar('/v1/platforms');
  if (plataformas.status === 200) {
    const lista = plataformas.dados.platforms;
    const youtube = lista.find((p) => p.key === 'YOUTUBE');
    const kwai = lista.find((p) => p.key === 'KWAI');

    ok(`${lista.length} redes no catálogo`);

    youtube?.isAvailable
      ? ok('YouTube declarado implementado')
      : falhou('YouTube deveria estar implementado');

    kwai && !kwai.isAvailable && kwai.unavailableReason
      ? ok('Kwai indisponível com motivo explícito')
      : falhou('Kwai deveria estar indisponível com motivo');

    const semCredencial = lista.filter((p) => p.isAvailable && !p.credentialsConfigured);
    ok(
      'estado de credenciais reportado honestamente',
      semCredencial.length > 0
        ? `${semCredencial.map((p) => p.displayName).join(', ')} sem credenciais`
        : 'todas configuradas',
    );
  } else {
    falhou('listar plataformas', JSON.stringify(plataformas.dados));
  }

  // --- Cliente -------------------------------------------------------------
  console.log('\nCliente e contas');
  const cliente = await chamar('/v1/clients', {
    body: { name: 'Curiosidades', timezone: 'America/Sao_Paulo' },
  });
  cliente.status === 201
    ? ok('cliente criado', cliente.dados.slug)
    : falhou('criar cliente', JSON.stringify(cliente.dados));

  const clienteId = cliente.dados?.id;

  // Conectar conta exige credencial de plataforma — a recusa é o
  // comportamento correto quando o .env não tem as chaves.
  const oauth = await chamar('/v1/oauth/YOUTUBE/start', {
    body: { clientId: clienteId, nickname: 'YouTube 1 – Curiosidades' },
  });
  if (oauth.status === 503 && oauth.dados?.error?.code === 'PLATFORM_NOT_CONFIGURED') {
    ok('conectar conta recusa sem credenciais, com mensagem clara');
  } else if (oauth.status === 200 && oauth.dados?.authorizationUrl) {
    ok('conectar conta devolve URL de autorização e consentimento');
  } else {
    falhou('iniciar OAuth', JSON.stringify(oauth.dados));
  }

  const kwaiOauth = await chamar('/v1/oauth/KWAI/start', {
    body: { clientId: clienteId, nickname: 'Kwai 1' },
  });
  kwaiOauth.status === 422
    ? ok('conectar rede não implementada é recusado')
    : falhou('Kwai deveria ser recusado', String(kwaiOauth.status));

  // --- Grupos --------------------------------------------------------------
  console.log('\nGrupos e destinos');
  const grupo = await chamar('/v1/groups', {
    body: { name: 'Curiosidades', accountIds: [] },
  });
  grupo.status === 201
    ? ok('grupo criado')
    : falhou('criar grupo', JSON.stringify(grupo.dados));

  const resolucao = await chamar('/v1/groups/resolve', {
    body: { groupIds: [grupo.dados?.id] },
  });
  resolucao.status === 200 && Array.isArray(resolucao.dados.accounts)
    ? ok('resolução de destinos responde', `${resolucao.dados.accounts.length} conta(s)`)
    : falhou('resolver destinos', JSON.stringify(resolucao.dados));

  // --- Conteúdo e preview --------------------------------------------------
  console.log('\nConteúdo e validação');
  const conteudo = await chamar('/v1/contents', {
    body: { title: 'Teste de fumaça', body: 'Conteúdo de verificação.', hashtags: ['teste'] },
  });
  conteudo.status === 201
    ? ok('conteúdo mestre criado')
    : falhou('criar conteúdo', JSON.stringify(conteudo.dados));

  const preview = await chamar('/v1/posts/preview', {
    body: {
      contentId: conteudo.dados?.id,
      selection: { groupIds: [grupo.dados?.id] },
      schedule: { mode: 'SPECIFIC_TIME', localDateTime: '2030-01-01T10:00' },
    },
  });
  preview.status === 200
    ? ok('preview responde', `${preview.dados.summary.total} destino(s)`)
    : falhou('preview', JSON.stringify(preview.dados));

  // Sem destino nenhum, o agendamento tem que ser recusado — nunca criar um
  // post fantasma que não publica em lugar algum.
  const semDestino = await chamar('/v1/posts', {
    body: {
      contentId: conteudo.dados?.id,
      selection: { groupIds: [grupo.dados?.id] },
      schedule: { mode: 'SPECIFIC_TIME', localDateTime: '2030-01-01T10:00' },
    },
  });
  semDestino.status === 422
    ? ok('agendar sem destino é recusado')
    : falhou('agendamento sem destino deveria falhar', String(semDestino.status));

  // Reaproveitamento de conteúdo: aqui só dá para confirmar que a rota está
  // montada e escopada à organização — sem conta conectada não há publicação
  // real para duplicar. O comportamento da duplicação em si está coberto por
  // teste automatizado (apps/api/src/modules/posts/duplicate.test.ts).
  const duplicarInexistente = await chamar(
    '/v1/posts/00000000-0000-4000-8000-000000000000/duplicate',
    { body: {} },
  );
  duplicarInexistente.status === 404
    ? ok('duplicar publicação inexistente responde 404')
    : falhou('duplicar inexistente deveria dar 404', String(duplicarInexistente.status));

  // --- Idempotência --------------------------------------------------------
  console.log('\nOutros módulos');
  for (const [rotulo, caminho] of [
    ['dashboard', '/v1/dashboard'],
    ['fila', '/v1/posts?limit=5'],
    ['aprovações', '/v1/approvals?limit=5'],
    ['campanhas', '/v1/campaigns'],
    ['biblioteca', '/v1/media?limit=5'],
    ['analytics', '/v1/analytics/overview?from=2026-01-01&to=2026-12-31'],
    ['relatórios', '/v1/reports'],
    ['inbox', '/v1/inbox'],
    ['notificações', '/v1/notifications'],
    ['plano', '/v1/billing/subscription'],
    ['feature flags', '/v1/feature-flags'],
    ['organização', '/v1/organization'],
    ['membros', '/v1/organization/members'],
    ['auditoria', '/v1/organization/audit-log?limit=5'],
    ['status da IA', '/v1/ai/status'],
  ]) {
    const resposta = await chamar(caminho);
    resposta.status === 200
      ? ok(rotulo)
      : falhou(rotulo, `HTTP ${resposta.status} ${JSON.stringify(resposta.dados)}`);
  }

  // Painel admin: usuário comum NÃO pode acessar.
  const admin = await chamar('/v1/admin/overview');
  admin.status === 403
    ? ok('painel da plataforma recusa usuário comum')
    : falhou('painel admin deveria recusar', String(admin.status));

  // Webhook sem verificador implementado precisa recusar, não aceitar cego.
  const webhook = await chamar('/v1/webhooks/YOUTUBE', { body: { teste: true } });
  webhook.status === 501 || webhook.status === 401
    ? ok('webhook sem verificação de assinatura é recusado')
    : falhou('webhook deveria ser recusado', String(webhook.status));

  // --- Resultado -----------------------------------------------------------
  console.log(`\n${passos - falhas}/${passos} verificações passaram.`);
  if (falhas > 0) {
    console.log(`${falhas} falha(s).`);
    process.exit(1);
  }
}

main().catch((erro) => {
  console.error('\nErro inesperado no teste de fumaça:', erro);
  process.exit(1);
});
