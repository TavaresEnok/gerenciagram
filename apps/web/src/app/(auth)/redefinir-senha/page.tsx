'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Aviso, Botao, Campo, Cartao, Carregando } from '@/components/ui';
import { ApiError, api } from '@/lib/api';

export default function PaginaRedefinirSenha() {
  return (
    <Suspense fallback={<Carregando />}>
      <Formulario />
    </Suspense>
  );
}

function Formulario() {
  const parametros = useSearchParams();
  const token = parametros.get('token') ?? '';

  const [senha, setSenha] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [problemas, setProblemas] = useState<string[]>([]);
  const [pronto, setPronto] = useState(false);
  const [enviando, setEnviando] = useState(false);

  async function redefinir(evento: React.FormEvent) {
    evento.preventDefault();
    setErro(null);
    setProblemas([]);

    if (senha !== confirmacao) {
      setErro('As duas senhas não conferem.');
      return;
    }

    setEnviando(true);

    try {
      await api('/v1/auth/password/reset', {
        method: 'POST',
        body: { token, newPassword: senha },
      });
      setPronto(true);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setErro(caught.message);
        const detalhes = caught.details as { problems?: string[] } | undefined;
        if (detalhes?.problems) setProblemas(detalhes.problems);
      } else {
        setErro('Não foi possível redefinir a senha.');
      }
    } finally {
      setEnviando(false);
    }
  }

  if (!token) {
    return (
      <Cartao titulo="Link inválido">
        <Aviso tom="erro">
          Este link não tem o código de verificação. Solicite um novo na tela de recuperação.
        </Aviso>
      </Cartao>
    );
  }

  if (pronto) {
    return (
      <Cartao titulo="Senha redefinida">
        <Aviso tom="sucesso">
          Sua senha foi alterada e todas as sessões anteriores foram encerradas por segurança.
        </Aviso>
        <div className="mt-4">
          <Link href="/entrar">
            <Botao variante="primaria" className="w-full">
              Entrar com a nova senha
            </Botao>
          </Link>
        </div>
      </Cartao>
    );
  }

  return (
    <Cartao titulo="Criar nova senha">
      <form onSubmit={redefinir} className="space-y-4">
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
          rotulo="Nova senha"
          type="password"
          value={senha}
          onChange={(evento) => setSenha(evento.target.value)}
          autoComplete="new-password"
          required
          minLength={12}
          dica="Pelo menos 12 caracteres."
          autoFocus
        />

        <Campo
          rotulo="Confirme a nova senha"
          type="password"
          value={confirmacao}
          onChange={(evento) => setConfirmacao(evento.target.value)}
          autoComplete="new-password"
          required
        />

        <Botao type="submit" variante="primaria" carregando={enviando} className="w-full">
          Redefinir senha
        </Botao>
      </form>
    </Cartao>
  );
}
