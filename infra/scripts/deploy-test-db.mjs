#!/usr/bin/env node
/**
 * Aplica as migrations no banco de TESTE.
 *
 * Existe porque o banco de teste é separado e fica para trás sempre que uma
 * migration nova é criada — e a falha resultante ("a coluna X não existe")
 * parece um bug no código, não um banco desatualizado.
 *
 *   pnpm db:deploy:test
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dbDir = path.join(repoRoot, 'packages', 'db');

loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

const url = process.env.DATABASE_URL_TEST;

if (!url) {
  console.error(
    'DATABASE_URL_TEST não está definida no .env.\n\n' +
      'Crie o banco de teste e acrescente a variável:\n' +
      '  docker exec gerenciador_postgres psql -U gerenciador -d postgres \\n' +
      '    -c "CREATE DATABASE gerenciador_test;"',
  );
  process.exit(1);
}

const prismaBin = (() => {
  const suffixes = process.platform === 'win32' ? ['.CMD', '.cmd', ''] : [''];
  for (const base of [
    path.join(dbDir, 'node_modules', '.bin', 'prisma'),
    path.join(repoRoot, 'node_modules', '.bin', 'prisma'),
  ]) {
    for (const suffix of suffixes) {
      if (existsSync(base + suffix)) return base + suffix;
    }
  }
  console.error('Binário do Prisma não encontrado. Rode `pnpm install`.');
  process.exit(1);
})();

console.log('Aplicando migrations no banco de teste...');

process.stdout.write(
  execFileSync(prismaBin, ['migrate', 'deploy'], {
    cwd: dbDir,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url },
    shell: process.platform === 'win32',
  }),
);
