-- AlterEnum
ALTER TYPE "PostTargetStatus" ADD VALUE 'PROCESSING';

-- AlterTable
ALTER TABLE "post_targets" ADD COLUMN     "processingDeadlineAt" TIMESTAMP(3),
ADD COLUMN     "remoteOperationId" TEXT;
