'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Aviso, Botao, Campo, Cartao } from '@/components/ui';
import { api } from '@/lib/api';

export default function PaginaRecuperarSenha() {
  const [email, setEmail] = useState('');
  const [enviado, setEnviado] = useState(false);
  const [enviando, setEnviando] = useState(false);

  async function solicitar(evento: React.FormEvent) {
    evento.preventDefault();
    setEnviando(true);

    // O backend responde 204 exista ou não a conta — e a tela repete essa
    // discrição. Dizer "e-mail não encontrado" transformaria esta página num
    // verificador público de cadastro.
    await api('/v1/auth/password/forgot', { method: 'POST', body: { email } }).catch(
      () => undefined,
    );

    setEnviado(true);
    setEnviando(false);
  }

  if (enviado) {
    return (
      <Cartao titulo="Verifique seu e-mail">
        <Aviso tom="sucesso">
          Se existir uma conta com <strong>{email}</strong>, enviamos um link para redefinir a
          senha. Ele vale por 1 hora.
        </Aviso>
        <div className="mt-4">
          <Link href="/entrar">
            <Botao variante="secundaria" className="w-full">
              Voltar para o login
            </Botao>
          </Link>
        </div>
      </Cartao>
    );
  }

  return (
    <Cartao titulo="Recuperar senha">
      <form onSubmit={solicitar} className="space-y-4">
        <p className="text-sm text-suave">
          Informe o e-mail da sua conta. Enviaremos um link para você criar uma senha nova.
        </p>

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

        <Botao type="submit" variante="primaria" carregando={enviando} className="w-full">
          Enviar link
        </Botao>

        <p className="text-center text-sm">
          <Link href="/entrar" className="text-suave hover:text-texto">
            Voltar para o login
          </Link>
        </p>
      </form>
    </Cartao>
  );
}
