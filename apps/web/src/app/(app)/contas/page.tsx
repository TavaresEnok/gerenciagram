'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import {
  Aviso,
  Botao,
  Campo,
  Cartao,
  Carregando,
  Etiqueta,
  EtiquetaStatus,
  Modal,
  Selecao,
  Vazio,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApi, useSessao } from '@/lib/sessao';

/**
 * Contas conectadas, agrupadas por rede.
 *
 * O ponto que a SPEC seção 6.1 exige e que a maioria das ferramentas erra:
 * VÁRIAS contas por rede, cada uma com apelido interno e fuso próprios. A tela
 * mostra o nome real do perfil junto do apelido — sem isso, cinco linhas
 * "TikTok" ficam indistinguíveis.
 */

interface Conta {
  id: string;
  platform: string;
  platformName: string;
  nickname: string;
  timezone: string;
  status: string;
  statusReason: string | null;
  remoteDisplayName: string | null;
  remoteUsername: string | null;
  remoteProfileUrl: string | null;
  clientId: string;
  clientName: string;
  connectedAt: string;
  lastPublishedAt: string | null;
  token: { expiresAt: string | null; scopes: string[]; needsReconnect: boolean };
  groups: Array<{ id: string; name: string }>;
  queueSlots: Array<{ weekday: number; hour: number; minute: number }>;
}

interface Plataforma {
  key: string;
  displayName: string;
  isAvailable: boolean;
  credentialsConfigured: boolean;
  canConnect: boolean;
  unavailableReason: string | null;
  docsUrl: string | null;
}

interface Cliente {
  id: string;
  name: string;
  timezone: string;
}

const FUSOS = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Rio_Branco',
  'America/Belem',
  'America/Fortaleza',
  'America/Noronha',
  'Europe/Lisbon',
  'America/New_York',
  'Europe/London',
  'UTC',
];

export default function PaginaContas() {
  return (
    <Suspense fallback={<Carregando />}>
      <Conteudo />
    </Suspense>
  );
}

