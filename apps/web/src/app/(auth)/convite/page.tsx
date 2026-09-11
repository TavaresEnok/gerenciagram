'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Aviso, Botao, Campo, Cartao, Carregando } from '@/components/ui';
import { ApiError, api } from '@/lib/api';

export default function PaginaConvite() {
  return (
    <Suspense fallback={<Carregando />}>
      <Formulario />
    </Suspense>
  );
}

function Formulario() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';

  // Quem já tem conta apenas aceita; quem não tem cria a conta aqui mesmo.
  // O backend trata os dois casos no mesmo endpoint.
  const [jaTenhoConta, setJaTenhoConta] = useState(false);
  const [nome, setNome] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function aceitar(evento: React.FormEvent) {
    evento.preventDefault();
    setErro(null);
    setEnviando(true);

    try {
      await api('/v1/auth/invite/accept', {
        method: 'POST',
        body: jaTenhoConta ? { token } : { token, name: nome, password: senha },
      });

      router.replace('/entrar');
    } catch (caught) {
      setErro(
        caught instanceof ApiError ? caught.message : 'Não foi possível aceitar o convite.',
      );
    } finally {
      setEnviando(false);
    }
  }

  if (!token) {
    return (
      <Cartao titulo="Convite inválido">
        <Aviso tom="erro">Este link não tem o código do convite. Peça um novo.</Aviso>
      </Cartao>
    );
  }

  return (
    <Cartao titulo="Aceitar convite">
      <form onSubmit={aceitar} className="space-y-4">
        {erro && <Aviso tom="erro">{erro}</Aviso>}

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={jaTenhoConta}
            onChange={(evento) => setJaTenhoConta(evento.target.checked)}
          />
          Já tenho uma conta com este e-mail
        </label>

        {!jaTenhoConta && (
          <>
            <Campo
              rotulo="Seu nome"
              value={nome}
              onChange={(evento) => setNome(evento.target.value)}
              autoComplete="name"
              required
              minLength={2}
            />
            <Campo
              rotulo="Crie uma senha"
              type="password"
              value={senha}
              onChange={(evento) => setSenha(evento.target.value)}
              autoComplete="new-password"
              required
              minLength={12}
              dica="Pelo menos 12 caracteres."
            />
          </>
        )}

        <Botao type="submit" variante="primaria" carregando={enviando} className="w-full">
          Aceitar convite
        </Botao>
      </form>
    </Cartao>
  );
}
