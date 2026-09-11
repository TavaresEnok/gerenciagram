'use client';

import { useState } from 'react';
import {
  Aviso,
  Botao,
  Campo,
  Cartao,
  Carregando,
  Etiqueta,
  Modal,
  Selecao,
  Vazio,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApi, useSessao } from '@/lib/sessao';

/**
 * Configurações da organização: dados, membros/papéis, clientes e LGPD.
 */

interface Membro {
  userId: string;
  name: string;
  email: string;
  role: string;
  status: string;
  scopedClientIds: string[];
  twoFactorEnabled: boolean;
  acceptedAt: string | null;
  lastLoginAt: string | null;
}

interface Cliente {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  accountCount: number;
  accountsByPlatform: Record<string, number>;
}

const PAPEIS = [
  { valor: 'OWNER', rotulo: 'Proprietário', descricao: 'Tudo, incluindo plano e exclusão de dados' },
  { valor: 'ADMIN', rotulo: 'Administrador', descricao: 'Tudo, exceto plano e exclusão' },
  { valor: 'MANAGER', rotulo: 'Gestor', descricao: 'Agenda, publica, conecta contas' },
  { valor: 'EDITOR', rotulo: 'Editor', descricao: 'Cria conteúdo, mas não agenda nem publica' },
  { valor: 'APPROVER', rotulo: 'Aprovador', descricao: 'Aprova ou rejeita, sem agendar' },
  { valor: 'ANALYST', rotulo: 'Analista', descricao: 'Só métricas e relatórios' },
  { valor: 'VIEWER', rotulo: 'Leitor', descricao: 'Somente leitura' },
];

const FUSOS = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Rio_Branco',
  'America/Belem',
  'America/Fortaleza',
  'Europe/Lisbon',
  'America/New_York',
  'UTC',
];