function Conteudo() {
  const parametros = useSearchParams();
  const { pode } = useSessao();

  const { dados, carregando, recarregar } = useApi<{
    accounts: Conta[];
    byPlatform: Record<string, Conta[]>;
  }>('/v1/accounts');

  const { dados: plataformas } = useApi<{ platforms: Plataforma[] }>('/v1/platforms');
  const { dados: clientes } = useApi<{ clients: Cliente[] }>('/v1/clients');

  const [conectando, setConectando] = useState<Plataforma | null>(null);
  const [editando, setEditando] = useState<Conta | null>(null);
  const [mensagem, setMensagem] = useState<{ tom: 'sucesso' | 'erro'; texto: string } | null>(
    null,
  );

  // O callback do OAuth devolve o navegador para cá com o resultado na URL.
  useEffect(() => {
    const erro = parametros.get('erro');
    const status = parametros.get('status');

    if (erro) setMensagem({ tom: 'erro', texto: erro });
    else if (status === 'conectada') {
      setMensagem({ tom: 'sucesso', texto: 'Conta conectada com sucesso.' });
    } else if (status === 'reconectada') {
      setMensagem({ tom: 'sucesso', texto: 'Conta reconectada com sucesso.' });
    }

    if (erro || status) window.history.replaceState({}, '', '/contas');
  }, [parametros]);

  if (carregando) return <Carregando />;

  const redes = plataformas?.platforms ?? [];
  const contas = dados?.accounts ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Contas conectadas</h1>
          <p className="mt-0.5 text-sm text-suave">
            Várias contas por rede. Cada uma tem apelido interno e fuso horário próprios.
          </p>
        </div>
      </header>

      {mensagem && <Aviso tom={mensagem.tom}>{mensagem.texto}</Aviso>}

      {/* --- Conectar --- */}
      {pode('account:connect') && (
        <Cartao titulo="Conectar nova conta">
          {(clientes?.clients.length ?? 0) === 0 ? (
            <Aviso tom="alerta">
              Crie um cliente/marca antes de conectar contas — é ele que define quem tem acesso
              a quais perfis. Você faz isso em Configurações.
            </Aviso>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {redes.map((rede) => (
                <button
                  key={rede.key}
                  onClick={() => rede.canConnect && setConectando(rede)}
                  disabled={!rede.canConnect}
                  className="flex items-start justify-between gap-2 rounded-lg border border-borda p-3 text-left transition enabled:hover:bg-fundo disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{rede.displayName}</p>
                    <p className="mt-0.5 text-xs leading-snug text-suave">
                      {rede.canConnect
                        ? 'Clique para conectar uma conta'
                        : rede.isAvailable
                          ? 'Aguardando as credenciais do aplicativo neste ambiente'
                          : (rede.unavailableReason ?? 'Indisponível')}
                    </p>
                  </div>
                  {rede.canConnect && <span aria-hidden="true">→</span>}
                </button>
              ))}
            </div>
          )}
        </Cartao>
      )}

      {/* --- Lista --- */}
      {contas.length === 0 ? (
        <Vazio
          titulo="Nenhuma conta conectada"
          descricao="Conecte a primeira conta para começar a agendar publicações."
        />
      ) : (
        Object.entries(dados?.byPlatform ?? {}).map(([rede, lista]) => (
          <Cartao
            key={rede}
            titulo={lista[0]?.platformName ?? rede}
            descricao={`${lista.length} ${lista.length === 1 ? 'conta' : 'contas'}`}
          >
            <div className="space-y-2">
              {lista.map((conta) => (
                <LinhaConta
                  key={conta.id}
                  conta={conta}
                  podeEditar={pode('account:update')}
                  podeDesconectar={pode('account:disconnect')}
                  aoEditar={() => setEditando(conta)}
                  aoMudar={() => void recarregar()}
                  aoAvisar={setMensagem}
                />
              ))}
            </div>
          </Cartao>
        ))
      )}

      {conectando && (
        <ModalConectar
          plataforma={conectando}
          clientes={clientes?.clients ?? []}
          aoFechar={() => setConectando(null)}
          aoErro={(texto) => setMensagem({ tom: 'erro', texto })}
        />
      )}

      {editando && (
        <ModalEditar
          conta={editando}
          aoFechar={() => setEditando(null)}
          aoSalvar={() => {
            setEditando(null);
            void recarregar();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function LinhaConta({
  conta,
  podeEditar,
  podeDesconectar,
  aoEditar,
  aoMudar,
  aoAvisar,
}: {
  conta: Conta;
  podeEditar: boolean;
  podeDesconectar: boolean;
  aoEditar: () => void;
  aoMudar: () => void;
  aoAvisar: (mensagem: { tom: 'sucesso' | 'erro'; texto: string }) => void;
}) {
  const [desconectando, setDesconectando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);

  async function desconectar() {
    setDesconectando(true);

    try {
      const resultado = await api<{
        revokedRemotely: boolean;
        scheduledTargetsCancelled: number;
      }>(`/v1/accounts/${conta.id}/disconnect`, { method: 'POST' });

      aoAvisar({
        tom: 'sucesso',
        texto:
          `Conta "${conta.nickname}" desconectada. ` +
          (resultado.revokedRemotely
            ? 'O acesso foi revogado na plataforma. '
            : 'Não foi possível revogar o acesso na plataforma — revogue manualmente. ') +
          (resultado.scheduledTargetsCancelled > 0
            ? `${resultado.scheduledTargetsCancelled} agendamento(s) pendente(s) foram cancelados.`
            : ''),
      });

      aoMudar();
    } catch (caught) {
      aoAvisar({
        tom: 'erro',
        texto: caught instanceof ApiError ? caught.message : 'Não foi possível desconectar.',
      });
    } finally {
      setDesconectando(false);
      setConfirmando(false);
    }
  }

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-borda p-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">{conta.nickname}</p>
          <EtiquetaStatus status={conta.status} />
          {conta.groups.map((grupo) => (
            <Etiqueta key={grupo.id} tom="info">
              {grupo.name}
            </Etiqueta>
          ))}
        </div>

        {/* Nome REAL do perfil: o apelido interno sozinho não identifica a conta. */}
        <p className="mt-0.5 truncate text-xs text-suave">
          {conta.remoteDisplayName ?? conta.remoteUsername ?? conta.platformName}
          {' · '}
          {conta.clientName}
          {' · '}
          {conta.timezone}
          {conta.queueSlots.length > 0 && ` · ${conta.queueSlots.length} slot(s) na fila`}
        </p>

        {conta.statusReason && (
          <p className="mt-1 text-xs text-erro">{conta.statusReason}</p>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {conta.remoteProfileUrl && (
          <a href={conta.remoteProfileUrl} target="_blank" rel="noreferrer noopener">
            <Botao variante="fantasma">Abrir perfil</Botao>
          </a>
        )}
        {podeEditar && (
          <Botao variante="secundaria" onClick={aoEditar}>
            Editar
          </Botao>
        )}
        {podeDesconectar &&
          (confirmando ? (
            <>
              <Botao variante="perigo" carregando={desconectando} onClick={() => void desconectar()}>
                Confirmar
              </Botao>
              <Botao variante="fantasma" onClick={() => setConfirmando(false)}>
                Cancelar
              </Botao>
            </>
          ) : (
            <Botao variante="fantasma" onClick={() => setConfirmando(true)}>
              Desconectar
            </Botao>
          ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ModalConectar({
  plataforma,
  clientes,
  aoFechar,
  aoErro,
}: {
  plataforma: Plataforma;
  clientes: Cliente[];
  aoFechar: () => void;
  aoErro: (mensagem: string) => void;
}) {
  const [clienteId, setClienteId] = useState(clientes[0]?.id ?? '');
  const [apelido, setApelido] = useState('');
  const [fuso, setFuso] = useState(clientes[0]?.timezone ?? 'America/Sao_Paulo');
  const [consentimento, setConsentimento] = useState<{
    scopes: Array<{ scope: string; description: string }>;
    authorizationUrl: string;
  } | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function iniciar(evento: React.FormEvent) {
    evento.preventDefault();
    setEnviando(true);

    try {
      const resposta = await api<{
        authorizationUrl: string;
        consent: { scopes: Array<{ scope: string; description: string }> };
      }>(`/v1/oauth/${plataforma.key}/start`, {
        method: 'POST',
        body: { clientId: clienteId, nickname: apelido, timezone: fuso },
      });

      // Transparência de consentimento (SPEC seção 11): mostramos o que será
      // concedido ANTES de mandar a pessoa para a plataforma.
      setConsentimento({
        scopes: resposta.consent.scopes,
        authorizationUrl: resposta.authorizationUrl,
      });
    } catch (caught) {
      aoErro(caught instanceof ApiError ? caught.message : 'Não foi possível iniciar a conexão.');
      aoFechar();
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Modal aberto aoFechar={aoFechar} titulo={`Conectar conta do ${plataforma.displayName}`}>
      {consentimento ? (
        <div className="space-y-4">
          <p className="text-sm">
            Ao continuar, você autoriza este aplicativo a fazer o seguinte na conta que você
            escolher no {plataforma.displayName}:
          </p>

          <ul className="space-y-2">
            {consentimento.scopes.map((escopo) => (
              <li key={escopo.scope} className="rounded-lg border border-borda p-2.5">
                <p className="text-sm">{escopo.description}</p>
                <p className="mt-0.5 break-all font-mono text-[11px] text-suave">
                  {escopo.scope}
                </p>
              </li>
            ))}
          </ul>

          <Aviso tom="info">
            Você será levado para o site do {plataforma.displayName} para autorizar. Nenhuma
            senha sua passa por este sistema.
          </Aviso>

          <div className="flex gap-2">
            <Botao
              variante="primaria"
              className="flex-1"
              onClick={() => {
                window.location.href = consentimento.authorizationUrl;
              }}
            >
              Autorizar no {plataforma.displayName}
            </Botao>
            <Botao variante="secundaria" onClick={aoFechar}>
              Cancelar
            </Botao>
          </div>
        </div>
      ) : (
        <form onSubmit={iniciar} className="space-y-4">
          <Selecao
            rotulo="Cliente/Marca"
            value={clienteId}
            onChange={(evento) => {
              setClienteId(evento.target.value);
              const cliente = clientes.find((item) => item.id === evento.target.value);
              if (cliente) setFuso(cliente.timezone);
            }}
            required
            dica="Define quem na sua equipe tem acesso a esta conta."
          >
            {clientes.map((cliente) => (
              <option key={cliente.id} value={cliente.id}>
                {cliente.name}
              </option>
            ))}
          </Selecao>

          <Campo
            rotulo="Apelido interno"
            value={apelido}
            onChange={(evento) => setApelido(evento.target.value)}
            required
            maxLength={120}
            placeholder={`${plataforma.displayName} 1 – Curiosidades`}
            dica="Só a sua equipe vê. Serve para distinguir várias contas da mesma rede."
            autoFocus
          />

          <Selecao
            rotulo="Fuso horário da conta"
            value={fuso}
            onChange={(evento) => setFuso(evento.target.value)}
            dica='"Segunda às 10h" para esta conta significa 10h NESTE fuso.'
          >
            {FUSOS.map((opcao) => (
              <option key={opcao} value={opcao}>
                {opcao}
              </option>
            ))}
          </Selecao>

          <Botao type="submit" variante="primaria" carregando={enviando} className="w-full">
            Continuar
          </Botao>
        </form>
      )}
    </Modal>
  );
}

function ModalEditar({
  conta,
  aoFechar,
  aoSalvar,
}: {
  conta: Conta;
  aoFechar: () => void;
  aoSalvar: () => void;
}) {
  const [apelido, setApelido] = useState(conta.nickname);
  const [fuso, setFuso] = useState(conta.timezone);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    setErro(null);
    setEnviando(true);

    try {
      await api(`/v1/accounts/${conta.id}`, {
        method: 'PATCH',
        body: { nickname: apelido, timezone: fuso },
      });
      aoSalvar();
    } catch (caught) {
      setErro(caught instanceof ApiError ? caught.message : 'Não foi possível salvar.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Modal aberto aoFechar={aoFechar} titulo={`Editar ${conta.nickname}`}>
      <form onSubmit={salvar} className="space-y-4">
        {erro && <Aviso tom="erro">{erro}</Aviso>}

        <Campo
          rotulo="Apelido interno"
          value={apelido}
          onChange={(evento) => setApelido(evento.target.value)}
          required
          maxLength={120}
          autoFocus
        />

        <Selecao
          rotulo="Fuso horário"
          value={fuso}
          onChange={(evento) => setFuso(evento.target.value)}
          dica="Mudar o fuso NÃO reajusta as publicações já agendadas — elas mantêm o instante em que foram marcadas."
        >
          {FUSOS.map((opcao) => (
            <option key={opcao} value={opcao}>
              {opcao}
            </option>
          ))}
        </Selecao>

        <div className="rounded-lg border border-borda p-3 text-xs text-suave">
          <p className="font-medium text-texto">Permissões concedidas</p>
          <ul className="mt-1 space-y-0.5">
            {conta.token.scopes.length === 0 ? (
              <li>Nenhuma registrada.</li>
            ) : (
              conta.token.scopes.map((escopo) => (
                <li key={escopo} className="break-all font-mono">
                  {escopo}
                </li>
              ))
            )}
          </ul>
        </div>

        <div className="flex gap-2">
          <Botao type="submit" variante="primaria" carregando={enviando} className="flex-1">
            Salvar
          </Botao>
          <Botao type="button" variante="secundaria" onClick={aoFechar}>
            Cancelar
          </Botao>
        </div>
      </form>
    </Modal>
  );
}
