-- DropIndex
DROP INDEX "analytics_snapshots_socialAccountId_postTargetId_capturedFo_key";

-- AlterTable
ALTER TABLE "analytics_snapshots" ADD COLUMN     "scopeKey" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "analytics_snapshots_socialAccountId_scopeKey_capturedFor_key" ON "analytics_snapshots"("socialAccountId", "scopeKey", "capturedFor");
