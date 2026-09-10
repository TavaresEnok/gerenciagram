import { JOB_GENERATE_REPORT, NotFoundError, ValidationError } from '@app/core';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { recordAudit } from '../../lib/audit.js';
import { requireAuth } from '../../plugins/auth.js';
import type { AppInstance } from '../../types.js';

/**
 * Relatórios em PDF e CSV (SPEC seção 6).
 *
 * A geração é assíncrona porque um relatório de campanha de um ano varre
 * muitos snapshots: fazer isso no request estouraria o p95 de 300ms da
 * seção 2. A API registra o pedido, o worker monta o arquivo e grava no
 * storage, e o download sai por URL assinada temporária.
 *
 * Todo relatório tem `expiresAt`: arquivo gerado é dado derivado, e a
 * política de retenção (seção 11) o expurga automaticamente.
 */

const REPORT_TTL_DAYS = 30;

const reportSchema = z.object({
  id: z.string(),
  scope: z.string(),
  scopeId: z.string().nullable(),
  format: z.string(),
  status: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  /** URL assinada, só quando o relatório está pronto. */
  downloadUrl: z.string().nullable(),
});

export async function registerReportRoutes(
  app: AppInstance,
  container: Container,
): Promise<void> {
  const { prisma } = container;

  app.get(
    '/reports',
    {
      preHandler: app.requirePermission('report:read'),
      schema: {
        tags: ['Relatórios'],
        summary: 'Lista os relatórios gerados',
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(30),
        }),
        response: { 200: z.object({ reports: z.array(reportSchema) }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      const reports = await prisma.report.findMany({
        where: { organizationId: auth.organizationId },
        orderBy: { createdAt: 'desc' },
        take: request.query.limit,
      });

      return {
        reports: await Promise.all(
          reports.map(async (report) => ({
            id: report.id,
            scope: report.scope,
            scopeId: report.scopeId,
            format: report.format,
            status: report.status,
            periodStart: report.periodStart.toISOString(),
            periodEnd: report.periodEnd.toISOString(),
            errorMessage: report.errorMessage,
            createdAt: report.createdAt.toISOString(),
            completedAt: report.completedAt?.toISOString() ?? null,
            expiresAt: report.expiresAt?.toISOString() ?? null,
            downloadUrl:
              report.status === 'READY' && report.storageKey
                ? await container.storage.getSignedDownloadUrl(report.storageKey, 900)
                : null,
          })),
        ),
      };
    },
  );

  app.post(
    '/reports',
    {
      preHandler: app.requirePermission('report:generate'),
      config: { rateLimit: { max: 30, timeWindow: 3_600_000 } },
      schema: {
        tags: ['Relatórios'],
        summary: 'Solicita a geração de um relatório',
        body: z.object({
          scope: z.enum(['CLIENT', 'CAMPAIGN', 'ACCOUNT_GROUP', 'ORGANIZATION']),
          scopeId: z.string().uuid().optional(),
          format: z.enum(['PDF', 'CSV']),
          periodStart: z.coerce.date(),
          periodEnd: z.coerce.date(),
        }),
        response: { 202: reportSchema },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { scope, scopeId, format, periodStart, periodEnd } = request.body;

      if (periodEnd < periodStart) {
        throw new ValidationError('A data final do período é anterior à inicial.');
      }
      const days = (periodEnd.getTime() - periodStart.getTime()) / (24 * 60 * 60_000);
      if (days > 400) {
        throw new ValidationError('O período máximo de um relatório é de 400 dias.');
      }
      if (scope !== 'ORGANIZATION' && !scopeId) {
        throw new ValidationError(`Informe o identificador do escopo (${scope}).`);
      }

      // Confere que o escopo existe E pertence à organização antes de
      // enfileirar: descobrir isso no worker viraria um relatório "FAILED"
      // sem explicação útil na tela.
      if (scopeId) await assertScopeExists(container, auth.organizationId, scope, scopeId);

      const report = await prisma.report.create({
        data: {
          organizationId: auth.organizationId,
          requestedById: auth.userId,
          scope,
          scopeId: scopeId ?? null,
          format,
          periodStart,
          periodEnd,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + REPORT_TTL_DAYS * 24 * 60 * 60_000),
        },
      });

      await container.queues.reports.add(
        JOB_GENERATE_REPORT,
        {
          reportId: report.id,
          organizationId: auth.organizationId,
          correlationId: request.correlationId,
        },
        { jobId: `report:${report.id}`, attempts: 3, backoff: { type: 'exponential', delay: 15_000 } },
      );

      await recordAudit(prisma, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'report.requested',
        entityType: 'Report',
        entityId: report.id,
        changes: { scope, format },
        correlationId: request.correlationId,
      });

      // 202: aceito, ainda processando. A UI faz polling ou espera a
      // notificação de conclusão.
      return reply.status(202).send({
        id: report.id,
        scope: report.scope,
        scopeId: report.scopeId,
        format: report.format,
        status: report.status,
        periodStart: report.periodStart.toISOString(),
        periodEnd: report.periodEnd.toISOString(),
        errorMessage: null,
        createdAt: report.createdAt.toISOString(),
        completedAt: null,
        expiresAt: report.expiresAt?.toISOString() ?? null,
        downloadUrl: null,
      });
    },
  );

  app.get(
    '/reports/:reportId',
    {
      preHandler: app.requirePermission('report:read'),
      schema: {
        tags: ['Relatórios'],
        summary: 'Estado de um relatório e link de download',
        params: z.object({ reportId: z.string().uuid() }),
        response: { 200: reportSchema },
      },
    },
    async (request) => {
      const auth = requireAuth(request);

      const report = await prisma.report.findFirst({
        where: { id: request.params.reportId, organizationId: auth.organizationId },
      });
      if (!report) throw new NotFoundError('Relatório', request.params.reportId);

      return {
        id: report.id,
        scope: report.scope,
        scopeId: report.scopeId,
        format: report.format,
        status: report.status,
        periodStart: report.periodStart.toISOString(),
        periodEnd: report.periodEnd.toISOString(),
        errorMessage: report.errorMessage,
        createdAt: report.createdAt.toISOString(),
        completedAt: report.completedAt?.toISOString() ?? null,
        expiresAt: report.expiresAt?.toISOString() ?? null,
        downloadUrl:
          report.status === 'READY' && report.storageKey
            ? await container.storage.getSignedDownloadUrl(report.storageKey, 900)
            : null,
      };
    },
  );
}

async function assertScopeExists(
  container: Container,
  organizationId: string,
  scope: string,
  scopeId: string,
): Promise<void> {
  const exists = await (async () => {
    switch (scope) {
      case 'CLIENT':
        return container.prisma.client.findFirst({
          where: { id: scopeId, organizationId, deletedAt: null },
          select: { id: true },
        });
      case 'CAMPAIGN':
        return container.prisma.campaign.findFirst({
          where: { id: scopeId, organizationId, deletedAt: null },
          select: { id: true },
        });
      case 'ACCOUNT_GROUP':
        return container.prisma.accountGroup.findFirst({
          where: { id: scopeId, organizationId, deletedAt: null },
          select: { id: true },
        });
      default:
        return null;
    }
  })();

  if (!exists) throw new NotFoundError(scope, scopeId);
}
