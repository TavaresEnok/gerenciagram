import { DomainError, ValidationError } from '@app/core';
import type { ErrorReporter } from '@app/platform';
import { Prisma } from '@app/db';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';

/**
 * Tratamento central de erros.
 *
 * Princípio: o cliente recebe uma mensagem útil e um `code` estável; detalhe
 * interno (stack, SQL, nome de coluna) fica só no log. Um 500 com stack no
 * corpo é o tipo de coisa que vira vetor de reconhecimento em produção.
 */

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    correlationId: string;
  };
}

export interface ErrorsPluginOptions {
  /** Coletor externo. Recebe SÓ o erro inesperado — ver o ramo final. */
  errors?: ErrorReporter;
}

export const errorsPlugin = fp<ErrorsPluginOptions>(async (app, options) => {
  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.correlationId ?? '';

    // --- Erros de validação de entrada -------------------------------------
    if (error instanceof ZodError) {
      request.log.debug({ issues: error.issues }, 'entrada inválida');
      return reply.status(422).send(<ErrorBody>{
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Os dados enviados são inválidos.',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
          correlationId,
        },
      });
    }

    // fastify-type-provider-zod embrulha o ZodError
    const wrapped = (error as { validation?: unknown; cause?: unknown }).cause;
    if (wrapped instanceof ZodError) {
      return reply.status(422).send(<ErrorBody>{
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Os dados enviados são inválidos.',
          details: wrapped.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
          correlationId,
        },
      });
    }

    // O provider do Zod converte as issues em `error.validation` antes de
    // chegarem aqui. Sem este ramo, a resposta sairia como FST_ERR_VALIDATION
    // com status 400, em vez do 422 no mesmo formato dos demais erros de
    // validação — e o frontend teria que tratar dois formatos.
    const fastifyValidation = (
      error as {
        validation?: Array<{ instancePath?: string; message?: string }>;
      }
    ).validation;

    if (Array.isArray(fastifyValidation) && fastifyValidation.length > 0) {
      return reply.status(422).send(<ErrorBody>{
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Os dados enviados são inválidos.',
          details: fastifyValidation.map((issue) => ({
            path: (issue.instancePath ?? '').replace(/^\//, '').split('/').join('.'),
            message: issue.message ?? 'valor inválido',
          })),
          correlationId,
        },
      });
    }

    // --- Erros de domínio --------------------------------------------------
    if (error instanceof DomainError) {
      const level = error.httpStatus >= 500 ? 'error' : 'warn';
      request.log[level]({ code: error.code, details: error.details }, error.message);

      return reply.status(error.httpStatus).send(<ErrorBody>{
        error: {
          code: error.code,
          message: (error as Error).message,
          ...(error.details !== undefined ? { details: error.details } : {}),
          correlationId,
        },
      });
    }

    // --- Erros do Prisma ---------------------------------------------------
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      request.log.warn({ prismaCode: error.code, meta: error.meta }, 'erro do banco');

      if (error.code === 'P2002') {
        return reply.status(409).send(<ErrorBody>{
          error: {
            code: 'CONFLICT',
            message: 'Já existe um registro com estes dados.',
            details: { fields: error.meta?.['target'] },
            correlationId,
          },
        });
      }
      if (error.code === 'P2025') {
        return reply.status(404).send(<ErrorBody>{
          error: { code: 'NOT_FOUND', message: 'Registro não encontrado.', correlationId },
        });
      }
      if (error.code === 'P2003') {
        return reply.status(422).send(<ErrorBody>{
          error: {
            code: 'INVALID_REFERENCE',
            message: 'Um dos registros referenciados não existe.',
            correlationId,
          },
        });
      }
    }

    // --- Rate limit do Fastify --------------------------------------------
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send(<ErrorBody>{
        error: {
          code: 'RATE_LIMITED',
          message: 'Muitas requisições. Tente novamente em instantes.',
          correlationId,
        },
      });
    }

    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;

    if (statusCode < 500) {
      return reply.status(statusCode).send(<ErrorBody>{
        error: {
          code: (error as { code?: string }).code ?? 'BAD_REQUEST',
          message: (error as Error).message,
          correlationId,
        },
      });
    }

    // --- Inesperado --------------------------------------------------------
    request.log.error({ err: error }, 'erro não tratado');

    // Só este ramo vai para o Sentry. 404, 422, conflito e erro de domínio
    // são respostas esperadas; mandá-los enterraria o incidente real em ruído.
    options.errors?.capture(error, {
      correlationId,
      organizationId: request.auth?.organizationId,
      tags: { method: request.method, route: request.routeOptions.url ?? 'desconhecida' },
    });

    return reply.status(500).send(<ErrorBody>{
      error: {
        code: 'INTERNAL_ERROR',
        message:
          'Erro interno. Informe o identificador abaixo ao suporte para rastrearmos o ocorrido.',
        correlationId,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send(<ErrorBody>{
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: `Rota não encontrada: ${request.method} ${request.url}`,
        correlationId: request.correlationId ?? '',
      },
    });
  });
}, { name: 'errors' });

export { ValidationError };
