import { buildApp } from './app.js';
import { assertProductionSafety, loadEnv } from './config/env.js';
import { closeContainer, createContainer } from './container.js';

/**
 * Ponto de entrada da API.
 *
 * Shutdown gracioso importa mais aqui do que parece: sem ele, um deploy
 * derruba requisições em voo e — pior — pode matar o processo entre "publicou
 * no YouTube" e "gravou o remoteId no banco", produzindo o post duplicado que
 * a SPEC seção 19 proíbe.
 */

async function main(): Promise<void> {
  const env = loadEnv();

  const problems = assertProductionSafety(env);
  if (problems.length > 0) {
    console.error('Configuração insegura para produção:\n' + problems.map((p) => `  - ${p}`).join('\n'));
    process.exit(1);
  }

  const container = createContainer(env);
  const app = await buildApp(container);

  const shutdown = async (signal: string): Promise<void> => {
    container.logger.info({ signal }, 'encerrando a API...');
    // Ordem importa: parar de aceitar requisições ANTES de fechar as conexões
    // que os handlers em voo ainda estão usando.
    const timer = setTimeout(() => {
      container.logger.error('shutdown demorou demais; encerrando à força');
      process.exit(1);
    }, 15_000);
    timer.unref();

    try {
      await app.close();
      await closeContainer(container);
      container.logger.info('API encerrada com segurança');
      process.exit(0);
    } catch (error) {
      container.logger.error({ err: error }, 'falha no shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    container.logger.error({ err: reason }, 'promise rejeitada sem tratamento');
    container.errors.capture(reason, { tags: { origem: 'unhandledRejection' } });
  });
  process.on('uncaughtException', (error) => {
    container.logger.fatal({ err: error }, 'exceção não capturada — encerrando');
    container.errors.capture(error, { tags: { origem: 'uncaughtException' } });
    // Sem esperar o envio, o processo morreria antes de o relato sair — e
    // justamente o erro mais grave seria o único que nunca chega ao Sentry.
    void container.errors.close().finally(() => process.exit(1));
  });

  await app.listen({ host: env.HOST, port: env.API_PORT });

  const configured = [...container.configuredPlatforms];
  container.logger.info(
    {
      port: env.API_PORT,
      env: env.APP_ENV,
      docs: `${env.API_PUBLIC_URL}/docs`,
      plataformasConfiguradas: configured.length > 0 ? configured : 'nenhuma',
    },
    'API no ar',
  );

  if (configured.length === 0) {
    container.logger.warn(
      'Nenhuma plataforma tem credenciais configuradas neste ambiente. ' +
        'Conectar contas e publicar ficarão indisponíveis até que as credenciais ' +
        'do aplicativo sejam preenchidas no .env (ver SOCIAL_INTEGRATIONS.md).',
    );
  }
}

main().catch((error: unknown) => {
  console.error('Falha ao iniciar a API:', error);
  process.exit(1);
});
