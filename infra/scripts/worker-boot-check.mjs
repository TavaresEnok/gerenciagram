#!/usr/bin/env node
/**
 * Sobe o worker com o .env carregado, confere que ele registrou as filas e os
 * jobs periódicos, e encerra.
 *
 *   node infra/scripts/worker-boot-check.mjs
 *
 * Existe porque `main.ts` é o único arquivo do worker que nenhum teste
 * automatizado toca: os testes exercitam os processadores diretamente. Um erro
 * de fiação ali — job periódico registrado na fila errada, import quebrado —
 * só apareceria em produção, na forma de um job que nunca roda.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config as loadEnv } from 'dotenv';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';

/**
 * Jobs periódicos que o worker DEVE registrar: fila, NOME do job e intervalo.
 *
 * A conferência é pelo nome e pelo padrão, nunca pela chave: no BullMQ 5 a
 * chave do repeatable é um hash, e comparar contra ela dá falso negativo.
 */
const ESPERADOS = [
  ['token-refresh', 'scan-expiring-tokens', '*/30 * * * *'],
  ['inbox-sync', 'inbox:scan-accounts', '*/15 * * * *'],
  ['maintenance', 'maintenance:evaluate-alerts', '*/5 * * * *'],
  ['maintenance', 'maintenance:reconcile-orphans', '*/2 * * * *'],
  ['maintenance', 'apply-retention', '0 3 * * *'],
];

await import(pathToFileURL(path.join(repoRoot, 'apps', 'worker', 'dist', 'main.js')).href);

// O worker registra os agendadores durante o boot; esperar é mais honesto do
// que sondar num laço apertado e concluir cedo demais.
await new Promise((resolve) => setTimeout(resolve, 5000));

const { createRequire } = await import('node:module');
const require = createRequire(path.join(repoRoot, 'apps', 'worker', 'package.json'));
const { Queue } = await import(pathToFileURL(require.resolve('bullmq')).href);

const conexao = { url: process.env.REDIS_URL, maxRetriesPerRequest: null };
const prefixo = process.env.QUEUE_PREFIX ?? 'grs';

let falhas = 0;

for (const [nomeFila, nomeJob, padrao] of ESPERADOS) {
  const fila = new Queue(nomeFila, { connection: conexao, prefix: prefixo });
  const repetiveis = await fila.getRepeatableJobs();
  const job = repetiveis.find((item) => item.name === nomeJob);

  const ok = job !== undefined && job.pattern === padrao;
  console.log(
    `  ${ok ? '✓' : '✗'} ${nomeFila.padEnd(14)} ${nomeJob.padEnd(30)} ${job?.pattern ?? 'AUSENTE'}`,
  );
  if (!ok) falhas += 1;

  await fila.close();
}

console.log(
  falhas === 0
    ? '\nTodos os jobs periódicos foram registrados.'
    : `\n${falhas} job(s) periódico(s) não registrado(s).`,
);

process.exit(falhas === 0 ? 0 : 1);
