'use client';

import { useState } from 'react';
import { Aviso, Botao, Campo, Cartao, Carregando, Etiqueta } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useSessao } from '@/lib/sessao';

/**
 * Perfil do usuário: senha, 2FA e sessões.
 *
 * O fluxo de 2FA tem uma etapa de confirmação de propósito: o segredo só vira
 * obrigatório depois que a pessoa prova que o app dela gera o código certo.
 * Ativar direto trancaria para fora quem escaneou o QR errado.
 */

export default function PaginaPerfil() {
  const { sessao, recarregar } = useSessao();

  const [mensagem, setMensagem] = useState<{ tom: 'sucesso' | 'erro'; texto: string } | null>(
    null,
  );

  if (!sessao) return <Carregando />;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Seu perfil</h1>
        <p className="mt-0.5 text-sm text-suave">
          {sessao.user.name} · {sessao.user.email}
        </p>
      </header>

      {mensagem && <Aviso tom={mensagem.tom}>{mensagem.texto}</Aviso>}

      {!sessao.user.emailVerified && (
        <Aviso tom="alerta" titulo="E-mail não confirmado">
          <p>
            Sem confirmar o e-mail, você não recebe avisos de falha de publicação nem de token
            expirado.
          </p>
          <Botao
            variante="secundaria"
            className="mt-2"
            onClick={() => {
              void api('/v1/auth/verify-email/resend', { method: 'POST' })
                .then(() =>
                  setMensagem({ tom: 'sucesso', texto: 'E-mail de confirmação reenviado.' }),
                )
                .catch(() =>
                  setMensagem({ tom: 'erro', texto: 'Não foi possível reenviar agora.' }),
                );
            }}
          >
            Reenviar confirmação
          </Botao>
        </Aviso>
      )}

      <TrocarSenha aoAvisar={setMensagem} />

      <DoisFatores
        ativo={sessao.user.twoFactorEnabled}
        aoAvisar={setMensagem}
        aoMudar={() => void recarregar()}
      />

      <Cartao titulo="Sessões">
        <p className="text-sm text-suave">
          Encerrar todas as sessões desconecta você de todos os navegadores e dispositivos,
          inclusive deste.
        </p>
        <Botao
          variante="perigo"
          className="mt-3"
          onClick={() => {
            void api<{ sessionsRevoked: number }>('/v1/auth/logout-all', { method: 'POST' })
              .then((resultado) => {
                setMensagem({
                  tom: 'sucesso',
                  texto: `${resultado.sessionsRevoked} sessão(ões) encerrada(s).`,
                });
                setTimeout(() => window.location.replace('/entrar'), 1500);
              })
              .catch(() =>
                setMensagem({ tom: 'erro', texto: 'Não foi possível encerrar as sessões.' }),
              );
          }}
        >
          Encerrar todas as sessões
        </Botao>
      </Cartao>
    </div>
  );
}

