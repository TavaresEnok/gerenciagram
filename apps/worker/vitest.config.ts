import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'vitest/config';

/**
 * Os testes do worker rodam contra Postgres e Redis DE VERDADE (os do
 * docker compose), num banco separado.
 *
 * Mockar o banco esconderia justamente o que precisa ser provado: que a
 * UNIQUE por destino impede a publicação dupla, que o UPDATE condicional
 * resolve a corrida entre dois workers e que o incremento de cota é atômico.
 * Nada disso existe num banco falso.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

if (!process.env['DATABASE_URL_TEST']) {
  throw new Error(
    'DATABASE_URL_TEST não definida. Crie o banco de teste e aplique as migrations ' +
      '(ver README > Testes).',
  );
}

process.env['DATABASE_URL'] = process.env['DATABASE_URL_TEST'];
process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'error';

export default defineConfig({
  test: {
    environment: 'node',
    // O banco é compartilhado entre os arquivos de teste; rodar em paralelo
    // faria um truncar as tabelas enquanto o outro escreve.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
