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
  Vazio,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApi, useSessao } from '@/lib/sessao';

/**
 * Grupos de contas (SPEC seção 6.1).
 *
 * Duas coisas que a tela deixa explícitas, porque são as que confundem:
 *
 *  1. grupo é ATALHO DE SELEÇÃO, não nível de permissão — quem não pode
 *     publicar numa conta continua sem poder, mesmo que ela esteja no grupo;
 *  2. mudar a composição NÃO altera agendamento já feito. Quando há
 *     publicações futuras, a tela oferece a ação explícita de aplicar.
 */

interface Membro {
  accountId: string;
  nickname: string;
  platform: string;
  platformName: string;
  clientName: string;
  timezone: string;
  status: string;
  remoteDisplayName: string | null;
}

interface Grupo {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  countByPlatform: Record<string, number>;
  members: Membro[];
}

interface Conta {
  id: string;
  nickname: string;
  platform: string;
  platformName: string;
  remoteDisplayName: string | null;
  clientName: string;
  timezone: string;
}

const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

export default function PaginaGrupos() {
  const { pode } = useSessao();
  const { dados, carregando, recarregar } = useApi<{ groups: Grupo[] }>('/v1/groups');
  const { dados: contasResposta } = useApi<{ accounts: Conta[] }>('/v1/accounts');

  const [criando, setCriando] = useState(false);
  const [editandoMembros, setEditandoMembros] = useState<Grupo | null>(null);
  const [editandoGrade, setEditandoGrade] = useState<Grupo | null>(null);
  const [mensagem, setMensagem] = useState<{ tom: 'sucesso' | 'erro' | 'alerta'; texto: string } | null>(
    null,
  );

  if (carregando) return <Carregando />;

  const grupos = dados?.groups ?? [];
  const contas = contasResposta?.accounts ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Grupos de contas</h1>
          <p className="mt-0.5 text-sm text-suave">
            Atalho para selecionar várias contas de uma vez, de qualquer rede.
          </p>
        </div>
        {pode('group:create') && (
          <Botao variante="primaria" onClick={() => setCriando(true)}>
            Novo grupo
          </Botao>
        )}
      </header>

      {mensagem && <Aviso tom={mensagem.tom}>{mensagem.texto}</Aviso>}

      <Aviso tom="info">
        Um grupo nunca concede permissão. Ao usá-lo no compositor, entram só as contas em que
        você pode publicar — as demais aparecem no preview com o motivo.
      </Aviso>

      {grupos.length === 0 ? (
        <Vazio
          titulo="Nenhum grupo criado"
          descricao='Ex.: "Curiosidades" reunindo 5 TikToks, 5 canais do YouTube e 5 Instagrams.'
          acao={
            pode('group:create') ? (
              <Botao variante="primaria" onClick={() => setCriando(true)}>
                Criar o primeiro grupo
              </Botao>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {grupos.map((grupo) => (
            <Cartao
              key={grupo.id}
              titulo={grupo.name}
              descricao={
                Object.entries(grupo.countByPlatform)
                  .map(([rede, quantidade]) => `${rede}: ${quantidade}`)
                  .join(' · ') || 'Sem contas'
              }
              acoes={
                pode('group:update') ? (
                  <>
                    <Botao variante="secundaria" onClick={() => setEditandoMembros(grupo)}>
                      Contas
                    </Botao>
                    <Botao variante="secundaria" onClick={() => setEditandoGrade(grupo)}>
                      Grade
                    </Botao>
                  </>
                ) : undefined
              }
            >
              {grupo.description && (
                <p className="mb-3 text-sm text-suave">{grupo.description}</p>
              )}

              {grupo.members.length === 0 ? (
                <p className="text-sm text-suave">Nenhuma conta neste grupo.</p>
              ) : (
                <ul className="space-y-1.5">
                  {grupo.members.map((membro) => (
                    <li key={membro.accountId} className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm">{membro.nickname}</p>
                        <p className="truncate text-xs text-suave">
                          {membro.platformName}
                          {membro.remoteDisplayName && ` · ${membro.remoteDisplayName}`}
                          {' · '}
                          {membro.timezone}
                        </p>
                      </div>
                      {membro.status !== 'ACTIVE' && <Etiqueta tom="erro">Reconectar</Etiqueta>}
                    </li>
                  ))}
                </ul>
              )}
            </Cartao>
          ))}
        </div>
      )}

      {criando && (
        <ModalGrupo
          contas={contas}
          aoFechar={() => setCriando(false)}
          aoSalvar={() => {
            setCriando(false);
            void recarregar();
          }}
        />
      )}

      {editandoMembros && (
        <ModalMembros
          grupo={editandoMembros}
          contas={contas}
          aoFechar={() => setEditandoMembros(null)}
          aoSalvar={(afetados) => {
            setEditandoMembros(null);
            void recarregar();

            if (afetados > 0) {
              setMensagem({
                tom: 'alerta',
                texto:
                  `${afetados} publicação(ões) futura(s) foram criadas a partir deste grupo. ` +
                  `Elas NÃO foram alteradas. Use "Aplicar aos agendamentos futuros" se quiser propagar a mudança.`,
              });
            }
          }}
          aoAvisar={setMensagem}
        />
      )}

      {editandoGrade && (
        <ModalGrade
          grupo={editandoGrade}
          aoFechar={() => setEditandoGrade(null)}
          aoSalvar={(contas) => {
            setEditandoGrade(null);
            setMensagem({
              tom: 'sucesso',
              texto: `Grade aplicada a ${contas} conta(s). Cada uma usa o próprio fuso horário.`,
            });
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ModalGrupo({
  contas,
  aoFechar,
  aoSalvar,
}: {
  contas: Conta[];
  aoFechar: () => void;
  aoSalvar: () => void;
}) {
  const [nome, setNome] = useState('');
  const [descricao, setDescricao] = useState('');
  const [selecionadas, setSelecionadas] = useState<string[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function criar(evento: React.FormEvent) {
    evento.preventDefault();
    setErro(null);
    setEnviando(true);

    try {
      await api('/v1/groups', {
        method: 'POST',
        body: { name: nome, description: descricao || undefined, accountIds: selecionadas },
      });
      aoSalvar();
    } catch (caught) {
      setErro(caught instanceof ApiError ? caught.message : 'Não foi possível criar o grupo.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Modal aberto aoFechar={aoFechar} titulo="Novo grupo de contas" largura="lg">
      <form onSubmit={criar} className="space-y-4">
        {erro && <Aviso tom="erro">{erro}</Aviso>}

        <Campo
          rotulo="Nome do grupo"
          value={nome}
          onChange={(evento) => setNome(evento.target.value)}
          required
          placeholder="Curiosidades"
          autoFocus
        />

        <Campo
          rotulo="Descrição"
          value={descricao}
          onChange={(evento) => setDescricao(evento.target.value)}
          placeholder="Contas do nicho de curiosidades"
        />

        <SeletorContas contas={contas} selecionadas={selecionadas} aoMudar={setSelecionadas} />

        <div className="flex gap-2">
          <Botao type="submit" variante="primaria" carregando={enviando} className="flex-1">
            Criar grupo ({selecionadas.length} conta(s))
          </Botao>
          <Botao type="button" variante="secundaria" onClick={aoFechar}>
            Cancelar
          </Botao>
        </div>
      </form>
    </Modal>
  );
}

function ModalMembros({
  grupo,
  contas,
  aoFechar,
  aoSalvar,
  aoAvisar,
}: {
  grupo: Grupo;
  contas: Conta[];
  aoFechar: () => void;
  aoSalvar: (agendamentosAfetados: number) => void;
  aoAvisar: (mensagem: { tom: 'sucesso' | 'erro' | 'alerta'; texto: string }) => void;
}) {
  const [selecionadas, setSelecionadas] = useState(
    grupo.members.map((membro) => membro.accountId),
  );
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [aplicando, setAplicando] = useState(false);

  async function salvar() {
    setErro(null);
    setEnviando(true);

    try {
      const resultado = await api<{ futureSchedulesAffected: number }>(
        `/v1/groups/${grupo.id}/members`,
        { method: 'PUT', body: { accountIds: selecionadas } },
      );
      aoSalvar(resultado.futureSchedulesAffected);
    } catch (caught) {
      setErro(caught instanceof ApiError ? caught.message : 'Não foi possível salvar.');
    } finally {
      setEnviando(false);
    }
  }

  /**
   * Ação EXPLÍCITA de propagar a composição atual para os agendamentos
   * futuros (SPEC seção 6.1). Mostra o preview antes de aplicar.
   */
  async function aplicarAosFuturos() {
    setAplicando(true);

    try {
      const previa = await api<{
        posts: Array<{ postId: string; contentTitle: string | null; toAdd: string[]; toRemove: string[] }>;
      }>(`/v1/groups/${grupo.id}/apply-to-future`, { method: 'POST', body: { dryRun: true } });

      if (previa.posts.length === 0) {
        aoAvisar({ tom: 'sucesso', texto: 'Não há agendamentos futuros deste grupo.' });
        return;
      }

      const resumo = previa.posts
        .map(
          (post) =>
            `• ${post.contentTitle ?? 'Sem título'}: ` +
            `${post.toAdd.length} a adicionar, ${post.toRemove.length} a remover`,
        )
        .join('\n');

      if (!window.confirm(`Aplicar a ${previa.posts.length} publicação(ões)?\n\n${resumo}`)) {
        return;
      }

      await api(`/v1/groups/${grupo.id}/apply-to-future`, {
        method: 'POST',
        body: { dryRun: false },
      });

      aoAvisar({
        tom: 'sucesso',
        texto: `Mudança aplicada a ${previa.posts.length} publicação(ões) futura(s).`,
      });
      aoFechar();
    } catch (caught) {
      aoAvisar({
        tom: 'erro',
        texto: caught instanceof ApiError ? caught.message : 'Não foi possível aplicar.',
      });
    } finally {
      setAplicando(false);
    }
  }

  return (
    <Modal aberto aoFechar={aoFechar} titulo={`Contas de "${grupo.name}"`} largura="lg">
      <div className="space-y-4">
        {erro && <Aviso tom="erro">{erro}</Aviso>}

        <Aviso tom="info">
          Alterar as contas aqui não muda publicações já agendadas. Para propagar, use o botão
          &quot;Aplicar aos agendamentos futuros&quot; — com preview antes.
        </Aviso>

        <SeletorContas contas={contas} selecionadas={selecionadas} aoMudar={setSelecionadas} />

        <div className="flex flex-wrap gap-2">
          <Botao variante="primaria" carregando={enviando} onClick={() => void salvar()}>
            Salvar ({selecionadas.length})
          </Botao>
          <Botao
            variante="secundaria"
            carregando={aplicando}
            onClick={() => void aplicarAosFuturos()}
          >
            Aplicar aos agendamentos futuros
          </Botao>
          <Botao variante="fantasma" onClick={aoFechar}>
            Cancelar
          </Botao>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Grade semanal da fila.
 *
 * O grupo é atalho: a grade é gravada em CADA conta, e interpretada no fuso
 * dela. "Segunda às 10h" num grupo com contas em São Paulo e em Lisboa gera
 * dois instantes diferentes — que é o comportamento correto.
 */
function ModalGrade({
  grupo,
  aoFechar,
  aoSalvar,
}: {
  grupo: Grupo;
  aoFechar: () => void;
  aoSalvar: (contasAtualizadas: number) => void;
}) {
  const [slots, setSlots] = useState<Array<{ weekday: number; hour: number; minute: number }>>([]);
  const [dia, setDia] = useState(1);
  const [horario, setHorario] = useState('10:00');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  function adicionar() {
    const [hora, minuto] = horario.split(':').map(Number);
    if (hora === undefined || minuto === undefined) return;

    const existe = slots.some(
      (slot) => slot.weekday === dia && slot.hour === hora && slot.minute === minuto,
    );
    if (existe) return;

    setSlots((atual) =>
      [...atual, { weekday: dia, hour: hora, minute: minuto }].sort(
        (a, b) => a.weekday - b.weekday || a.hour - b.hour || a.minute - b.minute,
      ),
    );
  }

  async function salvar() {
    setErro(null);
    setEnviando(true);

    try {
      const resultado = await api<{ accountsUpdated: number }>(
        `/v1/groups/${grupo.id}/schedule`,
        { method: 'PUT', body: { slots } },
      );
      aoSalvar(resultado.accountsUpdated);
    } catch (caught) {
      setErro(caught instanceof ApiError ? caught.message : 'Não foi possível salvar a grade.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Modal aberto aoFechar={aoFechar} titulo={`Grade da fila — ${grupo.name}`}>
      <div className="space-y-4">
        {erro && <Aviso tom="erro">{erro}</Aviso>}

        <Aviso tom="info">
          A grade é gravada em cada conta do grupo e interpretada no fuso DELA. As contas deste
          grupo estão em: {[...new Set(grupo.members.map((m) => m.timezone))].join(', ') || '—'}.
        </Aviso>

        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1">
            <label className="rotulo" htmlFor="dia-slot">
              Dia
            </label>
            <select
              id="dia-slot"
              className="campo"
              value={dia}
              onChange={(evento) => setDia(Number(evento.target.value))}
            >
              {DIAS.map((nome, indice) => (
                <option key={nome} value={indice}>
                  {nome}
                </option>
              ))}
            </select>
          </div>

          <div className="flex-1">
            <label className="rotulo" htmlFor="hora-slot">
              Horário
            </label>
            <input
              id="hora-slot"
              type="time"
              className="campo"
              value={horario}
              onChange={(evento) => setHorario(evento.target.value)}
            />
          </div>

          <Botao variante="secundaria" onClick={adicionar}>
            Adicionar
          </Botao>
        </div>

        {slots.length === 0 ? (
          <p className="rounded-lg border border-dashed border-borda px-3 py-6 text-center text-sm text-suave">
            Nenhum horário na grade. Salvar assim desativa a fila por slots destas contas.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {slots.map((slot, indice) => (
              <li key={indice}>
                <button
                  onClick={() => setSlots((atual) => atual.filter((_, i) => i !== indice))}
                  className="rounded-lg border border-borda px-2.5 py-1.5 text-sm hover:border-erro hover:text-erro"
                  title="Remover"
                >
                  {DIAS[slot.weekday]} {String(slot.hour).padStart(2, '0')}:
                  {String(slot.minute).padStart(2, '0')} ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex gap-2">
          <Botao variante="primaria" carregando={enviando} onClick={() => void salvar()} className="flex-1">
            Aplicar às {grupo.memberCount} conta(s)
          </Botao>
          <Botao variante="secundaria" onClick={aoFechar}>
            Cancelar
          </Botao>
        </div>
      </div>
    </Modal>
  );
}

function SeletorContas({
  contas,
  selecionadas,
  aoMudar,
}: {
  contas: Conta[];
  selecionadas: string[];
  aoMudar: (contas: string[]) => void;
}) {
  const porRede = contas.reduce<Record<string, Conta[]>>((mapa, conta) => {
    (mapa[conta.platformName] ??= []).push(conta);
    return mapa;
  }, {});

  return (
    <div>
      <p className="rotulo mb-2">Contas ({selecionadas.length} selecionada(s))</p>
      <div className="max-h-80 space-y-3 overflow-y-auto rounded-lg border border-borda p-3">
        {Object.entries(porRede).map(([rede, lista]) => (
          <div key={rede}>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-suave">
              {rede}
            </p>
            <div className="space-y-1">
              {lista.map((conta) => {
                const marcado = selecionadas.includes(conta.id);

                return (
                  <label
                    key={conta.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-fundo"
                  >
                    <input
                      type="checkbox"
                      checked={marcado}
                      onChange={() =>
                        aoMudar(
                          marcado
                            ? selecionadas.filter((id) => id !== conta.id)
                            : [...selecionadas, conta.id],
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {conta.nickname}
                      <span className="ml-1.5 text-xs text-suave">
                        {conta.remoteDisplayName ?? conta.clientName} · {conta.timezone}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