function TrocarSenha({
  aoAvisar,
}: {
  aoAvisar: (mensagem: { tom: 'sucesso' | 'erro'; texto: string }) => void;
}) {
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function trocar(evento: React.FormEvent) {
    evento.preventDefault();
    setEnviando(true);

    try {
      await api('/v1/auth/password/change', {
        method: 'POST',
        body: { currentPassword: atual, newPassword: nova },
      });

      aoAvisar({ tom: 'sucesso', texto: 'Senha alterada.' });
      setAtual('');
      setNova('');
    } catch (caught) {
      const detalhes =
        caught instanceof ApiError
          ? ((caught.details as { problems?: string[] } | undefined)?.problems ?? [])
          : [];

      aoAvisar({
        tom: 'erro',
        texto:
          (caught instanceof ApiError ? caught.message : 'Não foi possível trocar a senha.') +
          (detalhes.length > 0 ? ` ${detalhes.join(' ')}` : ''),
      });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Cartao titulo="Trocar senha">
      <form onSubmit={trocar} className="grid gap-3 sm:grid-cols-2">
        <Campo
          rotulo="Senha atual"
          type="password"
          value={atual}
          onChange={(evento) => setAtual(evento.target.value)}
          autoComplete="current-password"
          required
        />
        <Campo
          rotulo="Nova senha"
          type="password"
          value={nova}
          onChange={(evento) => setNova(evento.target.value)}
          autoComplete="new-password"
          required
          minLength={12}
          dica="Pelo menos 12 caracteres."
        />
        <div className="sm:col-span-2">
          <Botao type="submit" variante="primaria" carregando={enviando}>
            Trocar senha
          </Botao>
        </div>
      </form>
    </Cartao>
  );
}

function DoisFatores({
  ativo,
  aoAvisar,
  aoMudar,
}: {
  ativo: boolean;
  aoAvisar: (mensagem: { tom: 'sucesso' | 'erro'; texto: string }) => void;
  aoMudar: () => void;
}) {
  const [configuracao, setConfiguracao] = useState<{
    qrCodeDataUrl: string;
    secret: string;
  } | null>(null);
  const [codigo, setCodigo] = useState('');
  const [recuperacao, setRecuperacao] = useState<string[] | null>(null);
  const [senha, setSenha] = useState('');
  const [processando, setProcessando] = useState(false);

  async function iniciar() {
    setProcessando(true);

    try {
      const resultado = await api<{ qrCodeDataUrl: string; secret: string }>('/v1/auth/2fa/setup', {
        method: 'POST',
      });
      setConfiguracao(resultado);
    } catch (caught) {
      aoAvisar({
        tom: 'erro',
        texto: caught instanceof ApiError ? caught.message : 'Não foi possível iniciar.',
      });
    } finally {
      setProcessando(false);
    }
  }

  async function confirmar(evento: React.FormEvent) {
    evento.preventDefault();
    setProcessando(true);

    try {
      const resultado = await api<{ recoveryCodes: string[] }>('/v1/auth/2fa/confirm', {
        method: 'POST',
        body: { code: codigo },
      });

      setRecuperacao(resultado.recoveryCodes);
      setConfiguracao(null);
      setCodigo('');
      aoMudar();
    } catch (caught) {
      aoAvisar({
        tom: 'erro',
        texto: caught instanceof ApiError ? caught.message : 'Código inválido.',
      });
    } finally {
      setProcessando(false);
    }
  }

  async function desativar(evento: React.FormEvent) {
    evento.preventDefault();
    setProcessando(true);

    try {
      await api('/v1/auth/2fa/disable', { method: 'POST', body: { password: senha } });
      aoAvisar({ tom: 'sucesso', texto: 'Autenticação de dois fatores desativada.' });
      setSenha('');
      aoMudar();
    } catch (caught) {
      aoAvisar({
        tom: 'erro',
        texto: caught instanceof ApiError ? caught.message : 'Senha incorreta.',
      });
    } finally {
      setProcessando(false);
    }
  }

  if (recuperacao) {
    return (
      <Cartao titulo="Guarde seus códigos de recuperação">
        <Aviso tom="alerta">
          Estes códigos aparecem uma única vez. Cada um funciona uma vez só, e servem para
          entrar caso você perca o aparelho com o aplicativo autenticador.
        </Aviso>

        <ul className="mt-3 grid grid-cols-2 gap-2 font-mono text-sm sm:grid-cols-3">
          {recuperacao.map((codigoRecuperacao) => (
            <li key={codigoRecuperacao} className="rounded border border-borda px-2 py-1.5">
              {codigoRecuperacao}
            </li>
          ))}
        </ul>

        <Botao variante="primaria" className="mt-3" onClick={() => setRecuperacao(null)}>
          Guardei os códigos
        </Botao>
      </Cartao>
    );
  }

  return (
    <Cartao
      titulo="Autenticação de dois fatores"
      acoes={ativo ? <Etiqueta tom="sucesso">Ativa</Etiqueta> : <Etiqueta>Inativa</Etiqueta>}
    >
      {ativo ? (
        <form onSubmit={desativar} className="space-y-3">
          <p className="text-sm text-suave">
            Sua conta pede um código do aplicativo autenticador a cada login.
          </p>
          <Campo
            rotulo="Senha (para desativar)"
            type="password"
            value={senha}
            onChange={(evento) => setSenha(evento.target.value)}
            autoComplete="current-password"
            required
          />
          <Botao type="submit" variante="perigo" carregando={processando}>
            Desativar 2FA
          </Botao>
        </form>
      ) : configuracao ? (
        <form onSubmit={confirmar} className="space-y-4">
          <p className="text-sm">
            Escaneie o QR code no seu aplicativo autenticador e digite o código gerado.
          </p>

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={configuracao.qrCodeDataUrl}
            alt="QR code para configurar a autenticação de dois fatores"
            className="mx-auto h-48 w-48 rounded-lg border border-borda bg-white p-2"
          />

          <p className="text-center text-xs text-suave">
            Não consegue escanear? Digite este segredo:
            <br />
            <code className="break-all font-mono">{configuracao.secret}</code>
          </p>

          <Campo
            rotulo="Código do aplicativo"
            value={codigo}
            onChange={(evento) => setCodigo(evento.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            autoFocus
          />

          <div className="flex gap-2">
            <Botao type="submit" variante="primaria" carregando={processando} className="flex-1">
              Confirmar e ativar
            </Botao>
            <Botao type="button" variante="secundaria" onClick={() => setConfiguracao(null)}>
              Cancelar
            </Botao>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-suave">
            Adiciona um código de 6 dígitos ao login. Alguns planos exigem 2FA para papéis
            administrativos.
          </p>
          <Botao variante="primaria" carregando={processando} onClick={() => void iniciar()}>
            Ativar 2FA
          </Botao>
        </div>
      )}
    </Cartao>
  );
}
