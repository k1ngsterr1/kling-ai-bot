-- AlterTable
ALTER TABLE "public"."payments" ADD COLUMN     "isRecurring" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "nextBillingDate" TIMESTAMP(3),
ADD COLUMN     "previousInvoiceId" TEXT,
ADD COLUMN     "recurringFrequency" TEXT;
