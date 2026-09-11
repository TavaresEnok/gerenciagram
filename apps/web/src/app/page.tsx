'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Carregando } from '@/components/ui';
import { restaurarSessao } from '@/lib/api';

/**
 * Raiz: manda para o painel quem tem sessão viva, e para o login quem não tem.
 * A decisão sai da tentativa de renovar a sessão pelo cookie httpOnly.
 */
export default function PaginaRaiz() {
  const router = useRouter();

  useEffect(() => {
    void restaurarSessao().then((autenticado) => {
      router.replace(autenticado ? '/painel' : '/entrar');
    });
  }, [router]);

  return <Carregando />;
}