export default function PaginaConfiguracoes() {
  const { pode, sessao } = useSessao();

  const { dados: organizacao, carregando, recarregar } = useApi<{
    name: string;
    slug: string;
    timezone: string;
    retention: { mediaDays: number | null; analyticsDays: number | null; auditLogDays: number | null };
  }>('/v1/organization');

  const { dados: membros, recarregar: recarregarMembros } = useApi<{ members: Membro[] }>(
    pode('org:read') ? '/v1/organization/members' : null,
  );
  const { dados: clientes, recarregar: recarregarClientes } = useApi<{ clients: Cliente[] }>(
    '/v1/clients',
  );

  const [convidando, setConvidando] = useState(false);
  const [criandoCliente, setCriandoCliente] = useState(false);
  const [mensagem, setMensagem] = useState<{ tom: 'sucesso' | 'erro'; texto: string } | null>(
    null,
  );

  if (carregando || !organizacao) return <Carregando />;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Configurações da organização</h1>
        <p className="mt-0.5 text-sm text-suave">{organizacao.name}</p>
      </header>

      {mensagem && <Aviso tom={mensagem.tom}>{mensagem.texto}</Aviso>}

      {/* --- Dados e retenção --- */}
      <FormularioOrganizacao
        organizacao={organizacao}
        podeEditar={pode('org:update')}
        aoSalvar={() => {
          void recarregar();
          setMensagem({ tom: 'sucesso', texto: 'Configurações salvas.' });
        }}
      />

      {/* --- Clientes --- */}
      <Cartao
        titulo="Clientes / Marcas"
        descricao="Contêiner de permissão. Cada cliente pode ter várias contas por rede."
        acoes={
          pode('client:create') ? (
            <Botao variante="primaria" onClick={() => setCriandoCliente(true)}>
              Novo cliente
            </Botao>
          ) : undefined
        }
      >
        {(clientes?.clients.length ?? 0) === 0 ? (
          <Vazio
            titulo="Nenhum cliente"
            descricao="Crie ao menos um cliente antes de conectar contas."
          />
        ) : (
          <ul className="space-y-2">
            {clientes?.clients.map((cliente) => (
              <li
                key={cliente.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-borda p-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{cliente.name}</p>
                  <p className="text-xs text-suave">
                    {cliente.timezone} ·{' '}
                    {cliente.accountCount === 0
                      ? 'nenhuma conta'
                      : Object.entries(cliente.accountsByPlatform)
                          .map(([rede, quantidade]) => `${rede}: ${quantidade}`)
                          .join(' · ')}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Cartao>

      {/* --- Membros --- */}
      {pode('org:read') && (
        <Cartao
          titulo="Membros e papéis"
          acoes={
            pode('org:manage_members') ? (
              <Botao variante="primaria" onClick={() => setConvidando(true)}>
                Convidar
              </Botao>
            ) : undefined
          }
        >
          <div className="rolagem-horizontal">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Pessoa</th>
                  <th>Papel</th>
                  <th>2FA</th>
                  <th>Último acesso</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(membros?.members ?? []).map((membro) => (
                  <LinhaMembro
                    key={membro.userId}
                    membro={membro}
                    ehVoce={membro.userId === sessao?.user.id}
                    podeGerenciar={pode('org:manage_roles')}
                    aoMudar={() => void recarregarMembros()}
                    aoAvisar={setMensagem}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Cartao>
      )}

      {/* --- LGPD --- */}
      {pode('org:request_data_deletion') && <BlocoExclusao aoAvisar={setMensagem} />}

      {convidando && (
        <ModalConvite
          clientes={clientes?.clients ?? []}
          aoFechar={() => setConvidando(false)}
          aoSalvar={() => {
            setConvidando(false);
            void recarregarMembros();
            setMensagem({ tom: 'sucesso', texto: 'Convite enviado por e-mail.' });
          }}
        />
      )}

      {criandoCliente && (
        <ModalCliente
          aoFechar={() => setCriandoCliente(false)}
          aoSalvar={() => {
            setCriandoCliente(false);
            void recarregarClientes();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function FormularioOrganizacao({
  organizacao,
  podeEditar,
  aoSalvar,
}: {
  organizacao: {
    name: string;
    timezone: string;
    retention: { mediaDays: number | null; analyticsDays: number | null; auditLogDays: number | null };
  };
  podeEditar: boolean;
  aoSalvar: () => void;
}) {
  const [nome, setNome] = useState(organizacao.name);
  const [fuso, setFuso] = useState(organizacao.timezone);
  const [midia, setMidia] = useState(organizacao.retention.mediaDays?.toString() ?? '');
  const [metricas, setMetricas] = useState(organizacao.retention.analyticsDays?.toString() ?? '');
  const [auditoria, setAuditoria] = useState(organizacao.retention.auditLogDays?.toString() ?? '');
  const [enviando, setEnviando] = useState(false);

  async function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    setEnviando(true);

    try {
      await api('/v1/organization', {
        method: 'PATCH',
        body: {
          name: nome,
          timezone: fuso,
          mediaRetentionDays: midia ? Number(midia) : null,
          analyticsRetentionDays: metricas ? Number(metricas) : null,
          auditLogRetentionDays: auditoria ? Number(auditoria) : null,
        },
      });
      aoSalvar();
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Cartao titulo="Dados e retenção">
      <form onSubmit={salvar} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Campo
            rotulo="Nome"
            value={nome}
            onChange={(evento) => setNome(evento.target.value)}
            disabled={!podeEditar}
          />
          <Selecao
            rotulo="Fuso padrão"
            value={fuso}
            onChange={(evento) => setFuso(evento.target.value)}
            disabled={!podeEditar}
            dica="Herdado por novos clientes. Cada conta pode ter o próprio."
          >
            {FUSOS.map((opcao) => (
              <option key={opcao} value={opcao}>
                {opcao}
              </option>
            ))}
          </Selecao>
        </div>

        <div>
          <p className="rotulo mb-2">Retenção de dados (LGPD)</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Campo
              rotulo="Mídia (dias)"
              type="number"
              min={1}
              max={3650}
              value={midia}
              onChange={(evento) => setMidia(evento.target.value)}
              disabled={!podeEditar}
              placeholder="365"
              dica="Vazio = padrão do plano"
            />
            <Campo
              rotulo="Métricas (dias)"
              type="number"
              min={1}
              max={3650}
              value={metricas}
              onChange={(evento) => setMetricas(evento.target.value)}
              disabled={!podeEditar}
              placeholder="730"
            />
            <Campo
              rotulo="Auditoria (dias)"
              type="number"
              min={30}
              max={3650}
              value={auditoria}
              onChange={(evento) => setAuditoria(evento.target.value)}
              disabled={!podeEditar}
              placeholder="1095"
            />
          </div>
          <p className="mt-1.5 text-xs text-suave">
            O expurgo é automático e diário. Arquivo em uso por publicação futura nunca é
            removido.
          </p>
        </div>

        {podeEditar && (
          <Botao type="submit" variante="primaria" carregando={enviando}>
            Salvar
          </Botao>
        )}
      </form>
    </Cartao>
  );
}

function LinhaMembro({
  membro,
  ehVoce,
  podeGerenciar,
  aoMudar,
  aoAvisar,
}: {
  membro: Membro;
  ehVoce: boolean;
  podeGerenciar: boolean;
  aoMudar: () => void;
  aoAvisar: (mensagem: { tom: 'sucesso' | 'erro'; texto: string }) => void;
}) {
  const [salvando, setSalvando] = useState(false);

  async function mudarPapel(papel: string) {
    setSalvando(true);

    try {
      await api(`/v1/organization/members/${membro.userId}`, {
        method: 'PATCH',
        body: { role: papel },
      });
      aoAvisar({ tom: 'sucesso', texto: `Papel de ${membro.name} atualizado.` });
      aoMudar();
    } catch (caught) {
      aoAvisar({
        tom: 'erro',
        texto: caught instanceof ApiError ? caught.message : 'Não foi possível alterar.',
      });
    } finally {
      setSalvando(false);
    }
  }

  return (
    <tr>
      <td>
        <p className="font-medium">
          {membro.name}
          {ehVoce && <span className="ml-1.5 text-xs text-suave">(você)</span>}
        </p>
        <p className="text-xs text-suave">{membro.email}</p>
      </td>
      <td>
        {podeGerenciar && !ehVoce ? (
          <select
            className="campo py-1 text-xs"
            value={membro.role}
            disabled={salvando}
            onChange={(evento) => void mudarPapel(evento.target.value)}
            aria-label={`Papel de ${membro.name}`}
          >
            {PAPEIS.map((papel) => (
              <option key={papel.valor} value={papel.valor}>
                {papel.rotulo}
              </option>
            ))}
          </select>
        ) : (
          <Etiqueta tom="info">
            {PAPEIS.find((papel) => papel.valor === membro.role)?.rotulo ?? membro.role}
          </Etiqueta>
        )}
        {/* Você não pode alterar o próprio papel — a regra é do backend. */}
        {ehVoce && podeGerenciar && (
          <p className="mt-1 text-xs text-suave">Peça a outro administrador.</p>
        )}
      </td>
      <td>
        {membro.twoFactorEnabled ? (
          <Etiqueta tom="sucesso">Ativo</Etiqueta>
        ) : (
          <Etiqueta tom="neutro">Inativo</Etiqueta>
        )}
      </td>
      <td className="text-xs text-suave">
        {membro.lastLoginAt ? new Date(membro.lastLoginAt).toLocaleDateString('pt-BR') : '—'}
      </td>
      <td>
        {membro.status !== 'ACTIVE' && <Etiqueta tom="alerta">{membro.status}</Etiqueta>}
      </td>
    </tr>
  );
}

function BlocoExclusao({
  aoAvisar,
}: {
  aoAvisar: (mensagem: { tom: 'sucesso' | 'erro'; texto: string }) => void;
}) {
  const [confirmando, setConfirmando] = useState(false);
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function solicitar() {
    setEnviando(true);

    try {
      const resultado = await api<{ scheduledFor: string }>('/v1/organization/deletion-request', {
        method: 'POST',
        body: { gracePeriodDays: 7 },
      });

      aoAvisar({
        tom: 'sucesso',
        texto:
          `Exclusão agendada para ${new Date(resultado.scheduledFor).toLocaleDateString('pt-BR')}. ` +
          `Você pode cancelar até lá.`,
      });
      setConfirmando(false);
    } catch (caught) {
      aoAvisar({
        tom: 'erro',
        texto: caught instanceof ApiError ? caught.message : 'Não foi possível solicitar.',
      });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Cartao titulo="Excluir todos os dados (LGPD)">
      <div className="space-y-3">
        <p className="text-sm text-suave">
          Remove permanentemente esta organização e tudo que pertence a ela: contas conectadas,
          mídia, publicações, métricas e histórico. Antes de apagar, o sistema{' '}
          <strong>revoga os tokens de acesso junto às plataformas</strong> — apagar o banco
          primeiro deixaria as autorizações vivas lá fora.
        </p>

        <p className="text-sm text-suave">
          Há uma janela de 7 dias para cancelar. Depois disso, não há como recuperar.
        </p>

        {confirmando ? (
          <div className="space-y-3 rounded-lg border border-erro/40 bg-erro/5 p-3">
            <Campo
              rotulo='Digite "EXCLUIR" para confirmar'
              value={texto}
              onChange={(evento) => setTexto(evento.target.value)}
              autoFocus
            />
            <div className="flex gap-2">
              <Botao
                variante="perigo"
                disabled={texto !== 'EXCLUIR'}
                carregando={enviando}
                onClick={() => void solicitar()}
              >
                Solicitar exclusão
              </Botao>
              <Botao variante="secundaria" onClick={() => setConfirmando(false)}>
                Cancelar
              </Botao>
            </div>
          </div>
        ) : (
          <Botao variante="perigo" onClick={() => setConfirmando(true)}>
            Solicitar exclusão de dados
          </Botao>
        )}
      </div>
    </Cartao>
  );
}

function ModalConvite({
  clientes,
  aoFechar,
  aoSalvar,
}: {
  clientes: Cliente[];
  aoFechar: () => void;
  aoSalvar: () => void;
}) {
  const [email, setEmail] = useState('');
  const [papel, setPapel] = useState('EDITOR');
  const [escopo, setEscopo] = useState<string[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function convidar(evento: React.FormEvent) {
    evento.preventDefault();
    setErro(null);
    setEnviando(true);

    try {
      await api('/v1/organization/members/invite', {
        method: 'POST',
        body: { email, role: papel, scopedClientIds: escopo },
      });
      aoSalvar();
    } catch (caught) {
      setErro(caught instanceof ApiError ? caught.message : 'Não foi possível convidar.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Modal aberto aoFechar={aoFechar} titulo="Convidar para a organização">
      <form onSubmit={convidar} className="space-y-4">
        {erro && <Aviso tom="erro">{erro}</Aviso>}

        <Campo
          rotulo="E-mail"
          type="email"
          value={email}
          onChange={(evento) => setEmail(evento.target.value)}
          required
          autoFocus
        />

        <div>
          <label className="rotulo mb-1.5" htmlFor="papel-convite">
            Papel
          </label>
          <select
            id="papel-convite"
            className="campo"
            value={papel}
            onChange={(evento) => setPapel(evento.target.value)}
          >
            {PAPEIS.map((opcao) => (
              <option key={opcao.valor} value={opcao.valor}>
                {opcao.rotulo}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-suave">
            {PAPEIS.find((opcao) => opcao.valor === papel)?.descricao}
          </p>
        </div>

        {clientes.length > 0 && (
          <div>
            <p className="rotulo mb-1.5">Limitar a quais clientes</p>
            <div className="space-y-1 rounded-lg border border-borda p-2">
              {clientes.map((cliente) => (
                <label key={cliente.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={escopo.includes(cliente.id)}
                    onChange={() =>
                      setEscopo((atual) =>
                        atual.includes(cliente.id)
                          ? atual.filter((id) => id !== cliente.id)
                          : [...atual, cliente.id],
                      )
                    }
                  />
                  {cliente.name}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-suave">
              Nenhum marcado = acesso a todos os clientes.
            </p>
          </div>
        )}

        <div className="flex gap-2">
          <Botao type="submit" variante="primaria" carregando={enviando} className="flex-1">
            Enviar convite
          </Botao>
          <Botao type="button" variante="secundaria" onClick={aoFechar}>
            Cancelar
          </Botao>
        </div>
      </form>
    </Modal>
  );
}

function ModalCliente({ aoFechar, aoSalvar }: { aoFechar: () => void; aoSalvar: () => void }) {
  const [nome, setNome] = useState('');
  const [fuso, setFuso] = useState('America/Sao_Paulo');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function criar(evento: React.FormEvent) {
    evento.preventDefault();
    setErro(null);
    setEnviando(true);

    try {
      await api('/v1/clients', { method: 'POST', body: { name: nome, timezone: fuso } });
      aoSalvar();
    } catch (caught) {
      setErro(caught instanceof ApiError ? caught.message : 'Não foi possível criar.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Modal aberto aoFechar={aoFechar} titulo="Novo cliente / marca">
      <form onSubmit={criar} className="space-y-4">
        {erro && <Aviso tom="erro">{erro}</Aviso>}

        <Campo
          rotulo="Nome"
          value={nome}
          onChange={(evento) => setNome(evento.target.value)}
          required
          autoFocus
        />

        <Selecao
          rotulo="Fuso horário"
          value={fuso}
          onChange={(evento) => setFuso(evento.target.value)}
          dica="Herdado pelas contas conectadas a este cliente."
        >
          {FUSOS.map((opcao) => (
            <option key={opcao} value={opcao}>
              {opcao}
            </option>
          ))}
        </Selecao>

        <div className="flex gap-2">
          <Botao type="submit" variante="primaria" carregando={enviando} className="flex-1">
            Criar
          </Botao>
          <Botao type="button" variante="secundaria" onClick={aoFechar}>
            Cancelar
          </Botao>
        </div>
      </form>
    </Modal>
  );
}
