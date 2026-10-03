import type { PrismaClient } from '@app/db';

/**
 * Recalcula o status agregado do post a partir dos destinos.
 *
 * `Post.status` é DERIVADO — quem sabe se publicou é o `PostTarget`. O estado
 * `PARTIALLY_PUBLISHED` existe justamente para o caso central da SPEC: 17
 * sucessos e 3 falhas não é "publicado" nem "falhou", e chamar de um dos dois
 * esconderia do usuário exatamente a informação que ele precisa.
 */
export async function recomputePostStatus(
  prisma: PrismaClient,
  postId: string,
): Promise<void> {
  const targets = await prisma.postTarget.findMany({
    where: { postId, deletedAt: null },
    select: { status: true, publishedAt: true },
  });

  if (targets.length === 0) return;

  const total = targets.length;
  const count = (status: string): number =>
    targets.filter((target) => target.status === status).length;

  const published = count('PUBLISHED');
  const failed = count('FAILED');
  const cancelled = count('CANCELLED');
  const publishing = count('PUBLISHING');
  // PROCESSING = a plataforma aceitou mas ainda não confirmou. Para o post,
  // continua "em publicação": anunciar PUBLISHED antes da confirmação remota
  // é a mentira que este status existe para impedir.
  const processing = count('PROCESSING');
  const skipped = count('SKIPPED');

  let status: string;
  if (publishing + processing > 0) status = 'PUBLISHING';
  else if (published === total) status = 'PUBLISHED';
  else if (cancelled === total) status = 'CANCELLED';
  else if (failed + skipped === total) status = 'FAILED';
  else if (published > 0 && published + failed + cancelled + skipped === total) {
    status = 'PARTIALLY_PUBLISHED';
  } else status = 'SCHEDULED';

  const firstPublishedAt = targets
    .map((target) => target.publishedAt)
    .filter((date): date is Date => date !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  await prisma.post.update({
    where: { id: postId },
    data: {
      status: status as never,
      ...(firstPublishedAt ? { publishedAt: firstPublishedAt } : {}),
    },
  });
}
