import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProcessMediaPayload } from '@app/core';
import type { Job } from 'bullmq';
import type { WorkerContainer } from '../container.js';

const execFileAsync = promisify(execFile);

/**
 * Resolve caminhos de binários do FFmpeg com fallback para WinGet, Chocolatey e diretórios padrão.
 */
function resolveBinaryPath(configured: string, binaryName: 'ffmpeg' | 'ffprobe'): string {
  if (existsSync(configured)) return configured;
  if (existsSync(`${configured}.exe`)) return `${configured}.exe`;

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const winget = path.join(localAppData, 'Microsoft', 'WinGet', 'Links', `${binaryName}.exe`);
    if (existsSync(winget)) return winget;
  }

  const common = [
    `C:\\ffmpeg\\bin\\${binaryName}.exe`,
    `C:\\Program Files\\ffmpeg\\bin\\${binaryName}.exe`,
    `C:\\ProgramData\\chocolatey\\bin\\${binaryName}.exe`,
  ];
  for (const c of common) {
    if (existsSync(c)) return c;
  }

  return process.platform === 'win32' && !configured.endsWith('.exe') ? `${configured}.exe` : configured;
}

/**
 * Processamento de mídia com FFmpeg (SPEC seção 6).
 *
 * Extrai duração, resolução, codec e gera a miniatura. Roda no worker porque
 * é CPU-bound: fazer isso no processo da API estouraria o p95 de 300ms da
 * seção 2 toda vez que alguém subisse um vídeo.
 *
 * Estes metadados não são enfeite — o validador da seção 6.1 usa duração e
 * proporção para bloquear, no agendamento, um vídeo que a plataforma
 * rejeitaria na hora de publicar.
 */

interface FfprobeOutput {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    duration?: string;
    r_frame_rate?: string;
    bit_rate?: string;
  }>;
  format?: { duration?: string; bit_rate?: string; format_name?: string };
}

export async function processMedia(
  container: WorkerContainer,
  job: Job<ProcessMediaPayload>,
): Promise<void> {
  const { mediaAssetId, correlationId } = job.data;
  const log = container.logger.child({ correlationId, mediaAssetId });

  const asset = await container.prisma.mediaAsset.findUnique({
    where: { id: mediaAssetId },
  });

  if (!asset || asset.deletedAt) {
    log.warn('arquivo inexistente ou removido — nada a processar');
    return;
  }

  if (asset.processingStatus === 'READY') {
    log.debug('arquivo já processado — job ignorado');
    return;
  }

  await container.prisma.mediaAsset.update({
    where: { id: mediaAssetId },
    data: { processingStatus: 'PROCESSING', processingError: null },
  });

  // O FFmpeg trabalha em arquivo, não em stream de rede: baixamos para um
  // diretório temporário e limpamos no finally, sempre.
  const workDir = await mkdtemp(path.join(tmpdir(), 'grs-media-'));
  const localPath = path.join(workDir, path.basename(asset.storageKey));

  try {
    const buffer = await container.storage.getObjectBuffer(asset.storageKey);
    await writeFile(localPath, buffer);

    const probe = await ffprobe(container, localPath);
    const metadata = extractMetadata(probe);

    let thumbnailKey: string | null = null;

    if (asset.type === 'VIDEO') {
      thumbnailKey = await generateVideoThumbnail(container, asset, localPath, workDir, log);
    }

    await container.prisma.mediaAsset.update({
      where: { id: mediaAssetId },
      data: {
        processingStatus: 'READY',
        processingError: null,
        width: metadata.width,
        height: metadata.height,
        durationMs: metadata.durationMs,
        frameRate: metadata.frameRate,
        videoCodec: metadata.videoCodec,
        audioCodec: metadata.audioCodec,
        bitrate: metadata.bitrate,
        ...(thumbnailKey ? { thumbnailKey } : {}),
      },
    });

    log.info(
      { largura: metadata.width, altura: metadata.height, duracaoMs: metadata.durationMs },
      'mídia processada',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await container.prisma.mediaAsset.update({
      where: { id: mediaAssetId },
      data: { processingStatus: 'FAILED', processingError: message.slice(0, 2000) },
    });

    log.error({ err: error }, 'falha ao processar a mídia');
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------

async function ffprobe(container: WorkerContainer, filePath: string): Promise<FfprobeOutput> {
  const binary = resolveBinaryPath(container.env.FFPROBE_PATH, 'ffprobe');
  try {
    const { stdout } = await execFileAsync(
      binary,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_streams',
        '-show_format',
        filePath,
      ],
      { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
    );

    return JSON.parse(stdout) as FfprobeOutput;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `FFprobe não encontrado em "${binary}". ` +
          `Instale o FFmpeg ou ajuste FFPROBE_PATH no .env.`,
      );
    }
    throw error;
  }
}

function extractMetadata(probe: FfprobeOutput): {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  frameRate: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrate: number | null;
} {
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');

  const durationSeconds = Number(probe.format?.duration ?? video?.duration ?? 0);
  const bitrate = Number(probe.format?.bit_rate ?? video?.bit_rate ?? 0);

  return {
    width: video?.width ?? null,
    height: video?.height ?? null,
    durationMs: Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.round(durationSeconds * 1000)
      : null,
    frameRate: parseFrameRate(video?.r_frame_rate),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate) : null,
  };
}

/** O ffprobe devolve a taxa como fração ("30000/1001"). */
function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!numerator || !denominator) return null;
  const rate = numerator / denominator;
  return Number.isFinite(rate) ? Math.round(rate * 100) / 100 : null;
}

async function generateVideoThumbnail(
  container: WorkerContainer,
  asset: { id: string; organizationId: string },
  videoPath: string,
  workDir: string,
  log: WorkerContainer['logger'],
): Promise<string | null> {
  const thumbPath = path.join(workDir, 'thumb.jpg');
  const binary = resolveBinaryPath(container.env.FFMPEG_PATH, 'ffmpeg');

  try {
    await execFileAsync(
      binary,
      [
        '-y',
        // 1 segundo evita o quadro preto que muitos vídeos têm no início.
        '-ss',
        '00:00:01',
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-vf',
        'scale=640:-2',
        '-q:v',
        '4',
        thumbPath,
      ],
      { timeout: 120_000 },
    );

    const thumbnail = await readFile(thumbPath);
    const key = `org/${asset.organizationId}/media/${asset.id}/thumb.jpg`;

    await container.storage.putObject(key, thumbnail, 'image/jpeg');
    return key;
  } catch (error) {
    // Miniatura é conveniência: um vídeo sem thumbnail continua publicável.
    // Falhar o processamento inteiro por causa dela seria desproporcional.
    log.warn({ err: error }, 'não foi possível gerar a miniatura do vídeo');
    return null;
  }
}
