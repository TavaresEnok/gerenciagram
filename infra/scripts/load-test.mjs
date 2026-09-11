#!/usr/bin/env node
/**
 * Teste de carga contra os alvos da SPEC seção 2.
 *
 *   node infra/scripts/load-test.mjs [http://localhost:3001]
 *
 * O que este script mede, e o que ele NÃO mede:
 *
 *   ✔ p95 dos endpoints SÍNCRONOS da API sob concorrência — o alvo de ~300ms.
 *   ✔ latência de entrega da fila: quanto tempo passa entre o instante
 *     agendado e o worker receber o job.
 *   ✘ o tempo total de uma publicação real. Esse depende da API da rede
 *     social (upload de vídeo leva minutos) e não é um número que este
 *     sistema controle — medi-lo aqui daria uma cifra sem significado.
 *
 * O cenário é montado com dados REAIS no banco: um cliente, N contas
 * conectadas e um conteúdo com mídia. Contas precisam de token OAuth, que não
 * dá para obter num script — então elas são inseridas direto pelo Prisma. É o
 * suficiente para o caminho de LEITURA e de VALIDAÇÃO, que é o que se está
 * medindo; nada aqui publica, e as contas não têm token nenhum.
 *
 * O banco é o MESMO que a API sob teste usa (`DATABASE_URL`) — medir contra
 * um banco diferente daquele que responde as requisições não mediria nada.
 * Tudo que o script cria fica dentro de uma organização própria, com sufixo
 * aleatório, e nada existente é apagado ou alterado. Ainda assim ele se
 * recusa a rodar com `APP_ENV=production`: carga sintética em base de
 * produção é problema, não medição.
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config as loadEnv } from 'dotenv';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

const BASE = process.argv[2] ?? 'http://localhost:3001';

/** Alvos da SPEC seção 2. */
const ALVO_P95_MS = 300;
const ALVO_FILA_MS = 3 * 60_000; // "poucos minutos"

/** Perfil da carga. */
const CONTAS = Number(process.env.LOAD_ACCOUNTS ?? 20);
const CONCORRENCIA = Number(process.env.LOAD_CONCURRENCY ?? 20);
const REQUISICOES_POR_ENDPOINT = Number(process.env.LOAD_REQUESTS ?? 200);
const AQUECIMENTO = 20;

let accessToken = null;
let falhas = 0;

// ---------------------------------------------------------------------------
//  HTTP
// ---------------------------------------------------------------------------

