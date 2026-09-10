import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Container } from './container.js';
import type { AppInstance } from './types.js';
import { registerModules } from './modules/index.js';
import { createAuthPlugin } from './plugins/auth.js';
import { contextPlugin } from './plugins/context.js';
import { errorsPlugin } from './plugins/errors.js';

export async function buildApp(container: Container): Promise<AppInstance> {
  const { env } = container;

  const app = Fastify({
    loggerInstance: container.logger,
    // Confia no proxy só quando há um na frente; em dev, confiar cegamente
    // deixaria qualquer cliente forjar o IP usado no rate limit.
    trustProxy: env.APP_ENV !== 'development',
    // Desligamos o log automático do Fastify: o nosso (plugins/context) já
    // emite um por resposta, com correlation id e duração.
    disableRequestLogging: true,
    bodyLimit: 5 * 1024 * 1024,
    requestIdHeader: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(contextPlugin);
  await app.register(errorsPlugin);

  await app.register(helmet, {
    // A API não serve HTML; a CSP restritiva atrapalharia só o Swagger UI.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  await app.register(cors, {
    origin: [env.WEB_PUBLIC_URL],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Correlation-Id'],
    exposedHeaders: ['X-Correlation-Id'],
  });

  await app.register(cookie, {
    secret: env.JWT_REFRESH_SECRET,
    parseOptions: {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
    },
  });

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    // Compartilhado entre réplicas: rate limit em memória por processo é
    // facilmente contornado escalando horizontalmente.
    redis: container.redis,
    nameSpace: `${env.QUEUE_PREFIX}:ratelimit:`,
    // Limite por usuário quando autenticado, por IP quando não.
    keyGenerator: (request) => request.auth?.userId ?? request.ip,
    // Health check não pode ser barrado — o orquestrador o chama sem parar.
    allowList: (request) => request.url === '/healthz' || request.url === '/readyz',
  });

  await app.register(multipart, {
    limits: {
      fileSize: env.MEDIA_MAX_UPLOAD_BYTES,
      files: 10,
    },
  });

  await app.register(createAuthPlugin(container));

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Gerenciador de Redes Sociais — API',
        description:
          'API interna versionada (SPEC seção 16). Toda rota de negócio vive sob /v1.',
        version: '1.0.0',
      },
      servers: [{ url: env.API_PUBLIC_URL }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: ({ schema, url }) => ({ schema: schema as never, url }),
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  await registerModules(app, container);

  return app;
}
