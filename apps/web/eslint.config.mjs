import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';

/**
 * Lint do web (Next 15.5 + ESLint 9).
 *
 * `next lint` está deprecado e sem configuração caía em prompt interativo —
 * que foi como o lint do repo inteiro ficou quebrado sem ninguém notar.
 * `eslint-config-next` 15.x ainda publica o formato legado; o FlatCompat faz
 * a ponte para a configuração flat aqui.
 */
const compat = new FlatCompat({
  baseDirectory: path.dirname(fileURLToPath(import.meta.url)),
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default [
  {
    ignores: ['.next/**', 'node_modules/**', 'out/**', 'next-env.d.ts'],
  },
  ...compat.config({ extends: ['next/core-web-vitals', 'next/typescript'] }),
  {
    // Arquivos de configuração do próprio Next/PostCSS/ESLint exportam o
    // objeto diretamente por convenção; o warning não é aplicável a eles.
    files: ['*.config.{js,mjs,ts}', 'eslint.config.mjs', 'postcss.config.mjs'],
    rules: { 'import/no-anonymous-default-export': 'off' },
  },
];
