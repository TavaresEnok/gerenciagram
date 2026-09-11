import { JOB_PUBLISH_TARGET, publishJobId } from '@app/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, createScenario, type TestHarness } from '../test/harness.js';
import { reconcileOrphanTargets } from './maintenance.js';

describe('reconcileOrphanTargets (Outbox Pattern Recovery)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness('YOUTUBE');
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  it('reconcilia e reenfileira destinos SCHEDULED e QUEUED órfãos contra Postgres real', async () => {
    const scenario = await createScenario(harness.prisma, { accountCount: 3 });
    const [targetOrphanScheduled, targetOrphanQueued, targetHealthyQueued] = scenario.targets;

    const now = Date.now();

    // 1. Alvo SCHEDULED que venceu e nunca foi para a fila (ex.: queda da API antes de enqueue)
    await harness.prisma.postTarget.update({
      where: { id: targetOrphanScheduled!.id },
      data: {
        status: 'SCHEDULED',
        scheduledAt: new Date(now - 120_000), // 2 min atrás
        jobId: null,
      },
    });

    // 2. Alvo QUEUED com horário no passado cujo job no Redis foi perdido
    await harness.prisma.postTarget.update({
      where: { id: targetOrphanQueued!.id },
      data: {
        status: 'QUEUED',
        scheduledAt: new Date(now - 600_000), // 10 min atrás
        jobId: publishJobId(targetOrphanQueued!.id),
      },
    });

    // 3. Alvo QUEUED saudável cujo job AINDA existe na fila
    await harness.prisma.postTarget.update({
      where: { id: targetHealthyQueued!.id },
      data: {
        status: 'QUEUED',
        scheduledAt: new Date(now - 600_000),
        jobId: publishJobId(targetHealthyQueued!.id),
      },
    });

    const addedJobs: Array<{ name: string; data: any; opts: any }> = [];
    const existingJobs = new Map<string, any>([
      [
        publishJobId(targetHealthyQueued!.id),
        {
          id: publishJobId(targetHealthyQueued!.id),
          isFailed: async () => false,
          remove: async () => undefined,
        },
      ],
    ]);

    const fakeQueue = {
      getJob: async (id: string) => existingJobs.get(id) ?? null,
      add: async (name: string, data: any, opts: any) => {
        addedJobs.push({ name, data, opts });
        existingJobs.set(opts.jobId, { id: opts.jobId, isFailed: async () => false });
      },
    };

    // Executa a reconciliação
    const recoveredCount = await reconcileOrphanTargets(harness.container, fakeQueue as any);

    expect(recoveredCount).toBe(2);
    expect(addedJobs).toHaveLength(2);

    // Confirma que os jobs foram adicionados com delay zero (imediato)
    for (const job of addedJobs) {
      expect(job.name).toBe(JOB_PUBLISH_TARGET);
      expect(job.opts.delay).toBe(0);
    }

    // Valida que o target 1 e 2 no banco agora estão em QUEUED com jobId preenchido
    const updated1 = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: targetOrphanScheduled!.id },
    });
    expect(updated1.status).toBe('QUEUED');
    expect(updated1.jobId).toBe(publishJobId(targetOrphanScheduled!.id));

    const updated2 = await harness.prisma.postTarget.findUniqueOrThrow({
      where: { id: targetOrphanQueued!.id },
    });
    expect(updated2.status).toBe('QUEUED');
    expect(updated2.jobId).toBe(publishJobId(targetOrphanQueued!.id));

    // Valida que o target saudável (3) não foi reinserido nem duplicado
    const healthyJobAdds = addedJobs.filter(
      (j) => j.data.postTargetId === targetHealthyQueued!.id,
    );
    expect(healthyJobAdds).toHaveLength(0);
  });

  it('é estritamente idempotente (segunda execução com jobs presentes não duplica)', async () => {
    const scenario = await createScenario(harness.prisma, { accountCount: 1 });
    const target = scenario.targets[0]!;

    await harness.prisma.postTarget.update({
      where: { id: target.id },
      data: {
        status: 'SCHEDULED',
        scheduledAt: new Date(Date.now() - 60_000),
      },
    });

    const existingJobs = new Map<string, any>();
    const fakeQueue = {
      getJob: async (id: string) => existingJobs.get(id) ?? null,
      add: async (_name: string, _data: any, opts: any) => {
        existingJobs.set(opts.jobId, { id: opts.jobId, isFailed: async () => false });
      },
    };

    // 1ª rodada: recupera o órfão
    const firstRun = await reconcileOrphanTargets(harness.container, fakeQueue as any);
    expect(firstRun).toBe(1);

    // 2ª rodada: como o job agora existe no Redis e o status está QUEUED, não recupera novamente
    const secondRun = await reconcileOrphanTargets(harness.container, fakeQueue as any);
    expect(secondRun).toBe(0);
  });

  it('ignora completamente alvos finalizados (PUBLISHED ou CANCELLED)', async () => {
    const scenario = await createScenario(harness.prisma, { accountCount: 2 });
    const [targetPublished, targetCancelled] = scenario.targets;

    await harness.prisma.postTarget.update({
      where: { id: targetPublished!.id },
      data: {
        status: 'PUBLISHED',
        scheduledAt: new Date(Date.now() - 60_000),
        publishedAt: new Date(),
      },
    });

    await harness.prisma.postTarget.update({
      where: { id: targetCancelled!.id },
      data: {
        status: 'CANCELLED',
        scheduledAt: new Date(Date.now() - 60_000),
      },
    });

    const fakeQueue = {
      getJob: async () => null,
      add: async () => undefined,
    };

    const count = await reconcileOrphanTargets(harness.container, fakeQueue as any);
    expect(count).toBe(0);
  });
});
