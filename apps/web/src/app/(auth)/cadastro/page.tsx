'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Aviso, Botao, Campo, Cartao, Selecao } from '@/components/ui';
import { ApiError, api, definirToken } from '@/lib/api';

/**
 * Cadastro + onboarding numa tela só.
 *
 * Criar a conta e a organização juntas evita o estado intermediário de um
 * usuário sem organização, que nenhuma tela do produto sabe representar.
 */

const FUSOS_BRASIL = [
  { valor: 'America/Sao_Paulo', rotulo: 'Brasília (UTC-3) — SP, RJ, MG, DF...' },
  { valor: 'America/Manaus', rotulo: 'Manaus (UTC-4) — AM, RR, RO, MT...' },
  { valor: 'America/Rio_Branco', rotulo: 'Rio Branco (UTC-5) — AC' },
  { valor: 'America/Belem', rotulo: 'Belém (UTC-3) — PA, AP' },
  { valor: 'America/Fortaleza', rotulo: 'Fortaleza (UTC-3) — CE, PI, RN, PB...' },
  { valor: 'America/Noronha', rotulo: 'Fernando de Noronha (UTC-2)' },
  { valor: 'Europe/Lisbon', rotulo: 'Lisboa (UTC+0/+1)' },
  { valor: 'America/New_York', rotulo: 'Nova York (UTC-5/-4)' },
];

export default function PaginaCadastro() {
  const router = useRouter();

  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [organizacao, setOrganizacao] = useState('');
  const [fuso, setFuso] = useState('America/Sao_Paulo');
  const [erro, setErro] = useState<string | null>(null);
  const [problemas, setProblemas] = useState<string[]>([]);
  const [enviando, setEnviando] = useState(false);

  async function cadastrar(evento: React.FormEvent) {
    evento.preventDefault();
    setErro(null);
    setProblemas([]);
    setEnviando(true);

    try {
      await api('/v1/auth/register', {
        method: 'POST',
        body: {
          name: nome,
          email,
          password: senha,
          organizationName: organizacao,
          timezone: fuso,
        },
      });

      // Login imediato: o e-mail de confirmação chega, mas não trava o acesso.
      const sessao = await api<{ accessToken?: string }>('/v1/auth/login', {
        method: 'POST',
        body: { email, password: senha },
      });

      if (sessao.accessToken) {
        definirToken(sessao.accessToken);
        router.replace('/painel');
      } else {
        router.replace('/entrar');
      }
    } catch (caught) {
      if (caught instanceof ApiError) {
        setErro(caught.message);

        const detalhes = caught.details as { problems?: string[] } | undefined;
        if (detalhes?.problems) setProblemas(detalhes.problems);

        const porCampo = Object.values(caught.problemasPorCampo);
        if (porCampo.length > 0) setProblemas(porCampo);
      } else {
        setErro('Não foi possível criar a conta.');
      }
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Cartao titulo="Criar conta" descricao="Você também cria sua organização neste passo.">
      <form onSubmit={cadastrar} className="space-y-4">
        {erro && (
          <Aviso tom="erro">
            {erro}
            {problemas.length > 0 && (
              <ul className="mt-1.5 list-inside list-disc space-y-0.5">
                {problemas.map((problema) => (
                  <li key={problema}>{problema}</li>
                ))}
              </ul>
            )}
          </Aviso>
        )}

        <Campo
          rotulo="Seu nome"
          name="nome"
          value={nome}
          onChange={(evento) => setNome(evento.target.value)}
          autoComplete="name"
          required
          minLength={2}
          autoFocus
        />

        <Campo
          rotulo="E-mail"
          type="email"
          name="email"
          value={email}
          onChange={(evento) => setEmail(evento.target.value)}
          autoComplete="email"
          required
        />

        <Campo
          rotulo="Senha"
          type="password"
          name="senha"
          value={senha}
          onChange={(evento) => setSenha(evento.target.value)}
          autoComplete="new-password"
          required
          minLength={12}
          dica="Pelo menos 12 caracteres. Comprimento protege mais que símbolos."
        />

        <Campo
          rotulo="Nome da organização"
          name="organizacao"
          value={organizacao}
          onChange={(evento) => setOrganizacao(evento.target.value)}
          required
          minLength={2}
          dica="Sua agência ou empresa. Dá para renomear depois."
        />

        <Selecao
          rotulo="Fuso horário padrão"
          name="fuso"
          value={fuso}
          onChange={(evento) => setFuso(evento.target.value)}
          dica="Cada conta conectada pode ter o próprio fuso — este é só o padrão."
        >
          {FUSOS_BRASIL.map((opcao) => (
            <option key={opcao.valor} value={opcao.valor}>
              {opcao.rotulo}
            </option>
          ))}
        </Selecao>

        <Botao type="submit" variante="primaria" carregando={enviando} className="w-full">
          Criar conta
        </Botao>

        <p className="text-center text-sm text-suave">
          Já tem conta?{' '}
          <Link href="/entrar" className="text-texto underline">
            Entrar
          </Link>
        </p>
      </form>
    </Cartao>
  );
}
