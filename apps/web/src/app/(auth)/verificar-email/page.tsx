'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Aviso, Botao, Cartao, Carregando } from '@/components/ui';
import { ApiError, api } from '@/lib/api';

export default function PaginaVerificarEmail() {
  return (
    <Suspense fallback={<Carregando />}>
      <Verificacao />
    </Suspense>
  );
}

function Verificacao() {
  const token = useSearchParams().get('token') ?? '';
  const [estado, setEstado] = useState<'VERIFICANDO' | 'OK' | 'ERRO'>('VERIFICANDO');
  const [mensagem, setMensagem] = useState('');

  useEffect(() => {
    if (!token) {
      setEstado('ERRO');
      setMensagem('Este link não tem o código de verificação.');
      return;
    }

    void api('/v1/auth/verify-email', { method: 'POST', body: { token } })
      .then(() => setEstado('OK'))
      .catch((caught: unknown) => {
        setEstado('ERRO');
        setMensagem(
          caught instanceof ApiError ? caught.message : 'Não foi possível confirmar o e-mail.',
        );
      });
  }, [token]);

  if (estado === 'VERIFICANDO') {
    return (
      <Cartao titulo="Confirmando seu e-mail">
        <Carregando rotulo="Verificando..." />
      </Cartao>
    );
  }

  return (
    <Cartao titulo={estado === 'OK' ? 'E-mail confirmado' : 'Não foi possível confirmar'}>
      {estado === 'OK' ? (
        <Aviso tom="sucesso">
          Seu e-mail está confirmado. Agora você recebe os avisos de falha de publicação e de
          token expirado.
        </Aviso>
      ) : (
        <Aviso tom="erro">{mensagem}</Aviso>
      )}

      <div className="mt-4">
        <Link href="/painel">
          <Botao variante="primaria" className="w-full">
            Ir para o painel
          </Botao>
        </Link>
      </div>
    </Cartao>
  );
}
