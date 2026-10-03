'use client';

import clsx from 'clsx';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

/**
 * Primitivas de interface.
 *
 * Escritas à mão em vez de instaladas via CLI de biblioteca: são poucas, o
 * projeto controla o markup inteiro, e cada uma carrega as garantias de
 * acessibilidade que o produto precisa (rótulo associado, erro anunciado,
 * estado de carregamento com `aria-busy`).
 */

// ---------------------------------------------------------------------------

type Variante = 'primaria' | 'secundaria' | 'perigo' | 'fantasma';

export function Botao({
  variante = 'secundaria',
  carregando = false,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variante?: Variante;
  carregando?: boolean;
}) {
  const estilos: Record<Variante, string> = {
    primaria: 'bg-primaria text-primaria-texto hover:opacity-90',
    secundaria: 'border border-borda bg-superficie text-texto hover:bg-fundo',
    perigo: 'bg-erro text-white hover:opacity-90',
    fantasma: 'text-suave hover:bg-fundo hover:text-texto',
  };

  return (
    <button
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium',
        'transition disabled:cursor-not-allowed disabled:opacity-50',
        estilos[variante],
        className,
      )}
      disabled={disabled || carregando}
      aria-busy={carregando}
      {...props}
    >
      {carregando && (
        <span
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      )}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------

export function Campo({
  rotulo,
  erro,
  dica,
  className,
  id,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  rotulo: string;
  erro?: string | undefined;
  dica?: string | undefined;
}) {
  const idCampo = id ?? `campo-${props.name ?? rotulo.toLowerCase().replace(/\s/g, '-')}`;

  return (
    <div className="space-y-1.5">
      <label htmlFor={idCampo} className="rotulo">
        {rotulo}
        {props.required && <span className="ml-0.5 text-erro">*</span>}
      </label>

      <input
        id={idCampo}
        className={clsx('campo', erro && 'border-erro', className)}
        aria-invalid={erro ? true : undefined}
        aria-describedby={erro ? `${idCampo}-erro` : dica ? `${idCampo}-dica` : undefined}
        {...props}
      />

      {dica && !erro && (
        <p id={`${idCampo}-dica`} className="text-xs text-suave">
          {dica}
        </p>
      )}
      {erro && (
        <p id={`${idCampo}-erro`} role="alert" className="text-xs text-erro">
          {erro}
        </p>
      )}
    </div>
  );
}

export function AreaTexto({
  rotulo,
  erro,
  dica,
  contador,
  limite,
  className,
  id,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  rotulo: string;
  erro?: string | undefined;
  dica?: string | undefined;
  contador?: number | undefined;
  limite?: number | undefined;
}) {
  const idCampo = id ?? `area-${props.name ?? rotulo.toLowerCase().replace(/\s/g, '-')}`;
  const excedeu = limite !== undefined && contador !== undefined && contador > limite;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={idCampo} className="rotulo">
          {rotulo}
        </label>
        {limite !== undefined && contador !== undefined && (
          <span className={clsx('text-xs tabular-nums', excedeu ? 'text-erro' : 'text-suave')}>
            {contador}/{limite}
          </span>
        )}
      </div>

      <textarea
        id={idCampo}
        className={clsx('campo min-h-24 resize-y', (erro || excedeu) && 'border-erro', className)}
        aria-invalid={erro || excedeu ? true : undefined}
        {...props}
      />

      {dica && !erro && <p className="text-xs text-suave">{dica}</p>}
      {erro && (
        <p role="alert" className="text-xs text-erro">
          {erro}
        </p>
      )}
    </div>
  );
}

