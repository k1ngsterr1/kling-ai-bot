import {
  Controller,
  Post,
  Body,
  Logger,
  Get,
  Query,
  Res,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { RobokassaService } from './robokassa.service';
import type { RobokassaCallbackData } from './robokassa.service';
import { PrismaService } from './prisma.service';
import { TelegramBotService } from './telegram-bot.service';

export interface PaymentRequest {
  userId: number;
  amount: number;
  packageType: 'video_tokens' | 'image_tokens' | 'premium_subscription';
  description: string;
  email?: string;
}

@Controller('payment')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(
    private readonly robokassaService: RobokassaService,
    private readonly prismaService: PrismaService,
    private readonly telegramBotService: TelegramBotService,
  ) {}

  @Post('create')
  async createPayment(@Body() request: PaymentRequest) {
    try {
      this.logger.log(
        `Creating payment for user ${request.userId}: ${request.amount} RUB`,
      );

      // Создаем URL для оплаты
      const paymentData = await this.robokassaService.createPaymentUrl({
        userId: request.userId,
        amount: request.amount,
        description: request.description,
        email: request.email,
      });

      // Сохраняем информацию о платеже в базе данных
      await this.savePaymentInfo(request, paymentData.invoiceId);

      return {
        success: true,
        paymentUrl: paymentData.paymentUrl,
        invoiceId: paymentData.invoiceId,
      };
    } catch (error) {
      this.logger.error('Error creating payment:', error);
      return {
        success: false,
        error: 'Failed to create payment',
      };
    }
  }

  @Post('callback')
  async handleCallback(
    @Body() data: RobokassaCallbackData,
    @Res() res: Response,
  ) {
    try {
      this.logger.log(`Received payment callback for invoice ${data.InvId}`);
      this.logger.debug('Callback data:', JSON.stringify(data, null, 2));

      // Проверяем подпись
      const isValid = this.robokassaService.verifyCallback(data);

      if (!isValid) {
        this.logger.error('Invalid callback signature');
        return res
          .status(HttpStatus.BAD_REQUEST)
          .send(
            this.robokassaService.formatRobokassaResponse(
              false,
              'Invalid signature',
            ),
          );
      }

      // Извлекаем данные пользователя
      const { userId } =
        this.robokassaService.extractUserDataFromCallback(data);
      const amount = parseFloat(data.OutSum);
      const invoiceId = parseInt(data.InvId);

      // Обрабатываем платеж
      await this.processSuccessfulPayment(userId, amount, invoiceId);

      // Отправляем подтверждение Robokassa
      return res
        .status(HttpStatus.OK)
        .send(
          this.robokassaService.formatRobokassaResponse(
            true,
            'Payment processed',
          ),
        );
    } catch (error) {
      this.logger.error('Error processing payment callback:', error);
      return res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .send(
          this.robokassaService.formatRobokassaResponse(
            false,
            'Internal server error',
          ),
        );
    }
  }

  @Get('success')
  async handleSuccessRedirect(@Query() query: any, @Res() res: Response) {
    try {
      this.logger.log('User redirected to success page');

      // Здесь можно показать страницу успешной оплаты
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Оплата прошла успешно</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                .success { color: green; font-size: 24px; margin-bottom: 20px; }
                .message { font-size: 16px; margin-bottom: 30px; }
                .button { 
                    background: #0088cc; 
                    color: white; 
                    padding: 10px 20px; 
                    text-decoration: none; 
                    border-radius: 5px; 
                }
            </style>
        </head>
        <body>
            <div class="success">✅ Оплата прошла успешно!</div>
            <div class="message">Ваш баланс пополнен. Возвращайтесь в Telegram бот для использования токенов.</div>
            <a href="https://t.me/your_bot_username" class="button">Вернуться в бот</a>
        </body>
        </html>
      `;

      return res.status(HttpStatus.OK).send(html);
    } catch (error) {
      this.logger.error('Error handling success redirect:', error);
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Error');
    }
  }

  @Get('fail')
  async handleFailRedirect(@Query() query: any, @Res() res: Response) {
    try {
      this.logger.log('User redirected to fail page');

      const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Ошибка оплаты</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                .error { color: red; font-size: 24px; margin-bottom: 20px; }
                .message { font-size: 16px; margin-bottom: 30px; }
                .button { 
                    background: #0088cc; 
                    color: white; 
                    padding: 10px 20px; 
                    text-decoration: none; 
                    border-radius: 5px; 
                }
            </style>
        </head>
        <body>
            <div class="error">❌ Ошибка оплаты</div>
            <div class="message">Платеж не был завершен. Пожалуйста, попробуйте еще раз.</div>
            <a href="https://t.me/your_bot_username" class="button">Вернуться в бот</a>
        </body>
        </html>
      `;

      return res.status(HttpStatus.OK).send(html);
    } catch (error) {
      this.logger.error('Error handling fail redirect:', error);
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).send('Error');
    }
  }

  private async savePaymentInfo(request: PaymentRequest, invoiceId: number) {
    try {
      // Здесь можно сохранить дополнительную информацию о платеже в базе данных
      this.logger.log(
        `Payment info already saved for invoice ${invoiceId} in handleBuyPackage`,
      );
    } catch (error) {
      this.logger.error('Error saving payment info:', error);
      throw error;
    }
  }

  private async processSuccessfulPayment(
    userId: number,
    amount: number,
    invoiceId: number,
  ) {
    try {
      this.logger.log(
        `Processing successful payment: user ${userId}, amount ${amount}, invoice ${invoiceId}`,
      );

      // Получаем информацию о платеже из базы данных
      const payment = await this.prismaService.payment.findUnique({
        where: { invoiceId: invoiceId.toString() },
      });

      if (!payment) {
        throw new Error(`Payment with invoice ${invoiceId} not found`);
      }

      const videoTokens = payment.videoTokensGranted;
      const imageTokens = payment.imageTokensGranted;

      // Обновляем баланс пользователя
      await this.updateUserBalance(userId, videoTokens, imageTokens);

      // Обновляем статус платежа в БД
      await this.updatePaymentStatus(invoiceId, 'completed');

      // Отправляем уведомление пользователю в Telegram
      await this.notifyUserAboutPayment(
        userId,
        amount,
        videoTokens,
        imageTokens,
      );
    } catch (error) {
      this.logger.error('Error processing successful payment:', error);
      throw error;
    }
  }

  private calculateTokens(amount: number): {
    videoTokens: number;
    imageTokens: number;
  } {
    // Примерная логика расчета токенов
    // Адаптируйте под ваши тарифы
    if (amount >= 1000) {
      // Premium package
      return { videoTokens: 50, imageTokens: 100 };
    } else if (amount >= 500) {
      // Standard package
      return { videoTokens: 20, imageTokens: 50 };
    } else if (amount >= 100) {
      // Basic package
      return { videoTokens: 5, imageTokens: 15 };
    } else {
      // Минимальный пакет
      return { videoTokens: 1, imageTokens: 3 };
    }
  }

  private async updateUserBalance(
    userId: number,
    videoTokens: number,
    imageTokens: number,
  ) {
    try {
      // Обновляем баланс пользователя в базе данных
      this.logger.log(
        `Updating balance for user ${userId}: +${videoTokens} video tokens, +${imageTokens} image tokens`,
      );

      await this.prismaService.user.update({
        where: { telegramId: userId.toString() },
        data: {
          videoTokens: {
            increment: videoTokens,
          },
          imageTokens: {
            increment: imageTokens,
          },
        },
      });
    } catch (error) {
      this.logger.error('Error updating user balance:', error);
      throw error;
    }
  }

  private async updatePaymentStatus(invoiceId: number, status: string) {
    try {
      this.logger.log(
        `Updating payment status for invoice ${invoiceId}: ${status}`,
      );

      await this.prismaService.payment.update({
        where: { invoiceId: invoiceId.toString() },
        data: {
          status: status,
          completedAt: new Date(),
        },
      });
    } catch (error) {
      this.logger.error('Error updating payment status:', error);
      throw error;
    }
  }

  private async notifyUserAboutPayment(
    userId: number,
    amount: number,
    videoTokens: number,
    imageTokens: number,
  ) {
    try {
      const message = `
🎉 Платеж успешно обработан!

💰 Сумма: ${amount} ₽
🎬 Видео токенов: +${videoTokens}
🖼 Токенов изображений: +${imageTokens}

Токены зачислены на ваш баланс. Теперь вы можете создавать контент!
      `;

      await this.telegramBotService.sendMessage(userId, message);
    } catch (error) {
      this.logger.error('Error notifying user about payment:', error);
      // Не выбрасываем ошибку, так как платеж уже обработан
    }
  }
}
