import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

/**
 * O `.env` vive na RAIZ do monorepo, não dentro deste pacote: as mesmas
 * credenciais são usadas pela API, pelo worker e pelas migrations, e manter
 * cópias sincronizadas em três lugares é como se acaba rodando migration
 * contra o banco errado.
 */
const packageDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packageDir, '..', '..');

loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

export default defineConfig({
  schema: path.join(packageDir, 'prisma', 'schema.prisma'),
  migrations: {
    seed: 'tsx src/seed.ts',
  },
});