export function Selecao({
  rotulo,
  erro,
  dica,
  className,
  id,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  rotulo: string;
  erro?: string | undefined;
  dica?: string | undefined;
}) {
  const idCampo = id ?? `selecao-${props.name ?? rotulo.toLowerCase().replace(/\s/g, '-')}`;

  return (
    <div className="space-y-1.5">
      <label htmlFor={idCampo} className="rotulo">
        {rotulo}
        {props.required && <span className="ml-0.5 text-erro">*</span>}
      </label>

      <select
        id={idCampo}
        className={clsx('campo', erro && 'border-erro', className)}
        aria-invalid={erro ? true : undefined}
        {...props}
      >
        {children}
      </select>

      {dica && !erro && <p className="text-xs text-suave">{dica}</p>}
      {erro && (
        <p role="alert" className="text-xs text-erro">
          {erro}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Cartao({
  titulo,
  descricao,
  acoes,
  children,
  className,
}: {
  titulo?: ReactNode;
  descricao?: ReactNode;
  acoes?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx('cartao', className)}>
      {(titulo || acoes) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-borda px-4 py-3">
          <div className="min-w-0">
            {titulo && <h2 className="text-sm font-semibold text-texto">{titulo}</h2>}
            {descricao && <p className="mt-0.5 text-xs text-suave">{descricao}</p>}
          </div>
          {acoes && <div className="flex shrink-0 items-center gap-2">{acoes}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

type TomEtiqueta = 'neutro' | 'sucesso' | 'alerta' | 'erro' | 'info';

export function Etiqueta({
  tom = 'neutro',
  children,
  titulo,
}: {
  tom?: TomEtiqueta;
  children: ReactNode;
  titulo?: string;
}) {
  const estilos: Record<TomEtiqueta, string> = {
    neutro: 'bg-fundo text-suave border-borda',
    sucesso: 'bg-sucesso/10 text-sucesso border-sucesso/30',
    alerta: 'bg-alerta/10 text-alerta border-alerta/30',
    erro: 'bg-erro/10 text-erro border-erro/30',
    info: 'bg-primaria/10 text-texto border-borda',
  };

  return (
    <span
      title={titulo}
      className={clsx(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium',
        estilos[tom],
      )}
    >
      {children}
    </span>
  );
}

/** Estados de publicação e seus tons — usado no calendário, fila e detalhe. */
export function EtiquetaStatus({ status }: { status: string }) {
  const mapa: Record<string, { rotulo: string; tom: TomEtiqueta }> = {
    DRAFT: { rotulo: 'Rascunho', tom: 'neutro' },
    IN_REVIEW: { rotulo: 'Em revisão', tom: 'info' },
    APPROVED: { rotulo: 'Aprovado', tom: 'info' },
    SCHEDULED: { rotulo: 'Agendado', tom: 'info' },
    QUEUED: { rotulo: 'Na fila', tom: 'info' },
    PUBLISHING: { rotulo: 'Publicando', tom: 'alerta' },
    PROCESSING: { rotulo: 'Processando na rede', tom: 'alerta' },
    PUBLISHED: { rotulo: 'Publicado', tom: 'sucesso' },
    PARTIALLY_PUBLISHED: { rotulo: 'Publicado em parte', tom: 'alerta' },
    FAILED: { rotulo: 'Falhou', tom: 'erro' },
    CANCELLED: { rotulo: 'Cancelado', tom: 'neutro' },
    PENDING: { rotulo: 'Pendente', tom: 'neutro' },
    SKIPPED: { rotulo: 'Ignorado', tom: 'neutro' },
    ACTIVE: { rotulo: 'Ativa', tom: 'sucesso' },
    NEEDS_RECONNECT: { rotulo: 'Reconectar', tom: 'erro' },
    DISCONNECTED: { rotulo: 'Desconectada', tom: 'neutro' },
    SUSPENDED: { rotulo: 'Suspensa', tom: 'erro' },
  };

  const info = mapa[status] ?? { rotulo: status, tom: 'neutro' as TomEtiqueta };
  return <Etiqueta tom={info.tom}>{info.rotulo}</Etiqueta>;
}

// ---------------------------------------------------------------------------

export function Aviso({
  tom = 'info',
  titulo,
  children,
}: {
  tom?: 'info' | 'alerta' | 'erro' | 'sucesso';
  titulo?: ReactNode;
  children: ReactNode;
}) {
  const estilos = {
    info: 'border-borda bg-fundo text-texto',
    alerta: 'border-alerta/30 bg-alerta/10 text-texto',
    erro: 'border-erro/30 bg-erro/10 text-texto',
    sucesso: 'border-sucesso/30 bg-sucesso/10 text-texto',
  };

  return (
    <div
      role={tom === 'erro' ? 'alert' : 'status'}
      className={clsx('rounded-lg border px-3.5 py-3 text-sm', estilos[tom])}
    >
      {titulo && <p className="mb-1 font-medium">{titulo}</p>}
      <div className="text-sm leading-relaxed">{children}</div>
    </div>
  );
}

export function Vazio({
  titulo,
  descricao,
  acao,
}: {
  titulo: string;
  descricao?: string;
  acao?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-borda px-6 py-12 text-center">
      <p className="text-sm font-medium text-texto">{titulo}</p>
      {descricao && <p className="max-w-md text-sm text-suave">{descricao}</p>}
      {acao && <div className="mt-2">{acao}</div>}
    </div>
  );
}

export function Carregando({ rotulo = 'Carregando...' }: { rotulo?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-suave" role="status">
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        aria-hidden="true"
      />
      {rotulo}
    </div>
  );
}

export function Metrica({
  rotulo,
  valor,
  detalhe,
  tom,
}: {
  rotulo: string;
  valor: ReactNode;
  detalhe?: ReactNode;
  tom?: 'sucesso' | 'erro' | 'alerta';
}) {
  const cor =
    tom === 'sucesso'
      ? 'text-sucesso'
      : tom === 'erro'
        ? 'text-erro'
        : tom === 'alerta'
          ? 'text-alerta'
          : 'text-texto';

  return (
    <div className="cartao p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-suave">{rotulo}</p>
      <p className={clsx('mt-1 text-2xl font-semibold tabular-nums', cor)}>{valor}</p>
      {detalhe && <p className="mt-1 text-xs text-suave">{detalhe}</p>}
    </div>
  );
}

/** Modal simples com fechamento por Esc e clique fora. */
export function Modal({
  aberto,
  aoFechar,
  titulo,
  children,
  largura = 'md',
}: {
  aberto: boolean;
  aoFechar: () => void;
  titulo: string;
  children: ReactNode;
  largura?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  if (!aberto) return null;

  const larguras = {
    sm: 'max-w-md',
    md: 'max-w-2xl',
    lg: 'max-w-4xl',
    xl: 'max-w-6xl',
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={titulo}
      onClick={(evento) => {
        if (evento.target === evento.currentTarget) aoFechar();
      }}
      onKeyDown={(evento) => {
        if (evento.key === 'Escape') aoFechar();
      }}
    >
      <div className={clsx('w-full cartao shadow-xl', larguras[largura])}>
        <header className="flex items-center justify-between border-b border-borda px-4 py-3">
          <h2 className="text-sm font-semibold">{titulo}</h2>
          <Botao variante="fantasma" onClick={aoFechar} aria-label="Fechar">
            ✕
          </Botao>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
