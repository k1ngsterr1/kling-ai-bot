-- AlterTable
ALTER TABLE "public"."payments" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "paymentMethod" TEXT NOT NULL DEFAULT 'robokassa',
ADD COLUMN     "subscriptionDuration" INTEGER;

-- AlterTable
ALTER TABLE "public"."users" ADD COLUMN     "lastPaymentDate" TIMESTAMP(3),
ADD COLUMN     "lastPaymentMethod" TEXT,
ADD COLUMN     "subscriptionType" TEXT;
