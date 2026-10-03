import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, createScenario, type TestHarness } from '../test/harness.js';
import { applyRetention, processDataDeletion } from './maintenance.js';

/**
 * Expurgo de dados alcançando o STORAGE (o defeito: a retenção e a exclusão
 * LGPD apagavam só a LINHA do banco; os objetos ficavam órfãos no bucket).
 *
 * O que estes testes provam, com o mock de storage instrumentado:
 *
 *  - a retenção remove o objeto e a miniatura antes de apagar a linha;
 *  - relatório expirado perde o arquivo junto com a linha;
 *  - falha no meio NÃO apaga a linha: a próxima rodada retoma (e apagar de
 *    novo um objeto que já saiu é idempotente no S3/MinIO);
 *  - a exclusão de dados da organização remove os objetos de todas as mídias
 *    e relatórios antes de derrubar a hierarquia;
 *  - falha parcial na exclusão devolve o pedido para CONFIRMED e o retry
 *    termina o trabalho sem estado extra.
 */

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness('YOUTUBE');
});

afterEach(async () => {
  await harness.cleanup();
});

async function criarMidia(
  organizationId: string,
  clientId: string,
  options: { apagadaHaDias?: number } = {},
): Promise<{ id: string; storageKey: string; thumbnailKey: string }> {
  const id = randomUUID();
  return harness.prisma.mediaAsset.create({
    data: {
      id,
      organizationId,
      clientId,
      filename: `${id}.mp4`,
      originalFilename: 'video.mp4',
      mimeType: 'video/mp4',
      type: 'VIDEO',
      sizeBytes: BigInt(5_000_000),
      storageKey: `org/${organizationId}/media/${id}.mp4`,
      thumbnailKey: `org/${organizationId}/media/${id}/thumb.jpg`,
      checksum: randomUUID().replace(/-/g, ''),
      processingStatus: 'READY',
      ...(options.apagadaHaDias !== undefined
        ? { deletedAt: new Date(Date.now() - options.apagadaHaDias * 24 * 60 * 60_000) }
        : {}),
    },
    select: { id: true, storageKey: true, thumbnailKey: true },
  });
}

describe('retenção alcança o storage', () => {
  it('objeto e miniatura saem do bucket ANTES de a linha sumir', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const midia = await criarMidia(cenario.organizationId, cenario.clientId, {
      apagadaHaDias: 400,
    });

    await applyRetention(harness.container);

    expect(harness.storageState.deletedKeys).toContain(midia.storageKey);
    expect(harness.storageState.deletedKeys).toContain(midia.thumbnailKey);

    const linha = await harness.prisma.mediaAsset.findUnique({ where: { id: midia.id } });
    expect(linha).toBeNull();
  });

  it('mídia em soft-delete recente NÃO é tocada (retenção ainda não venceu)', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const midia = await criarMidia(cenario.organizationId, cenario.clientId, {
      apagadaHaDias: 10,
    });

    await applyRetention(harness.container);

    expect(harness.storageState.deletedKeys).not.toContain(midia.storageKey);
    const linha = await harness.prisma.mediaAsset.findUnique({ where: { id: midia.id } });
    expect(linha).not.toBeNull();
  });

  it('falha ao apagar o objeto preserva a linha e a próxima rodada retoma', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const midia = await criarMidia(cenario.organizationId, cenario.clientId, {
      apagadaHaDias: 400,
    });

    // O storage falha UMA vez nesta chave (como uma oscilação de rede faria).
    harness.storageState.failNextDeletes.add(midia.storageKey);

    await applyRetention(harness.container);
    expect(harness.storageState.deletedKeys).not.toContain(midia.storageKey);

    const aindaLa = await harness.prisma.mediaAsset.findUnique({ where: { id: midia.id } });
    expect(aindaLa).not.toBeNull();

    // Segunda rodada (a injeção era de uma falha só): completa.
    await applyRetention(harness.container);
    expect(harness.storageState.deletedKeys).toContain(midia.storageKey);
    expect(harness.storageState.deletedKeys).toContain(midia.thumbnailKey);

    const removida = await harness.prisma.mediaAsset.findUnique({ where: { id: midia.id } });
    expect(removida).toBeNull();
  });

  it('relatório expirado perde o arquivo do bucket junto com a linha', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const chave = `org/${cenario.organizationId}/reports/${randomUUID()}.pdf`;

    const relatorio = await harness.prisma.report.create({
      data: {
        organizationId: cenario.organizationId,
        requestedById: cenario.userId,
        scope: 'CLIENT',
        scopeId: cenario.clientId,
        format: 'pdf',
        periodStart: new Date(Date.now() - 30 * 24 * 60 * 60_000),
        periodEnd: new Date(),
        status: 'READY',
        storageKey: chave,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    await applyRetention(harness.container);

    expect(harness.storageState.deletedKeys).toContain(chave);
    const linha = await harness.prisma.report.findUnique({ where: { id: relatorio.id } });
    expect(linha).toBeNull();
  });
});

