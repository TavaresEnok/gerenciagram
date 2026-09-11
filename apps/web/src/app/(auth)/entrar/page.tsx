'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Aviso, Botao, Campo, Cartao } from '@/components/ui';
import { ApiError, api, definirToken } from '@/lib/api';

/**
 * Login em duas etapas quando há 2FA.
 *
 * A resposta do backend diz qual etapa vem a seguir (`mfa_required`), em vez
 * de a tela adivinhar pelo cadastro — o front nunca sabe se uma conta existe
 * ou tem 2FA antes de a senha estar correta.
 */

type Etapa = 'CREDENCIAIS' | 'SEGUNDO_FATOR';

interface RespostaSessao {
  accessToken?: string;
  expiresIn?: number;
  organizationId?: string;
  status?: 'mfa_required' | 'no_organization';
  challengeToken?: string;
}

export default function PaginaEntrar() {
  const router = useRouter();

  const [etapa, setEtapa] = useState<Etapa>('CREDENCIAIS');
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [codigo, setCodigo] = useState('');
  const [desafio, setDesafio] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function entrar(evento: React.FormEvent) {
    evento.preventDefault();
    setErro(null);
    setEnviando(true);

    try {
      const resposta = await api<RespostaSessao>('/v1/auth/login', {
        method: 'POST',
        body: { email, password: senha },
      });

      if (resposta.status === 'mfa_required' && resposta.challengeToken) {
        setDesafio(resposta.challengeToken);
        setEtapa('SEGUNDO_FATOR');
        return;
      }

      if (resposta.status === 'no_organization') {
        setErro(
          'Sua conta não está vinculada a nenhuma organização ativa. ' +
            'Peça um novo convite a quem administra a organização.',
        );
        return;
      }

      if (resposta.accessToken) {
        definirToken(resposta.accessToken);
        router.replace('/painel');
      }
    } catch (caught) {
      setErro(caught instanceof ApiError ? caught.message : 'Não foi possível entrar.');
    } finally {
      setEnviando(false);
    }
  }

  async function confirmarSegundoFator(evento: React.FormEvent) {
    evento.preventDefault();
    setErro(null);
    setEnviando(true);

    try {
      const resposta = await api<RespostaSessao>('/v1/auth/login/mfa', {
        method: 'POST',
        body: { challengeToken: desafio, code: codigo },
      });

      if (resposta.accessToken) {
        definirToken(resposta.accessToken);
        router.replace('/painel');
      }
    } catch (caught) {
      setErro(caught instanceof ApiError ? caught.message : 'Código inválido.');
    } finally {
      setEnviando(false);
    }
  }

  if (etapa === 'SEGUNDO_FATOR') {
    return (
      <Cartao titulo="Verificação em duas etapas">
        <form onSubmit={confirmarSegundoFator} className="space-y-4">
          <p className="text-sm text-suave">
            Digite o código de 6 dígitos do seu aplicativo autenticador. Você também pode usar
            um dos códigos de recuperação.
          </p>

          {erro && <Aviso tom="erro">{erro}</Aviso>}

          <Campo
            rotulo="Código"
            name="codigo"
            value={codigo}
            onChange={(evento) => setCodigo(evento.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
            maxLength={20}
          />

          <Botao type="submit" variante="primaria" carregando={enviando} className="w-full">
            Confirmar
          </Botao>

          <Botao
            type="button"
            variante="fantasma"
            className="w-full"
            onClick={() => {
              setEtapa('CREDENCIAIS');
              setCodigo('');
              setErro(null);
            }}
          >
            Voltar
          </Botao>
        </form>
      </Cartao>
    );
  }

  return (
    <Cartao titulo="Entrar">
      <form onSubmit={entrar} className="space-y-4">
        {erro && <Aviso tom="erro">{erro}</Aviso>}

        <Campo
          rotulo="E-mail"
          type="email"
          name="email"
          value={email}
          onChange={(evento) => setEmail(evento.target.value)}
          autoComplete="email"
          required
          autoFocus
        />

        <Campo
          rotulo="Senha"
          type="password"
          name="senha"
          value={senha}
          onChange={(evento) => setSenha(evento.target.value)}
          autoComplete="current-password"
          required
        />

        <Botao type="submit" variante="primaria" carregando={enviando} className="w-full">
          Entrar
        </Botao>

        <div className="flex items-center justify-between text-sm">
          <Link href="/recuperar-senha" className="text-suave hover:text-texto">
            Esqueci minha senha
          </Link>
          <Link href="/cadastro" className="text-suave hover:text-texto">
            Criar conta
          </Link>
        </div>
      </form>
    </Cartao>
  );
}
