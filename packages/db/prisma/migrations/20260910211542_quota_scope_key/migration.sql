-- DropIndex
DROP INDEX "platform_quota_usage_platform_socialAccountId_windowDate_key";

-- AlterTable
ALTER TABLE "platform_quota_usage" ADD COLUMN     "scopeKey" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "platform_quota_usage_platform_scopeKey_windowDate_key" ON "platform_quota_usage"("platform", "scopeKey", "windowDate");
