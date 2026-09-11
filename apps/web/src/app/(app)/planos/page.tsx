'use client';

import { useState } from 'react';
import { Aviso, Botao, Cartao, Carregando, Etiqueta } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApi, useSessao } from '@/lib/sessao';

/**
 * Plano, limites e uso.
 *
 * O botão de troca de plano existe, mas a tela diz claramente que não há
 * cobrança integrada — o backend devolve `paymentIntegrationActive: false`.
 * A SPEC seção 19 proíbe simular integração: melhor um aviso honesto do que
 * um checkout que não cobra nada.
 */

interface Assinatura {
  plan: { tier: string; name: string; priceCents: number; currency: string; limits: Record<string, unknown> } | null;
  status: string | null;
  effectiveLimits: Record<string, unknown>;
  usage: Record<string, number>;
  exceeded: Array<{ limit: string; used: number; max: number }>;
  paymentIntegrationActive: boolean;
}

const ROTULOS: Record<string, string> = {
  maxSocialAccounts: 'Contas conectadas',
  maxUsers: 'Usuários',
  maxClients: 'Clientes/Marcas',
  maxAccountGroups: 'Grupos de contas',
  maxScheduledPosts: 'Publicações agendadas',
  maxStorageBytes: 'Armazenamento',
  aiCreditsPerMonth: 'Créditos de IA / mês',
};

export default function PaginaPlanos() {
  const { pode } = useSessao();
  const { dados, carregando, recarregar } = useApi<Assinatura>('/v1/billing/subscription');
  const { dados: planos } = useApi<{
    plans: Array<{ tier: string; name: string; priceCents: number; limits: Record<string, unknown> }>;
  }>('/v1/billing/plans');

  const [mensagem, setMensagem] = useState<{ tom: 'sucesso' | 'erro'; texto: string } | null>(
    null,
  );
  const [trocando, setTrocando] = useState<string | null>(null);

  async function trocarPlano(tier: string) {
    setTrocando(tier);

    try {
      const resultado = await api<{ paymentRequired: boolean; plan: { name: string } }>(
        '/v1/billing/change-plan',
        { method: 'POST', body: { tier } },
      );

      setMensagem({
        tom: 'sucesso',
        texto: resultado.paymentRequired
          ? `Plano alterado para ${resultado.plan.name}. A cobrança ainda não está integrada neste ambiente — nada foi cobrado.`
          : `Plano alterado para ${resultado.plan.name}.`,
      });
      void recarregar();
    } catch (caught) {
      setMensagem({
        tom: 'erro',
        texto: caught instanceof ApiError ? caught.message : 'Não foi possível trocar o plano.',
      });
    } finally {
      setTrocando(null);
    }
  }

  if (carregando || !dados) return <Carregando />;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Plano e limites</h1>
        <p className="mt-0.5 text-sm text-suave">
          {dados.plan ? `Plano atual: ${dados.plan.name}` : 'Sem plano associado'}
        </p>
      </header>

      {mensagem && <Aviso tom={mensagem.tom}>{mensagem.texto}</Aviso>}

      {!dados.paymentIntegrationActive && (
        <Aviso tom="alerta" titulo="Cobrança não integrada">
          Não há gateway de pagamento configurado neste ambiente. Trocar de plano ajusta os
          limites, mas nenhuma cobrança é feita. A integração real exige credenciais e contrato
          com o provedor de pagamento.
        </Aviso>
      )}

      {dados.exceeded.length > 0 && (
        <Aviso tom="erro" titulo="Limites atingidos">
          <ul className="space-y-1">
            {dados.exceeded.map((item) => (
              <li key={item.limit}>
                {ROTULOS[item.limit] ?? item.limit}: {formatar(item.limit, item.used)} de{' '}
                {formatar(item.limit, item.max)}
              </li>
            ))}
          </ul>
        </Aviso>
      )}

      <Cartao titulo="Uso atual">
        <div className="space-y-3">
          {Object.entries(dados.usage).map(([chave, usado]) => {
            const limite = dados.effectiveLimits[chave];
            const max = typeof limite === 'number' ? limite : null;
            const ilimitado = max === -1 || max === null;
            const percentual = ilimitado ? 0 : Math.min(100, (usado / Math.max(1, max)) * 100);

            return (
              <div key={chave}>
                <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                  <span>{ROTULOS[chave] ?? chave}</span>
                  <span className="tabular-nums text-suave">
                    {formatar(chave, usado)}
                    {ilimitado ? ' / ilimitado' : ` / ${formatar(chave, max)}`}
                  </span>
                </div>

                {!ilimitado && (
                  <div
                    className="h-1.5 overflow-hidden rounded-full bg-fundo"
                    role="progressbar"
                    aria-valuenow={Math.round(percentual)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={ROTULOS[chave] ?? chave}
                  >
                    <div
                      className={
                        percentual >= 100
                          ? 'h-full bg-erro'
                          : percentual >= 80
                            ? 'h-full bg-alerta'
                            : 'h-full bg-sucesso'
                      }
                      style={{ width: `${percentual}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Cartao>

      <Cartao titulo="Planos disponíveis">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(planos?.plans ?? []).map((plano) => {
            const atual = plano.tier === dados.plan?.tier;

            return (
              <div
                key={plano.tier}
                className={
                  atual
                    ? 'rounded-lg border-2 border-primaria p-4'
                    : 'rounded-lg border border-borda p-4'
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{plano.name}</p>
                  {atual && <Etiqueta tom="info">Atual</Etiqueta>}
                </div>

                <p className="mt-1 text-xl font-semibold tabular-nums">
                  {plano.priceCents === 0
                    ? plano.tier === 'ENTERPRISE'
                      ? 'Sob consulta'
                      : 'Grátis'
                    : `R$ ${(plano.priceCents / 100).toFixed(2).replace('.', ',')}`}
                  {plano.priceCents > 0 && <span className="text-xs text-suave"> /mês</span>}
                </p>

                <ul className="mt-3 space-y-1 text-xs text-suave">
                  {['maxSocialAccounts', 'maxUsers', 'maxClients', 'maxStorageBytes'].map(
                    (chave) => {
                      const valor = plano.limits[chave];
                      if (typeof valor !== 'number') return null;

                      return (
                        <li key={chave}>
                          {ROTULOS[chave]}: {valor === -1 ? 'ilimitado' : formatar(chave, valor)}
                        </li>
                      );
                    },
                  )}
                </ul>

                {pode('org:manage_billing') && !atual && (
                  <Botao
                    variante="secundaria"
                    className="mt-3 w-full"
                    carregando={trocando === plano.tier}
                    onClick={() => void trocarPlano(plano.tier)}
                  >
                    Mudar para {plano.name}
                  </Botao>
                )}
              </div>
            );
          })}
        </div>
      </Cartao>
    </div>
  );
}

function formatar(chave: string, valor: number): string {
  if (chave === 'maxStorageBytes') {
    const unidades = ['B', 'KB', 'MB', 'GB', 'TB'];
    let numero = valor;
    let indice = 0;

    while (numero >= 1024 && indice < unidades.length - 1) {
      numero /= 1024;
      indice += 1;
    }
    return `${numero.toFixed(numero >= 10 || indice === 0 ? 0 : 1)} ${unidades[indice]}`;
  }

  return valor.toLocaleString('pt-BR');
}