async function chamar(caminho, opcoes = {}) {
  const headers = { Accept: 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (opcoes.body) headers['Content-Type'] = 'application/json';

  const inicio = performance.now();
  const resposta = await fetch(`${BASE}${caminho}`, {
    method: opcoes.method ?? (opcoes.body ? 'POST' : 'GET'),
    headers,
    ...(opcoes.body ? { body: JSON.stringify(opcoes.body) } : {}),
  });

  const texto = await resposta.text();
  const duracaoMs = performance.now() - inicio;

  return {
    status: resposta.status,
    duracaoMs,
    dados: texto ? JSON.parse(texto) : null,
  };
}

// ---------------------------------------------------------------------------
//  Estatística
// ---------------------------------------------------------------------------

/**
 * Percentil pelo método do índice mais próximo, sobre a amostra ordenada.
 * Simples de conferir à mão — o que importa aqui é não errar o número, não
 * interpolar com elegância.
 */
function percentil(amostraOrdenada, p) {
  if (amostraOrdenada.length === 0) return 0;
  const indice = Math.ceil((p / 100) * amostraOrdenada.length) - 1;
  return amostraOrdenada[Math.min(Math.max(indice, 0), amostraOrdenada.length - 1)];
}

function resumir(duracoes) {
  const ordenado = [...duracoes].sort((a, b) => a - b);
  return {
    n: ordenado.length,
    media: ordenado.reduce((soma, valor) => soma + valor, 0) / ordenado.length,
    p50: percentil(ordenado, 50),
    p95: percentil(ordenado, 95),
    p99: percentil(ordenado, 99),
    max: ordenado[ordenado.length - 1],
  };
}

const ms = (valor) => `${valor.toFixed(0).padStart(5)}ms`;

// ---------------------------------------------------------------------------
//  Carga
// ---------------------------------------------------------------------------

/**
 * Dispara `total` requisições mantendo `concorrencia` em voo.
 *
 * Um laço sequencial mediria a latência de uma API ociosa, que é o número
 * fácil e inútil: o p95 que interessa é o de quando há fila no event loop.
 */
async function medir(rotulo, fabricar, total, concorrencia) {
  // Aquecimento NA MESMA CONCORRÊNCIA da medição.
  //
  // Aquecer em série era um erro sutil: o pool do Prisma cresce sob demanda,
  // então 20 requisições sequenciais abrem 1 ou 2 conexões e as 20 primeiras
  // concorrentes abrem as outras 18 de uma vez — uma delas levando ~2s. O
  // resultado aparecia como cauda de latência do endpoint (p99 de 2,1s só no
  // PRIMEIRO endpoint medido), quando era custo de abrir conexão.
  await Promise.all(
    Array.from({ length: concorrencia }, async () => {
      for (let i = 0; i < Math.ceil(AQUECIMENTO / concorrencia); i += 1) await fabricar();
    }),
  );

  const duracoes = [];
  const erros = new Map();
  let emitidas = 0;

  async function trabalhador() {
    while (emitidas < total) {
      emitidas += 1;
      const resultado = await fabricar();
      duracoes.push(resultado.duracaoMs);

      if (resultado.status >= 400) {
        erros.set(resultado.status, (erros.get(resultado.status) ?? 0) + 1);
      }
    }
  }

  const inicio = performance.now();
  await Promise.all(Array.from({ length: concorrencia }, () => trabalhador()));
  const decorridoS = (performance.now() - inicio) / 1000;

  const stats = resumir(duracoes);

  // 429 aqui NÃO é defeito: é o rate limiter da própria API fazendo o que deve.
  // Mas uma resposta "limite excedido" custa quase nada e derrubaria o p95
  // artificialmente — medir com ela dentro daria um número bonito e falso.
  if (erros.has(429)) {
    console.error(
      `\n  ✗ ${rotulo}: o rate limiter da API barrou ${erros.get(429)} requisições.\n` +
        `    O limite atual (RATE_LIMIT_MAX=${process.env.RATE_LIMIT_MAX ?? 300} por ` +
        `${Number(process.env.RATE_LIMIT_WINDOW ?? 60000) / 1000}s, por usuário) é menor que\n` +
        `    a carga deste teste. Suba o limite no .env do ambiente de teste, reinicie a\n` +
        `    API e rode de novo — ou reduza LOAD_REQUESTS.`,
    );
    falhas += 1;
    return stats;
  }

  const passou = stats.p95 <= ALVO_P95_MS && erros.size === 0;
  if (!passou) falhas += 1;

  console.log(
    `  ${passou ? '✓' : '✗'} ${rotulo.padEnd(34)} ` +
      `p50 ${ms(stats.p50)}  p95 ${ms(stats.p95)}  p99 ${ms(stats.p99)}  ` +
      `max ${ms(stats.max)}  ${(stats.n / decorridoS).toFixed(0).padStart(4)} req/s` +
      (erros.size > 0
        ? `  ERROS: ${[...erros].map(([status, n]) => `${n}×${status}`).join(' ')}`
        : ''),
  );

  return stats;
}

// ---------------------------------------------------------------------------
//  Cenário
// ---------------------------------------------------------------------------

async function montarCenario() {
  // pathToFileURL é obrigatório no Windows: um caminho absoluto como
  // C:\... não é URL válida para o carregador ESM.
  const { PrismaClient } = await import(
    pathToFileURL(path.join(repoRoot, 'packages', 'db', 'dist', 'index.js')).href
  );

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL não definida — sem ela não há como montar o cenário.');
    process.exit(1);
  }

  if ((process.env.APP_ENV ?? '').toLowerCase() === 'production') {
    console.error(
      'APP_ENV=production. Este script cria uma organização e dispara centenas de ' +
        'requisições; rodá-lo contra produção é injetar carga sintética em cima de ' +
        'clientes reais. Aponte para um ambiente de teste.',
    );
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasources: { db: { url } } });

  const sufixo = randomUUID().slice(0, 8);
  const email = `carga-${sufixo}@exemplo.invalid`;
  const senha = 'SenhaDeCarga#2026';

  const cadastro = await chamar('/v1/auth/register', {
    body: {
      name: 'Teste de carga',
      email,
      password: senha,
      organizationName: `Agência de carga ${sufixo}`,
    },
  });

  if (cadastro.status !== 201 && cadastro.status !== 200) {
    console.error('Não foi possível cadastrar o usuário de carga:', cadastro.dados);
    process.exit(1);
  }

  const login = await chamar('/v1/auth/login', { body: { email, password: senha } });
  accessToken = login.dados?.accessToken;

  if (!accessToken) {
    console.error('Login do usuário de carga não devolveu token:', login.dados);
    process.exit(1);
  }

  const organizationId = cadastro.dados.organizationId;

  const cliente = await chamar('/v1/clients', {
    body: { name: 'Cliente de carga', timezone: 'America/Sao_Paulo' },
  });
  const clientId = cliente.dados?.id;

  const grupo = await chamar('/v1/groups', { body: { name: 'Grupo de carga', accountIds: [] } });
  const groupId = grupo.dados?.id;

  // --- Contas conectadas ---------------------------------------------------
  // Inseridas pelo Prisma porque conectar de verdade exige OAuth. Nada aqui
  // publica: as contas existem para que preview e validação trabalhem sobre
  // um volume realista.
  const accountIds = [];
  for (let indice = 0; indice < CONTAS; indice += 1) {
    const conta = await prisma.socialAccount.create({
      data: {
        organizationId,
        clientId,
        platform: 'YOUTUBE',
        remoteId: `carga-${sufixo}-${indice}`,
        nickname: `Canal de carga ${indice + 1}`,
        remoteDisplayName: `Canal de carga ${indice + 1}`,
        timezone: 'America/Sao_Paulo',
        status: 'ACTIVE',
      },
    });

    await prisma.accountGroupMember.create({
      data: { organizationId, accountGroupId: groupId, socialAccountId: conta.id },
    });

    accountIds.push(conta.id);
  }

  const midia = await prisma.mediaAsset.create({
    data: {
      organizationId,
      clientId,
      filename: 'carga.mp4',
      originalFilename: 'carga.mp4',
      mimeType: 'video/mp4',
      type: 'VIDEO',
      sizeBytes: BigInt(5_000_000),
      storageKey: `carga/${sufixo}.mp4`,
      checksum: randomUUID().replace(/-/g, ''),
      width: 1920,
      height: 1080,
      durationMs: 60_000,
      processingStatus: 'READY',
    },
  });

  const conteudo = await chamar('/v1/contents', {
    body: {
      title: 'Conteúdo de carga',
      body: 'Corpo do conteúdo usado no teste de carga.',
      hashtags: ['carga'],
      clientId,
      mediaAssetIds: [midia.id],
    },
  });

  await prisma.$disconnect();

  return { organizationId, clientId, groupId, accountIds, contentId: conteudo.dados?.id };
}

