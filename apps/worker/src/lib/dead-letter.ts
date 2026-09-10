import type { WorkerContainer } from '../container.js';

/**
 * Dead-letter queue (SPEC seção 12).
 *
 * Job que esgotou as tentativas vai para uma tabela visível no painel admin.
 * A regra que isto implementa é a da especificação: "nunca somem
 * silenciosamente". Um job perdido numa fila é uma publicação que o cliente
 * acha que saiu e não saiu.
 */

export interface DeadLetterInput {
  queueName: string;
  jobName: string;
  jobId: string | null;
  organizationId?: string | null;
  payload: Record<string, unknown>;
  attemptsMade: number;
  failedReason: string;
  stackTrace?: string;
  correlationId?: string;
}

export async function recordDeadLetter(
  container: WorkerContainer,
  input: DeadLetterInput,
): Promise<void> {
  try {
    await container.prisma.deadLetterJob.create({
      data: {
        queueName: input.queueName,
        jobName: input.jobName,
        jobId: input.jobId,
        organizationId: input.organizationId ?? null,
        payload: input.payload as object,
        attemptsMade: input.attemptsMade,
        failedReason: input.failedReason.slice(0, 4000),
        stackTrace: input.stackTrace?.slice(0, 8000) ?? null,
        correlationId: input.correlationId ?? null,
      },
    });
  } catch (error) {
    // Falhar ao registrar a dead-letter não pode derrubar o worker — mas
    // precisa gritar no log, porque significa que perdemos a rastreabilidade.
    container.logger.error(
      { err: error, queue: input.queueName, jobId: input.jobId },
      'não foi possível registrar o job na dead-letter queue',
    );
  }
}