describe('exclusão de dados (LGPD) alcança o storage', () => {
  async function pedidoConfirmado(organizationId: string, userId: string) {
    return harness.prisma.dataDeletionRequest.create({
      data: {
        organizationId,
        requestedById: userId,
        status: 'CONFIRMED',
        scheduledFor: new Date(Date.now() - 60_000),
        confirmedAt: new Date(Date.now() - 120_000),
      },
    });
  }

  function jobDeExclusao(deletionRequestId: string, organizationId: string): Job {
    return {
      id: `deletion_${deletionRequestId}`,
      name: 'process-data-deletion',
      data: { deletionRequestId, organizationId, correlationId: 'teste-exclusao' },
    } as unknown as Job;
  }

  it('remove TODOS os objetos antes de derrubar a organização', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    // Mídia NÃO apagada (sem soft-delete): a exclusão é da organização toda.
    const midia = await criarMidia(cenario.organizationId, cenario.clientId);

    const chaveRelatorio = `org/${cenario.organizationId}/reports/${randomUUID()}.pdf`;
    await harness.prisma.report.create({
      data: {
        organizationId: cenario.organizationId,
        requestedById: cenario.userId,
        scope: 'CLIENT',
        scopeId: cenario.clientId,
        format: 'pdf',
        periodStart: new Date(Date.now() - 30 * 24 * 60 * 60_000),
        periodEnd: new Date(),
        status: 'READY',
        storageKey: chaveRelatorio,
      },
    });

    const pedido = await pedidoConfirmado(cenario.organizationId, cenario.userId);

    await processDataDeletion(harness.container, jobDeExclusao(pedido.id, cenario.organizationId));

    // Cada chave saiu do bucket…
    expect(harness.storageState.deletedKeys).toContain(midia.storageKey);
    expect(harness.storageState.deletedKeys).toContain(midia.thumbnailKey);
    expect(harness.storageState.deletedKeys).toContain(chaveRelatorio);

    // …e a hierarquia inteira caiu (prova: nem o pedido sobra via cascade).
    const org = await harness.prisma.organization.findUnique({
      where: { id: cenario.organizationId },
    });
    expect(org).toBeNull();

    const pendencias = await harness.prisma.dataDeletionRequest.findMany({
      where: { id: pedido.id },
    });
    expect(pendencias).toHaveLength(0);
  });

  it('falha parcial volta o pedido para CONFIRMED e o retry termina o trabalho', async () => {
    const cenario = await createScenario(harness.prisma, { accountCount: 1 });
    const midia = await criarMidia(cenario.organizationId, cenario.clientId);

    const pedido = await pedidoConfirmado(cenario.organizationId, cenario.userId);

    // A miniatura resiste na primeira execução.
    harness.storageState.failNextDeletes.add(midia.thumbnailKey);

    await expect(
      processDataDeletion(harness.container, jobDeExclusao(pedido.id, cenario.organizationId)),
    ).rejects.toThrow(/storage/i);

    // Nada foi derrubado: a organização continua de pé e o pedido volta para
    // CONFIRMED — o retry do BullMQ reexecuta o pedido inteiro.
    const org = await harness.prisma.organization.findUnique({
      where: { id: cenario.organizationId },
    });
    expect(org).not.toBeNull();

    const pedidoPosFalha = await harness.prisma.dataDeletionRequest.findUniqueOrThrow({
      where: { id: pedido.id },
    });
    expect(pedidoPosFalha.status).toBe('CONFIRMED');

    // Retry: o objeto já removido é apagado de novo sem erro (idempotência do
    // S3), o que faltou sai agora, e a exclusão conclui.
    await processDataDeletion(harness.container, jobDeExclusao(pedido.id, cenario.organizationId));

    expect(
      harness.storageState.deletedKeys.filter((key) => key === midia.storageKey).length,
    ).toBeGreaterThanOrEqual(2); // apagada nas duas execuções, sem reclamar
    expect(harness.storageState.deletedKeys).toContain(midia.thumbnailKey);

    const orgFinal = await harness.prisma.organization.findUnique({
      where: { id: cenario.organizationId },
    });
    expect(orgFinal).toBeNull();
  }, 30_000);
});
