'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  XCircle,
} from 'lucide-react';
import React, { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

export type ToastTipo = 'sucesso' | 'erro' | 'info' | 'alerta';

export interface ToastItem {
  id: string;
  tipo: ToastTipo;
  titulo: string;
  descricao?: string;
  duracaoMs?: number;
}

interface ToastContextValue {
  toast: (item: Omit<ToastItem, 'id'>) => void;
  sucesso: (titulo: string, descricao?: string) => void;
  erro: (titulo: string, descricao?: string) => void;
  info: (titulo: string, descricao?: string) => void;
  alerta: (titulo: string, descricao?: string) => void;
  remover: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast deve ser usado dentro de um <ToastProvider>');
  }
  return context;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const remover = useCallback((id: string) => {
    setToasts((atuais) => atuais.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    ({ tipo, titulo, descricao, duracaoMs = 5000 }: Omit<ToastItem, 'id'>) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const novoToast: ToastItem = { id, tipo, titulo, descricao, duracaoMs };

      setToasts((atuais) => [...atuais, novoToast]);

      if (duracaoMs > 0) {
        setTimeout(() => {
          remover(id);
        }, duracaoMs);
      }
    },
    [remover],
  );

  const sucesso = useCallback(
    (titulo: string, descricao?: string) => toast({ tipo: 'sucesso', titulo, descricao }),
    [toast],
  );

  const erro = useCallback(
    (titulo: string, descricao?: string) => toast({ tipo: 'erro', titulo, descricao }),
    [toast],
  );

  const info = useCallback(
    (titulo: string, descricao?: string) => toast({ tipo: 'info', titulo, descricao }),
    [toast],
  );

  const alerta = useCallback(
    (titulo: string, descricao?: string) => toast({ tipo: 'alerta', titulo, descricao }),
    [toast],
  );

  return (
    <ToastContext.Provider value={{ toast, sucesso, erro, info, alerta, remover }}>
      {children}
      <aside
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2 p-2 sm:p-0"
      >
        {toasts.map((item) => (
          <div
            key={item.id}
            role="alert"
            className="pointer-events-auto flex items-start gap-3 rounded-xl border border-borda bg-superficie/95 p-3.5 shadow-xl backdrop-blur-md transition-all duration-300 animate-in fade-in slide-in-from-bottom-3"
          >
            <div className="shrink-0 pt-0.5">
              {item.tipo === 'sucesso' && <CheckCircle2 className="h-5 w-5 text-sucesso" />}
              {item.tipo === 'erro' && <XCircle className="h-5 w-5 text-erro" />}
              {item.tipo === 'alerta' && <AlertTriangle className="h-5 w-5 text-alerta" />}
              {item.tipo === 'info' && <Info className="h-5 w-5 text-suave" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-texto">{item.titulo}</p>
              {item.descricao && (
                <p className="mt-0.5 text-xs text-suave leading-relaxed">{item.descricao}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => remover(item.id)}
              className="shrink-0 rounded-md p-1 text-suave transition hover:bg-fundo hover:text-texto"
              aria-label="Fechar notificação"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </aside>
    </ToastContext.Provider>
  );
}
