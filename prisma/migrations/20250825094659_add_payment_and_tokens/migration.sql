-- AlterTable
ALTER TABLE "public"."users" ADD COLUMN     "imageTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "imagesGenerated" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "videoTokens" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "public"."images" (
    "id" SERIAL NOT NULL,
    "telegramId" TEXT NOT NULL,
    "imageId" TEXT,
    "prompt" TEXT NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fileUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."payments" (
    "id" SERIAL NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "packageType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "robokassaData" JSONB,
    "videoTokensGranted" INTEGER NOT NULL DEFAULT 0,
    "imageTokensGranted" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_invoiceId_key" ON "public"."payments"("invoiceId");

-- AddForeignKey
ALTER TABLE "public"."payments" ADD CONSTRAINT "payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("telegramId") ON DELETE RESTRICT ON UPDATE CASCADE;
