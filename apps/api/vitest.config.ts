import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'vitest/config';

/**
 * Parte dos testes da API roda contra o Postgres DE VERDADE, no mesmo banco
 * de teste que o worker usa.
 *
 * O motivo é o mesmo de lá: o que precisa ser provado são garantias do banco.
 * Que a cópia de um post não compartilha a linha de `Content` com o original
 * só fica visível quando existem duas linhas separadas — num banco falso, as
 * duas afirmações passariam.
 *
 * Como o banco é o MESMO do worker, as duas suítes não podem rodar ao mesmo
 * tempo: cada uma trunca as tabelas no seu setup, e uma truncaria o banco no
 * meio da outra. O `turbo.json` encoda isso fazendo `@app/api#test` depender
 * de `@app/worker#test` (JSON não aceita comentário, por isso a explicação
 * mora aqui).
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
