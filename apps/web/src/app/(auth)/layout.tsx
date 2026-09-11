import Link from 'next/link';
import type { ReactNode } from 'react';

export default function LayoutAutenticacao({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-fundo p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <Link href="/" className="text-lg font-semibold">
            Gerenciador de Redes Sociais
          </Link>
          <p className="mt-1 text-sm text-suave">
            Conteúdo, agendamento e métricas para várias contas por rede.
          </p>
        </div>

        {children}
      </div>
    </div>
  );
}
