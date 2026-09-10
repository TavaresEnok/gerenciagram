import { getPlatformDefinition, type GenerateReportPayload, type PlatformKey } from '@app/core';
import type { Job } from 'bullmq';
import PDFDocument from 'pdfkit';
import type { WorkerContainer } from '../container.js';
import { notify } from '../lib/notifications.js';

/**
 * Geração de relatórios (SPEC seção 6).
 *
 * CSV e PDF a partir dos MESMOS dados, montados uma vez só: se as duas saídas
 * fossem construídas por caminhos diferentes, um cliente que exportasse os
 * dois formatos veria números divergentes no mesmo período.
 *
 * Métricas ausentes aparecem como "—", nunca como zero. Num relatório
 * entregue a cliente, um zero inventado é pior que um campo vazio.
 */

interface ReportRow {
  data: string;
  conta: string;
  rede: string;
  titulo: string;
  status: string;
  publicadoEm: string;
  link: string;
  visualizacoes: number | null;
  curtidas: number | null;
  comentarios: number | null;
  compartilhamentos: number | null;
  alcance: number | null;
}

interface ReportData {
  titulo: string;
  periodo: { inicio: Date; fim: Date };
  organizacao: string;
  escopo: string;
  linhas: ReportRow[];
  resumo: {
    publicacoes: number;
    publicadas: number;
    falhas: number;
    contas: number;
    metricas: Record<string, number>;
    metricasIndisponiveis: string[];
  };
}

