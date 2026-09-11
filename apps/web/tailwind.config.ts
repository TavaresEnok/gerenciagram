import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Tokens em CSS variables para o tema claro/escuro trocar sem
        // duplicar cada classe.
        borda: 'rgb(var(--borda) / <alpha-value>)',
        fundo: 'rgb(var(--fundo) / <alpha-value>)',
        superficie: 'rgb(var(--superficie) / <alpha-value>)',
        texto: 'rgb(var(--texto) / <alpha-value>)',
        suave: 'rgb(var(--suave) / <alpha-value>)',
        primaria: 'rgb(var(--primaria) / <alpha-value>)',
        'primaria-texto': 'rgb(var(--primaria-texto) / <alpha-value>)',
        sucesso: 'rgb(var(--sucesso) / <alpha-value>)',
        alerta: 'rgb(var(--alerta) / <alpha-value>)',
        erro: 'rgb(var(--erro) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
