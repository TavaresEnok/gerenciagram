import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Configuração flat compartilhada (ESLint 9).
 *
 * Aplica-se a API, worker e pacotes — TypeScript/Node. O Next (apps/web) tem
 * a própria configuração (eslint-config-next), que sobrepõe esta no diretório
 * dele. Regras no nível "recommended" de propósito: este repositório passa
 * por `--max-warnings 0`, então o que não é defeito para nós não entra aqui.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/generated/**',
      '**/coverage/**',
      'infra/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Padrão do repositório: casts intencionais em fronteira (jobs do
      // BullMQ, payloads) e `any` controlado em dublês de teste. O que o typecheck
      // garante não precisa virar ruído de lint.
      '@typescript-eslint/no-explicit-any': 'off',
      // `catch (e)` sem uso do `e` e prefixo `_` para intencionalmente não usado.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // require() aparece só em scripts CommonJS de infra.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Testes: os dublês de fila/adapter vivem de casts não-null e any.
    files: ['**/*.test.ts', '**/test/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