// ---------------------------------------------------------------------------
//  Latência de entrega da fila
// ---------------------------------------------------------------------------

/**
 * Mede quanto tempo passa entre o instante agendado e o worker receber o job.
 *
 * Usa uma fila própria (`load-test`) para não injetar lixo na fila de
 * publicação, mas o mesmo Redis e o mesmo BullMQ — que é onde mora o atraso
 * que se quer medir. O que vem DEPOIS (chamar a API da rede) não é medido
 * aqui de propósito: depende da plataforma remota, não deste sistema.
 */
async function medirFila() {
  // O pnpm não iça bullmq para o node_modules da raiz; resolver a partir do
  // package.json do worker é o que encontra a mesma versão que ele usa.
  const require = createRequire(path.join(repoRoot, 'apps', 'worker', 'package.json'));
  const { Queue, Worker } = await import(pathToFileURL(require.resolve('bullmq')).href);

  const conexao = { url: process.env.REDIS_URL ?? 'redis://localhost:6380', maxRetriesPerRequest: null };
  const prefixo = `${process.env.QUEUE_PREFIX ?? 'grs'}-load`;
  const nome = 'load-test';

  const fila = new Queue(nome, { connection: conexao, prefix: prefixo });
  const atrasos = [];
  const TOTAL = 50;

  const concluido = new Promise((resolve) => {
    const worker = new Worker(
      nome,
      async (job) => {
        atrasos.push(Date.now() - job.data.devidoEm);
        if (atrasos.length === TOTAL) {
          setImmediate(() => void worker.close().then(resolve));
        }
      },
      { connection: conexao, prefix: prefixo, concurrency: 10 },
    );
  });

  // Atrasos escalonados: medir 50 jobs todos para o mesmo instante mediria a
  // vazão de um pico artificial, não a pontualidade do agendamento.
  for (let indice = 0; indice < TOTAL; indice += 1) {
    const atrasoMs = 1000 + (indice % 10) * 200;
    await fila.add(
      'probe',
      { devidoEm: Date.now() + atrasoMs },
      { delay: atrasoMs, removeOnComplete: true, removeOnFail: true },
    );
  }

  const limite = setTimeout(() => {
    console.error('  ✗ a fila não entregou os jobs em 60s');
    process.exit(1);
  }, 60_000);
  limite.unref();

  await concluido;
  clearTimeout(limite);

  await fila.obliterate({ force: true }).catch(() => undefined);
  await fila.close();

  return resumir(atrasos);
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`Teste de carga contra ${BASE}`);
  console.log(
    `Perfil: ${CONTAS} contas · ${CONCORRENCIA} requisições em voo · ` +
      `${REQUISICOES_POR_ENDPOINT} por endpoint\n`,
  );

  const cenario = await montarCenario();
  console.log(`Cenário montado: ${cenario.accountIds.length} contas num grupo.\n`);

  console.log(`Endpoints síncronos (alvo: p95 ≤ ${ALVO_P95_MS}ms)`);

  await medir('GET /dashboard', () => chamar('/v1/dashboard'), REQUISICOES_POR_ENDPOINT, CONCORRENCIA);
  await medir('GET /posts', () => chamar('/v1/posts?limit=50'), REQUISICOES_POR_ENDPOINT, CONCORRENCIA);
  await medir('GET /contents', () => chamar('/v1/contents?limit=50'), REQUISICOES_POR_ENDPOINT, CONCORRENCIA);
  await medir('GET /accounts', () => chamar('/v1/accounts'), REQUISICOES_POR_ENDPOINT, CONCORRENCIA);
  await medir('GET /groups', () => chamar('/v1/groups'), REQUISICOES_POR_ENDPOINT, CONCORRENCIA);
  await medir(
    'GET /analytics/overview',
    () => chamar('/v1/analytics/overview?from=2026-01-01&to=2026-12-31'),
    REQUISICOES_POR_ENDPOINT,
    CONCORRENCIA,
  );
  await medir(
    'POST /groups/resolve',
    () => chamar('/v1/groups/resolve', { body: { groupIds: [cenario.groupId] } }),
    REQUISICOES_POR_ENDPOINT,
    CONCORRENCIA,
  );

  // O mais pesado da API: resolve o grupo, valida CADA destino (mídia, cota,
  // conteúdo duplicado, campos obrigatórios) e converte fuso por conta.
  await medir(
    `POST /posts/preview (${CONTAS} destinos)`,
    () =>
      chamar('/v1/posts/preview', {
        body: {
          contentId: cenario.contentId,
          selection: { groupIds: [cenario.groupId] },
          schedule: { mode: 'SPECIFIC_TIME', localDateTime: '2030-01-01T10:00' },
        },
      }),
    REQUISICOES_POR_ENDPOINT,
    CONCORRENCIA,
  );

  console.log(`\nEntrega da fila (alvo: dentro de ${ALVO_FILA_MS / 60_000} min do horário)`);
  const fila = await medirFila();
  const filaOk = fila.p95 <= ALVO_FILA_MS;
  if (!filaOk) falhas += 1;

  console.log(
    `  ${filaOk ? '✓' : '✗'} ${'atraso após o horário agendado'.padEnd(34)} ` +
      `p50 ${ms(fila.p50)}  p95 ${ms(fila.p95)}  max ${ms(fila.max)}`,
  );

  console.log(
    falhas === 0
      ? '\nTodos os alvos da SPEC seção 2 foram atingidos.'
      : `\n${falhas} alvo(s) não atingido(s).`,
  );

  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((erro) => {
  console.error('\nFalha no teste de carga:', erro);
  process.exit(1);
});