export async function processGenerateReport(
  container: WorkerContainer,
  job: Job<GenerateReportPayload>,
): Promise<void> {
  const { reportId, correlationId } = job.data;
  const log = container.logger.child({ correlationId, reportId });

  const report = await container.prisma.report.findUnique({ where: { id: reportId } });
  if (!report) {
    log.warn('relatório inexistente');
    return;
  }
  if (report.status === 'READY') {
    log.debug('relatório já gerado — job ignorado');
    return;
  }

  await container.prisma.report.update({
    where: { id: reportId },
    data: { status: 'PROCESSING', errorMessage: null },
  });

  try {
    const data = await collectData(container, report);

    const buffer =
      report.format === 'CSV' ? buildCsv(data) : await buildPdf(data);

    const key = `org/${report.organizationId}/reports/${reportId}.${report.format.toLowerCase()}`;

    await container.storage.putObject(
      key,
      buffer,
      report.format === 'CSV' ? 'text/csv; charset=utf-8' : 'application/pdf',
    );

    await container.prisma.report.update({
      where: { id: reportId },
      data: { status: 'READY', storageKey: key, completedAt: new Date() },
    });

    log.info({ formato: report.format, linhas: data.linhas.length }, 'relatório gerado');

    await notify(container, {
      organizationId: report.organizationId,
      type: 'REPORT_READY',
      title: 'Relatório pronto',
      body: `O relatório ${data.titulo} está disponível para download.`,
      actionUrl: `/relatorios?relatorio=${reportId}`,
      ...(report.requestedById ? { userIds: [report.requestedById] } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await container.prisma.report.update({
      where: { id: reportId },
      data: { status: 'FAILED', errorMessage: message.slice(0, 2000) },
    });

    log.error({ err: error }, 'falha ao gerar o relatório');
    throw error;
  }
}

// ---------------------------------------------------------------------------

async function collectData(
  container: WorkerContainer,
  report: {
    id: string;
    organizationId: string;
    scope: string;
    scopeId: string | null;
    periodStart: Date;
    periodEnd: Date;
  },
): Promise<ReportData> {
  const organization = await container.prisma.organization.findUniqueOrThrow({
    where: { id: report.organizationId },
    select: { name: true },
  });

  const scopeFilter = buildScopeFilter(report.scope, report.scopeId);
  const escopo = await describeScope(container, report.scope, report.scopeId);

  const targets = await container.prisma.postTarget.findMany({
    where: {
      organizationId: report.organizationId,
      deletedAt: null,
      OR: [
        { publishedAt: { gte: report.periodStart, lte: report.periodEnd } },
        {
          scheduledAt: { gte: report.periodStart, lte: report.periodEnd },
          status: { in: ['FAILED', 'CANCELLED', 'SCHEDULED', 'QUEUED'] },
        },
      ],
      ...scopeFilter,
    },
    include: {
      socialAccount: { select: { nickname: true } },
      post: { select: { content: { select: { title: true, body: true } } } },
      analytics: { orderBy: { capturedFor: 'desc' }, take: 1 },
    },
    orderBy: [{ publishedAt: 'desc' }, { scheduledAt: 'desc' }],
  });

  const linhas: ReportRow[] = targets.map((target) => {
    const snapshot = target.analytics[0];
    const content = target.post.content;

    return {
      data: (target.publishedAt ?? target.scheduledAt ?? target.createdAt)
        .toISOString()
        .slice(0, 10),
      conta: target.socialAccount.nickname,
      rede: getPlatformDefinition(target.platform as PlatformKey).displayName,
      titulo: content.title ?? content.body.slice(0, 80),
      status: traduzirStatus(target.status),
      publicadoEm: target.publishedAt?.toISOString() ?? '',
      link: target.remoteUrl ?? '',
      visualizacoes: snapshot?.views ?? null,
      curtidas: snapshot?.likes ?? null,
      comentarios: snapshot?.comments ?? null,
      compartilhamentos: snapshot?.shares ?? null,
      alcance: snapshot?.reach ?? null,
    };
  });

  const metricas: Record<string, number> = {};
  const indisponiveis: string[] = [];

  for (const [rotulo, campo] of [
    ['Visualizações', 'visualizacoes'],
    ['Curtidas', 'curtidas'],
    ['Comentários', 'comentarios'],
    ['Compartilhamentos', 'compartilhamentos'],
    ['Alcance', 'alcance'],
  ] as const) {
    const valores = linhas
      .map((linha) => linha[campo])
      .filter((valor): valor is number => valor !== null);

    if (valores.length === 0) indisponiveis.push(rotulo);
    else metricas[rotulo] = valores.reduce((soma, valor) => soma + valor, 0);
  }

  return {
    titulo: `Relatório — ${escopo}`,
    periodo: { inicio: report.periodStart, fim: report.periodEnd },
    organizacao: organization.name,
    escopo,
    linhas,
    resumo: {
      publicacoes: linhas.length,
      publicadas: targets.filter((target) => target.status === 'PUBLISHED').length,
      falhas: targets.filter((target) => target.status === 'FAILED').length,
      contas: new Set(targets.map((target) => target.socialAccountId)).size,
      metricas,
      metricasIndisponiveis: indisponiveis,
    },
  };
}

function buildScopeFilter(scope: string, scopeId: string | null): Record<string, unknown> {
  if (!scopeId) return {};

  switch (scope) {
    case 'CLIENT':
      return { post: { clientId: scopeId, deletedAt: null } };
    case 'CAMPAIGN':
      return { post: { campaignId: scopeId, deletedAt: null } };
    case 'ACCOUNT_GROUP':
      return {
        socialAccount: { groupMemberships: { some: { accountGroupId: scopeId } } },
      };
    default:
      return {};
  }
}

async function describeScope(
  container: WorkerContainer,
  scope: string,
  scopeId: string | null,
): Promise<string> {
  if (!scopeId) return 'Organização inteira';

  const nome = await (async () => {
    switch (scope) {
      case 'CLIENT':
        return (
          await container.prisma.client.findUnique({
            where: { id: scopeId },
            select: { name: true },
          })
        )?.name;
      case 'CAMPAIGN':
        return (
          await container.prisma.campaign.findUnique({
            where: { id: scopeId },
            select: { name: true },
          })
        )?.name;
      case 'ACCOUNT_GROUP':
        return (
          await container.prisma.accountGroup.findUnique({
            where: { id: scopeId },
            select: { name: true },
          })
        )?.name;
      default:
        return undefined;
    }
  })();

  return nome ?? scopeId;
}

function traduzirStatus(status: string): string {
  const mapa: Record<string, string> = {
    PUBLISHED: 'Publicado',
    FAILED: 'Falhou',
    CANCELLED: 'Cancelado',
    SCHEDULED: 'Agendado',
    QUEUED: 'Na fila',
    PUBLISHING: 'Publicando',
    PENDING: 'Pendente',
    SKIPPED: 'Ignorado',
  };
  return mapa[status] ?? status;
}

// ---------------------------------------------------------------------------

function buildCsv(data: ReportData): Buffer {
  const cabecalho = [
    'Data',
    'Conta',
    'Rede',
    'Título',
    'Status',
    'Publicado em',
    'Link',
    'Visualizações',
    'Curtidas',
    'Comentários',
    'Compartilhamentos',
    'Alcance',
  ];

  const linhas = data.linhas.map((linha) => [
    linha.data,
    linha.conta,
    linha.rede,
    linha.titulo,
    linha.status,
    linha.publicadoEm,
    linha.link,
    // Vazio, não zero: a métrica não veio da API.
    linha.visualizacoes ?? '',
    linha.curtidas ?? '',
    linha.comentarios ?? '',
    linha.compartilhamentos ?? '',
    linha.alcance ?? '',
  ]);

  const conteudo = [cabecalho, ...linhas]
    .map((linha) => linha.map(escapeCsv).join(';'))
    .join('\r\n');

  // BOM UTF-8: sem ele o Excel em português abre acentos como lixo.
  // Separador ";" pelo mesmo motivo — é o padrão da configuração pt-BR.
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(conteudo, 'utf8')]);
}

function escapeCsv(valor: string | number): string {
  const texto = String(valor);
  if (/[";\r\n]/.test(texto)) return `"${texto.replace(/"/g, '""')}"`;
  return texto;
}

async function buildPdf(data: ReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, layout: 'landscape' });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const formatarData = (date: Date): string =>
      date.toLocaleDateString('pt-BR', { timeZone: 'UTC' });

    // --- Cabeçalho ---
    doc.fontSize(18).text(data.titulo, { align: 'left' });
    doc.moveDown(0.3);
    doc
      .fontSize(10)
      .fillColor('#555')
      .text(`${data.organizacao}`)
      .text(
        `Período: ${formatarData(data.periodo.inicio)} a ${formatarData(data.periodo.fim)}`,
      )
      .text(`Gerado em: ${new Date().toLocaleString('pt-BR')}`);

    doc.moveDown(1);

    // --- Resumo ---
    doc.fillColor('#000').fontSize(13).text('Resumo');
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#333');
    doc.text(
      `${data.resumo.publicacoes} destino(s) no período · ` +
        `${data.resumo.publicadas} publicado(s) · ` +
        `${data.resumo.falhas} com falha · ` +
        `${data.resumo.contas} conta(s)`,
    );

    if (Object.keys(data.resumo.metricas).length > 0) {
      doc.moveDown(0.2);
      doc.text(
        Object.entries(data.resumo.metricas)
          .map(([rotulo, valor]) => `${rotulo}: ${valor.toLocaleString('pt-BR')}`)
          .join('  ·  '),
      );
    }

    if (data.resumo.metricasIndisponiveis.length > 0) {
      doc.moveDown(0.2);
      doc
        .fillColor('#8a6d3b')
        .text(
          `Métricas não fornecidas pela API oficial das redes deste relatório: ` +
            `${data.resumo.metricasIndisponiveis.join(', ')}.`,
        );
    }

    doc.moveDown(1);

    // --- Tabela ---
    const colunas = [
      { titulo: 'Data', largura: 60 },
      { titulo: 'Conta', largura: 110 },
      { titulo: 'Rede', largura: 60 },
      { titulo: 'Título', largura: 190 },
      { titulo: 'Status', largura: 60 },
      { titulo: 'Views', largura: 55 },
      { titulo: 'Curtidas', largura: 55 },
      { titulo: 'Coment.', largura: 55 },
      { titulo: 'Comp.', largura: 55 },
      { titulo: 'Alcance', largura: 55 },
    ];

    const alturaLinha = 16;
    const inicioX = doc.page.margins.left;

    const desenharCabecalho = (): void => {
      doc.fillColor('#000').fontSize(9);
      let x = inicioX;
      const y = doc.y;

      for (const coluna of colunas) {
        doc.text(coluna.titulo, x, y, { width: coluna.largura, ellipsis: true });
        x += coluna.largura;
      }

      doc.moveTo(inicioX, y + alturaLinha - 4)
        .lineTo(inicioX + colunas.reduce((soma, c) => soma + c.largura, 0), y + alturaLinha - 4)
        .strokeColor('#ccc')
        .stroke();

      doc.y = y + alturaLinha;
    };

    desenharCabecalho();
    doc.fontSize(8).fillColor('#333');

    for (const linha of data.linhas) {
      // Quebra de página: repete o cabeçalho, senão as colunas viram adivinhação.
      if (doc.y + alturaLinha > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        doc.fontSize(9);
        desenharCabecalho();
        doc.fontSize(8).fillColor('#333');
      }

      const valores = [
        linha.data,
        linha.conta,
        linha.rede,
        linha.titulo,
        linha.status,
        linha.visualizacoes?.toLocaleString('pt-BR') ?? '—',
        linha.curtidas?.toLocaleString('pt-BR') ?? '—',
        linha.comentarios?.toLocaleString('pt-BR') ?? '—',
        linha.compartilhamentos?.toLocaleString('pt-BR') ?? '—',
        linha.alcance?.toLocaleString('pt-BR') ?? '—',
      ];

      let x = inicioX;
      const y = doc.y;

      for (let index = 0; index < colunas.length; index += 1) {
        doc.text(valores[index] ?? '', x, y, {
          width: colunas[index]!.largura,
          height: alturaLinha,
          ellipsis: true,
          lineBreak: false,
        });
        x += colunas[index]!.largura;
      }

      doc.y = y + alturaLinha;
    }

    if (data.linhas.length === 0) {
      doc.moveDown(1).fillColor('#666').text('Nenhuma publicação no período selecionado.');
    }

    doc.end();
  });
}
