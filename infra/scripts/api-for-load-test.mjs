#!/usr/bin/env node
/**
 * Sobe uma instância da API dedicada à medição de carga.
 *
 *   node infra/scripts/api-for-load-test.mjs
 *
 * Existe por dois motivos:
 *
 *  - o `dist/main.js` não carrega o `.env` sozinho (quem faz isso é o script
 *    de dev), então rodá-lo direto morre na validação de configuração;
 *  - o rate limiter da API (300 req/min por usuário, e está certo assim) é
 *    menor que a carga do teste. Medir com ele no caminho mediria o limiter,
 *    não o p95 dos endpoints.
 *
 * Sobe na porta 3002 para não encostar na instância de desenvolvimento.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config as loadEnv } from 'dotenv';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

process.env.API_PORT = process.env.LOAD_API_PORT ?? '3002';
process.env.RATE_LIMIT_MAX = '1000000';
process.env.LOG_LEVEL = 'warn';

await import(pathToFileURL(path.join(repoRoot, 'apps', 'api', 'dist', 'main.js')).href);
