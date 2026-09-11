'use client';

import { useRef, useState } from 'react';
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
 * Biblioteca de mídia (SPEC seção 6).
 *
 * O estado de processamento aparece explicitamente: enquanto o worker de
 * FFmpeg não terminou, o sistema não sabe a duração nem a resolução do
 * arquivo — e sem isso o validador do compositor não consegue afirmar que a
 * mídia serve para a rede. Esconder isso levaria a um agendamento que falha
 * depois.
 */

interface Midia {
  id: string;
  originalFilename: string;
  mimeType: string;
  type: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  processingStatus: string;
  processingError: string | null;
  tags: string[];
  folderId: string | null;
  version: number;
  createdAt: string;
  url: string;
  thumbnailUrl: string | null;
}

interface Pasta {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  assetCount: number;
}

export default function PaginaBiblioteca() {
  const { pode } = useSessao();
  const entradaArquivo = useRef<HTMLInputElement>(null);

  const [pastaId, setPastaId] = useState('');
  const [tipo, setTipo] = useState('');
  const [busca, setBusca] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [mensagem, setMensagem] = useState<{ tom: 'sucesso' | 'erro'; texto: string } | null>(
    null,
  );
  const [detalhe, setDetalhe] = useState<Midia | null>(null);
  const [criandoPasta, setCriandoPasta] = useState(false);

  const consulta = new URLSearchParams({ limit: '60' });
  if (pastaId) consulta.set('folderId', pastaId);
  if (tipo) consulta.set('type', tipo);
  if (busca) consulta.set('search', busca);

  const { dados, carregando, recarregar } = useApi<{ assets: Midia[]; total: number }>(
    `/v1/media?${consulta.toString()}`,
    // Enquanto houver arquivo em processamento, atualiza sozinho para o
    // usuário ver a duração/resolução aparecerem.
    { refreshInterval: 15_000 },
  );

  const { dados: pastas, recarregar: recarregarPastas } = useApi<{ folders: Pasta[] }>(
    '/v1/media-folders',
  );

  async function enviarArquivos(arquivos: FileList | null) {
    if (!arquivos || arquivos.length === 0) return;

    setEnviando(true);
    setMensagem(null);

    let enviados = 0;
    let duplicados = 0;
    const falhas: string[] = [];

    for (const arquivo of Array.from(arquivos)) {
      const formulario = new FormData();
      formulario.append('file', arquivo);
      if (pastaId) formulario.append('folderId', pastaId);

      try {
        const resultado = await api<{ deduplicated: boolean }>('/v1/media', {
          method: 'POST',
          formData: formulario,
        });

        if (resultado.deduplicated) duplicados += 1;
        else enviados += 1;
      } catch (caught) {
        falhas.push(
          `${arquivo.name}: ${caught instanceof ApiError ? caught.message : 'falha no envio'}`,
        );
      }
    }

    setEnviando(false);
    if (entradaArquivo.current) entradaArquivo.current.value = '';

    const partes: string[] = [];
    if (enviados > 0) partes.push(`${enviados} arquivo(s) enviado(s)`);
    if (duplicados > 0) {
      partes.push(`${duplicados} já existia(m) na biblioteca e foram reaproveitado(s)`);
    }

    setMensagem({
      tom: falhas.length > 0 ? 'erro' : 'sucesso',
      texto: [partes.join(', '), ...falhas].filter(Boolean).join('. '),
    });

    void recarregar();
  }

  if (carregando) return <Carregando />;

  const arquivos = dados?.assets ?? [];
  const processando = arquivos.filter(
    (arquivo) => arquivo.processingStatus === 'PENDING' || arquivo.processingStatus === 'PROCESSING',
  ).length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Biblioteca de mídia</h1>
          <p className="mt-0.5 text-sm text-suave">
            {dados?.total ?? 0} arquivo(s)
            {processando > 0 && ` · ${processando} em processamento`}
          </p>
        </div>

        {pode('media:upload') && (
          <div className="flex gap-2">
            <Botao variante="secundaria" onClick={() => setCriandoPasta(true)}>
              Nova pasta
            </Botao>
            <Botao
              variante="primaria"
              carregando={enviando}
              onClick={() => entradaArquivo.current?.click()}
            >
              Enviar arquivos
            </Botao>
            <input
              ref={entradaArquivo}
              type="file"
              multiple
              className="hidden"
              accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/webm,video/x-msvideo,video/3gpp"
              onChange={(evento) => void enviarArquivos(evento.target.files)}
            />
          </div>
        )}
      </header>

      {mensagem && <Aviso tom={mensagem.tom}>{mensagem.texto}</Aviso>}

      <Cartao>
        <div className="grid gap-3 sm:grid-cols-3">
          <Selecao rotulo="Pasta" value={pastaId} onChange={(evento) => setPastaId(evento.target.value)}>
            <option value="">Todas as pastas</option>
            {(pastas?.folders ?? []).map((pasta) => (
              <option key={pasta.id} value={pasta.id}>
                {pasta.path} ({pasta.assetCount})
              </option>
            ))}
          </Selecao>

          <Selecao rotulo="Tipo" value={tipo} onChange={(evento) => setTipo(evento.target.value)}>
            <option value="">Todos</option>
            <option value="VIDEO">Vídeos</option>
            <option value="IMAGE">Imagens</option>
          </Selecao>

          <Campo
            rotulo="Buscar"
            value={busca}
            onChange={(evento) => setBusca(evento.target.value)}
            placeholder="Nome do arquivo"
          />
        </div>
      </Cartao>

      {arquivos.length === 0 ? (
        <Vazio
          titulo="Nenhum arquivo"
          descricao="Envie imagens e vídeos para usá-los no compositor."
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {arquivos.map((arquivo) => (
            <button
              key={arquivo.id}
              onClick={() => setDetalhe(arquivo)}
              className="overflow-hidden rounded-lg border border-borda text-left transition hover:bg-fundo"
            >
              <div className="relative aspect-video bg-fundo">
                {arquivo.thumbnailUrl || arquivo.type === 'IMAGE' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={arquivo.thumbnailUrl ?? arquivo.url}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-2xl text-suave">
                    ▶
                  </div>
                )}

                {arquivo.processingStatus !== 'READY' && (
                  <span className="absolute left-1.5 top-1.5">
                    <Etiqueta tom={arquivo.processingStatus === 'FAILED' ? 'erro' : 'alerta'}>
                      {arquivo.processingStatus === 'FAILED' ? 'Falhou' : 'Processando'}
                    </Etiqueta>
                  </span>
                )}
              </div>

              <div className="p-2">
                <p className="truncate text-xs font-medium">{arquivo.originalFilename}</p>
                <p className="mt-0.5 text-[11px] text-suave">
                  {formatarBytes(arquivo.sizeBytes)}
                  {arquivo.width && ` · ${arquivo.width}×${arquivo.height}`}
                  {arquivo.durationMs && ` · ${formatarDuracao(arquivo.durationMs)}`}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}

      {detalhe && (
        <ModalDetalhe
          arquivo={detalhe}
          podeExcluir={pode('media:delete')}
          aoFechar={() => setDetalhe(null)}
          aoMudar={() => {
            setDetalhe(null);
            void recarregar();
          }}
          aoAvisar={setMensagem}
        />
      )}

      {criandoPasta && (
        <ModalPasta
          pastas={pastas?.folders ?? []}
          aoFechar={() => setCriandoPasta(false)}
          aoSalvar={() => {
            setCriandoPasta(false);
            void recarregarPastas();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ModalDetalhe({
  arquivo,
  podeExcluir,
  aoFechar,
  aoMudar,
  aoAvisar,
}: {
  arquivo: Midia;
  podeExcluir: boolean;
  aoFechar: () => void;
  aoMudar: () => void;
  aoAvisar: (mensagem: { tom: 'sucesso' | 'erro'; texto: string }) => void;
}) {
  const [tags, setTags] = useState(arquivo.tags.join(', '));
  const [salvando, setSalvando] = useState(false);
  const [excluindo, setExcluindo] = useState(false);

  async function salvarTags() {
    setSalvando(true);

    try {
      await api(`/v1/media/${arquivo.id}`, {
        method: 'PATCH',
        body: {
          tags: tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
        },
      });
      aoMudar();
    } catch (caught) {
      aoAvisar({
        tom: 'erro',
        texto: caught instanceof ApiError ? caught.message : 'Não foi possível salvar.',
      });
    } finally {
      setSalvando(false);
    }
  }

  async function excluir() {
    setExcluindo(true);

    try {
      await api(`/v1/media/${arquivo.id}`, { method: 'DELETE' });
      aoAvisar({ tom: 'sucesso', texto: 'Arquivo removido da biblioteca.' });
      aoMudar();
    } catch (caught) {
      aoAvisar({
        tom: 'erro',
        texto: caught instanceof ApiError ? caught.message : 'Não foi possível excluir.',
      });
      setExcluindo(false);
    }
  }

  return (
    <Modal aberto aoFechar={aoFechar} titulo={arquivo.originalFilename} largura="lg">
      <div className="space-y-4">
        <div className="overflow-hidden rounded-lg border border-borda bg-fundo">
          {arquivo.type === 'VIDEO' ? (
            <video src={arquivo.url} controls className="max-h-96 w-full" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={arquivo.url} alt="" className="max-h-96 w-full object-contain" />
          )}
        </div>

        {arquivo.processingStatus === 'FAILED' && (
          <Aviso tom="erro" titulo="Falha no processamento">
            {arquivo.processingError ??
              'Não foi possível extrair os metadados. Reenvie o arquivo.'}
          </Aviso>
        )}

        {(arquivo.processingStatus === 'PENDING' || arquivo.processingStatus === 'PROCESSING') && (
          <Aviso tom="alerta">
            O arquivo ainda está sendo processado. Enquanto isso, duração e resolução são
            desconhecidas — o compositor não consegue validar os requisitos da rede.
          </Aviso>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-suave">Tamanho</dt>
            <dd>{formatarBytes(arquivo.sizeBytes)}</dd>
          </div>
          <div>
            <dt className="text-xs text-suave">Formato</dt>
            <dd className="truncate">{arquivo.mimeType}</dd>
          </div>
          <div>
            <dt className="text-xs text-suave">Dimensões</dt>
            <dd>{arquivo.width ? `${arquivo.width}×${arquivo.height}` : '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-suave">Duração</dt>
            <dd>{arquivo.durationMs ? formatarDuracao(arquivo.durationMs) : '—'}</dd>
          </div>
        </dl>

        <Campo
          rotulo="Tags"
          value={tags}
          onChange={(evento) => setTags(evento.target.value)}
          placeholder="curiosidades, espaço"
          dica="Separadas por vírgula."
        />

        <div className="flex flex-wrap gap-2">
          <Botao variante="primaria" carregando={salvando} onClick={() => void salvarTags()}>
            Salvar
          </Botao>
          <a href={arquivo.url} target="_blank" rel="noreferrer noopener" download>
            <Botao variante="secundaria">Baixar</Botao>
          </a>
          {podeExcluir && (
            <Botao variante="perigo" carregando={excluindo} onClick={() => void excluir()}>
              Excluir
            </Botao>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ModalPasta({
  pastas,
  aoFechar,
  aoSalvar,
}: {
  pastas: Pasta[];
  aoFechar: () => void;
  aoSalvar: () => void;
}) {
  const [nome, setNome] = useState('');
  const [paiId, setPaiId] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function criar(evento: React.FormEvent) {
    evento.preventDefault();
    setErro(null);
    setEnviando(true);

    try {
      await api('/v1/media-folders', {
        method: 'POST',
        body: { name: nome, parentId: paiId || undefined },
      });
      aoSalvar();
    } catch (caught) {
      setErro(caught instanceof ApiError ? caught.message : 'Não foi possível criar a pasta.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Modal aberto aoFechar={aoFechar} titulo="Nova pasta">
      <form onSubmit={criar} className="space-y-4">
        {erro && <Aviso tom="erro">{erro}</Aviso>}

        <Campo
          rotulo="Nome"
          value={nome}
          onChange={(evento) => setNome(evento.target.value)}
          required
          autoFocus
        />

        <Selecao rotulo="Dentro de" value={paiId} onChange={(evento) => setPaiId(evento.target.value)}>
          <option value="">Raiz</option>
          {pastas.map((pasta) => (
            <option key={pasta.id} value={pasta.id}>
              {pasta.path}
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

// ---------------------------------------------------------------------------

function formatarBytes(bytes: number): string {
  const unidades = ['B', 'KB', 'MB', 'GB'];
  let valor = bytes;
  let indice = 0;

  while (valor >= 1024 && indice < unidades.length - 1) {
    valor /= 1024;
    indice += 1;
  }

  return `${valor.toFixed(valor >= 10 || indice === 0 ? 0 : 1)} ${unidades[indice]}`;
}

function formatarDuracao(ms: number): string {
  const total = Math.round(ms / 1000);
  const horas = Math.floor(total / 3600);
  const minutos = Math.floor((total % 3600) / 60);
  const segundos = total % 60;

  if (horas > 0) {
    return `${horas}:${String(minutos).padStart(2, '0')}:${String(segundos).padStart(2, '0')}`;
  }
  return `${minutos}:${String(segundos).padStart(2, '0')}`;
}
