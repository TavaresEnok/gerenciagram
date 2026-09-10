#!/usr/bin/env node
/**
 * Cria uma migration a partir do diff entre o banco atual e o schema.
 *
 * Por que não `prisma migrate dev`: ele exige TTY interativo e falha em CI,
 * em container e em qualquer automação. Este script faz o mesmo caminho —
 * gera o SQL do delta, grava a pasta da migration e aplica com
 * `migrate deploy` — sem prompt.
 *
 *   node infra/scripts/new-migration.mjs nome_da_migration [--dry-run]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dbDir = path.join(repoRoot, 'packages', 'db');
const migrationsDir = path.join(dbDir, 'prisma', 'migrations');
/**
 * O pnpm instala o binário no `node_modules/.bin` do PACOTE que o declara, e
 * no Windows o executável é um `.CMD`. Procurar nos dois lugares evita
 * depender do layout do gerenciador ou do sistema operacional.
 */
const prismaBin = (() => {
  const suffixes = process.platform === 'win32' ? ['.CMD', '.cmd', ''] : [''];
  const bases = [
    path.join(dbDir, 'node_modules', '.bin', 'prisma'),
    path.join(repoRoot, 'node_modules', '.bin', 'prisma'),
  ];

  for (const base of bases) {
    for (const suffix of suffixes) {
      if (existsSync(base + suffix)) return base + suffix;
    }
  }

  console.error(
    'Não encontrei o binário do Prisma. Rode `pnpm install` na raiz do repositório.',
  );
  process.exit(1);
})();

const name = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!name || !/^[a-z0-9_]+$/.test(name)) {
  console.error('Uso: node infra/scripts/new-migration.mjs <nome_em_snake_case> [--dry-run]');
  process.exit(1);
}

function prisma(args) {
  return execFileSync(prismaBin, args, {
    cwd: dbDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // O Node 25 recusa executar um `.CMD` sem shell (EINVAL). Nenhum
    // argumento aqui contém espaço, então o shell é seguro neste caso.
    shell: process.platform === 'win32',
  });
}

console.log('Comparando o banco atual com o schema...');

const sql = prisma([
  'migrate',
  'diff',
  '--from-schema-datasource',
  'prisma/schema.prisma',
  '--to-schema-datamodel',
  'prisma/schema.prisma',
  '--script',
]);

const trimmed = sql.trim();

if (trimmed.length === 0 || /^--\s*This is an empty migration/i.test(trimmed)) {
  console.log('Nada a migrar: o banco já está em sincronia com o schema.');
  process.exit(0);
}

console.log('\n--- SQL gerado ---\n' + trimmed + '\n');

if (dryRun) {
  console.log('--dry-run: nada foi gravado nem aplicado.');
  process.exit(0);
}

// Carimbo no mesmo formato do Prisma (UTC), para a ordenação bater.
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const dir = path.join(migrationsDir, `${stamp}_${name}`);

if (existsSync(dir)) {
  console.error(`A migration ${dir} já existe.`);
  process.exit(1);
}

mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'migration.sql'), trimmed + '\n', 'utf8');
console.log(`Migration gravada em prisma/migrations/${stamp}_${name}/`);

console.log('Aplicando com migrate deploy...');
process.stdout.write(prisma(['migrate', 'deploy']));

console.log('Regenerando o Prisma Client...');
try {
  prisma(['generate']);
  console.log('Pronto.');
} catch (error) {
  // No Windows, a API ou o worker em execução mantêm o engine query
  // (.dll.node) aberto, e o Prisma não consegue substituí-lo. A migration já
  // foi gravada e aplicada; só a regeneração dos tipos ficou pendente.
  const message = String(error?.stderr ?? error?.message ?? error);
  if (message.includes('EPERM')) {
    console.warn(
      '\nA migration foi aplicada, mas o Prisma Client NÃO pôde ser regenerado:\n' +
        'um processo em execução (API ou worker) está com o engine aberto.\n' +
        'Pare esses processos e rode:  pnpm db:generate',
    );
    process.exitCode = 0;
  } else {
    throw error;
  }
}
