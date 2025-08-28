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
  recurring?: boolean; // Для рекуррентных платежей
  recurringFrequency?: 'monthly' | 'weekly' | 'daily'; // Частота списания
}

export interface RecurringPaymentRequest {
  userId: number;
  amount: number;
  description: string;
  previousInvoiceId: string;
}

@Controller('payment')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(
    private readonly robokassaService: RobokassaService,
    private readonly prismaService: PrismaService,
    private readonly telegramBotService: TelegramBotService,
  ) {}

  @Post('create-tariff')
  async createTariffPayment(
    @Body()
    request: {
      userId: number;
      tariffType: 'basic' | 'premium' | 'unlimited';
      recurring?: boolean;
    },
  ) {
    try {
      this.logger.log(
        `Creating tariff payment for user ${request.userId}: ${request.tariffType}`,
      );

      // Определяем цену и параметры тарифа
      const tariffConfig = {
        basic: {
          price: 299,
          videoTokens: 10,
          imageTokens: 50,
          description: 'Базовый тариф - 10 видео + 50 изображений',
        },
        premium: {
          price: 599,
          videoTokens: 25,
          imageTokens: 100,
          description: 'Премиум тариф - 25 видео + 100 изображений',
        },
        unlimited: {
          price: 1299,
          videoTokens: 100,
          imageTokens: 500,
          description: 'Безлимитный тариф - 100 видео + 500 изображений',
        },
      };

      const tariff = tariffConfig[request.tariffType];
      if (!tariff) {
        throw new Error(`Unknown tariff type: ${request.tariffType}`);
      }

      // Создаем запрос на оплату
      const paymentRequest = {
        userId: request.userId,
        amount: tariff.price,
        description: tariff.description,
        recurring: request.recurring || false,
        recurringFrequency: request.recurring
          ? ('monthly' as const)
          : undefined,
      };

      const result =
        await this.robokassaService.createPaymentUrl(paymentRequest);

      // Сохраняем информацию о платеже в базу данных
      await this.prismaService.payment.create({
        data: {
          userId: request.userId.toString(),
          amount: tariff.price,
          invoiceId: result.invoiceId.toString(),
          status: 'pending',
          packageType: `tariff_${request.tariffType}`,
          description: tariff.description,
          paymentMethod: 'robokassa',
          subscriptionDuration: 30, // 30 дней для помесячной подписки
          isRecurring: request.recurring || false,
          recurringFrequency: request.recurring ? 'monthly' : null,
          videoTokensGranted: tariff.videoTokens,
          imageTokensGranted: tariff.imageTokens,
        },
      });

      this.logger.log(
        `Payment created for user ${request.userId}, invoice: ${result.invoiceId}`,
      );

      return {
        success: true,
        paymentUrl: result.paymentUrl,
        invoiceId: result.invoiceId,
        amount: tariff.price,
        tariff: {
          type: request.tariffType,
          videoTokens: tariff.videoTokens,
          imageTokens: tariff.imageTokens,
          recurring: request.recurring || false,
        },
      };
    } catch (error) {
      this.logger.error('Error creating tariff payment:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

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
        recurring: request.recurring,
        recurringFrequency: request.recurringFrequency,
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

  // Добавляем GET метод для Robokassa callback (на случай если они используют GET)
  @Get('robokassa-callback')
  async handleRobokassaCallbackGet(@Query() data: any, @Res() res: Response) {
    this.logger.log('Received Robokassa GET callback:', JSON.stringify(data));
    return this.handleRobokassaCallbackLogic(data, res);
  }

  @Post('robokassa-callback')
  async handleRobokassaCallback(@Body() data: any, @Res() res: Response) {
    this.logger.log('Received Robokassa POST callback:', JSON.stringify(data));
    return this.handleRobokassaCallbackLogic(data, res);
  }

  private async handleRobokassaCallbackLogic(data: any, res: Response) {
    try {
      this.logger.log(
        'Processing Robokassa callback:',
        JSON.stringify(data, null, 2),
      );

      // Проверяем подпись
      const isValid = this.robokassaService.verifyCallback(data);
      if (!isValid) {
        this.logger.error('Invalid signature in callback:', data);
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

      this.logger.log(
        `Extracted data: userId=${userId}, amount=${amount}, invoiceId=${invoiceId}`,
      );

      // Проверяем, является ли платеж рекуррентным
      const isRecurring = this.robokassaService.isRecurringPayment(data);

      if (isRecurring) {
        this.logger.log(
          `Processing recurring payment for invoice ${invoiceId}`,
        );
        await this.processRecurringPayment(userId, amount, invoiceId);
      } else {
        this.logger.log(`Processing one-time payment for invoice ${invoiceId}`);
        await this.processSuccessfulPayment(userId, amount, invoiceId);
      }

      // Отправляем подтверждение Robokassa
      this.logger.log(
        `Sending OK response to Robokassa for invoice ${invoiceId}`,
      );
      return res.status(HttpStatus.OK).send(`OK${invoiceId}`); // Robokassa expects "OK" + invoice ID
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

  @Post('callback')
  async handlePaymentCallback(@Body() data: any, @Res() res: Response) {
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

      // Проверяем, является ли платеж рекуррентным
      const isRecurring = this.robokassaService.isRecurringPayment(data);

      if (isRecurring) {
        this.logger.log(
          `Processing recurring payment for invoice ${invoiceId}`,
        );
        await this.processRecurringPayment(userId, amount, invoiceId);
      } else {
        this.logger.log(`Processing one-time payment for invoice ${invoiceId}`);
        await this.processSuccessfulPayment(userId, amount, invoiceId);
      }

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
            <a href="https://t.me/Kling_tgbot" class="button">Вернуться в бот</a>
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
      const subscriptionDuration = payment.subscriptionDuration || 0;

      // Убеждаемся, что пользователь существует в базе данных
      await this.ensureUserExists(userId);

      // Определяем дату истечения подписки
      const now = new Date();
      const expiresAt =
        subscriptionDuration > 0
          ? new Date(now.getTime() + subscriptionDuration * 24 * 60 * 60 * 1000)
          : null;

      // Для Robokassa платежей (помесячные) - обновляем подписку
      if (payment.paymentMethod === 'robokassa') {
        await this.prismaService.user.update({
          where: { telegramId: userId.toString() },
          data: {
            videoTokens: { increment: videoTokens },
            imageTokens: { increment: imageTokens },
            isSubscribed: true,
            subscriptionExpiry: expiresAt,
            subscriptionType: payment.isRecurring
              ? 'robokassa_monthly_recurring'
              : 'robokassa_monthly_onetime',
            lastPaymentMethod: 'robokassa',
            lastPaymentDate: now,
          },
        });
      } else {
        // Для других способов оплаты - просто добавляем токены
        await this.updateUserBalance(userId, videoTokens, imageTokens);
      }

      // Обновляем статус и дату истечения платежа
      await this.prismaService.payment.update({
        where: { invoiceId: invoiceId.toString() },
        data: {
          status: 'completed',
          completedAt: now,
          expiresAt: expiresAt,
        },
      });

      // Отправляем уведомление пользователю в Telegram
      await this.notifyUserAboutPayment(
        userId,
        amount,
        videoTokens,
        imageTokens,
        payment.paymentMethod,
        expiresAt,
      );
    } catch (error) {
      this.logger.error('Error processing successful payment:', error);
      throw error;
    }
  }

  private async ensureUserExists(userId: number): Promise<void> {
    try {
      const existingUser = await this.prismaService.user.findUnique({
        where: { telegramId: userId.toString() },
      });

      if (!existingUser) {
        this.logger.log(`Creating user record for userId: ${userId}`);

        // Create a basic user record
        await this.prismaService.user.create({
          data: {
            telegramId: userId.toString(),
            username: null,
            firstName: null,
            lastName: null,
            languageCode: null,
            isBot: false,
            isPremium: false,
            userType: 'NEW_ID',
            videoTokens: 0,
            imageTokens: 0,
            lastActiveAt: new Date(),
          },
        });

        this.logger.log(`Created user record for userId: ${userId}`);
      }
    } catch (error) {
      this.logger.error(
        `Error ensuring user exists for userId ${userId}:`,
        error,
      );
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
    paymentMethod?: string,
    expiresAt?: Date | null,
  ) {
    try {
      let message = `
🎉 Платеж успешно обработан!

💰 Сумма: ${amount} ₽
🎬 Видео токенов: +${videoTokens}
🖼 Токенов изображений: +${imageTokens}`;

      if (paymentMethod === 'robokassa' && expiresAt) {
        const expiryDate = expiresAt.toLocaleDateString('ru-RU');
        message += `

📅 Подписка активна до: ${expiryDate}
🔄 Автоматическое продление: ${paymentMethod === 'robokassa' ? 'Да' : 'Нет'}`;
      } else {
        message += `

💫 Токены добавлены на ваш баланс навсегда!`;
      }

      message += `

Теперь вы можете создавать контент!`;

      await this.telegramBotService.sendMessage(userId, message);
    } catch (error) {
      this.logger.error('Error notifying user about payment:', error);
      // Не выбрасываем ошибку, так как платеж уже обработан
    }
  }

  @Post('create-recurring')
  async createRecurringPayment(@Body() request: RecurringPaymentRequest) {
    try {
      this.logger.log(
        `Creating recurring payment for user ${request.userId}: ${request.amount} RUB`,
      );

      // Создаем рекуррентный платеж
      const paymentData = await this.robokassaService.createRecurringPayment({
        userId: request.userId,
        amount: request.amount,
        description: request.description,
        previousInvoiceId: request.previousInvoiceId,
      });

      // Сохраняем информацию о рекуррентном платеже в базе данных
      await this.prismaService.payment.create({
        data: {
          invoiceId: paymentData.invoiceId.toString(),
          userId: request.userId.toString(),
          amount: request.amount,
          packageType: 'premium_subscription',
          description: request.description,
          status: 'pending',
        },
      });

      return {
        success: true,
        paymentUrl: paymentData.paymentUrl,
        invoiceId: paymentData.invoiceId,
      };
    } catch (error) {
      this.logger.error('Error creating recurring payment:', error);
      return {
        success: false,
        error: 'Failed to create recurring payment',
      };
    }
  }

  @Post('cancel-recurring')
  async cancelRecurringPayment(
    @Body() body: { invoiceId: string; userId: number },
  ) {
    try {
      this.logger.log(
        `Cancelling recurring payment for invoice ${body.invoiceId}, user ${body.userId}`,
      );

      // Отменяем подписку в Robokassa
      const cancelled = await this.robokassaService.cancelRecurringPayment(
        body.invoiceId,
      );

      if (cancelled) {
        // Обновляем статус в базе данных
        await this.prismaService.payment.updateMany({
          where: {
            invoiceId: body.invoiceId,
            userId: body.userId.toString(),
          },
          data: {
            status: 'cancelled',
          },
        });

        // Уведомляем пользователя
        await this.telegramBotService.sendMessage(
          body.userId,
          `🔕 Подписка отменена\n\nВаша подписка была успешно отменена. Спасибо за использование нашего сервиса!`,
        );

        return {
          success: true,
          message: 'Recurring payment cancelled successfully',
        };
      } else {
        return {
          success: false,
          error: 'Failed to cancel recurring payment',
        };
      }
    } catch (error) {
      this.logger.error('Error cancelling recurring payment:', error);
      return {
        success: false,
        error: 'Internal server error',
      };
    }
  }

  private async processRecurringPayment(
    userId: number,
    amount: number,
    invoiceId: number,
  ) {
    try {
      this.logger.log(
        `Processing recurring payment for user ${userId}: ${amount} RUB`,
      );

      // Для рекуррентных платежей обычно выдается фиксированное количество токенов
      const videoTokens = 50; // Примерные токены для подписки
      const imageTokens = 100;

      // Обновляем токены пользователя в базе данных
      await this.prismaService.user.upsert({
        where: { telegramId: userId.toString() },
        update: {
          videoTokens: { increment: videoTokens },
          imageTokens: { increment: imageTokens },
          updatedAt: new Date(),
        },
        create: {
          telegramId: userId.toString(),
          videoTokens: videoTokens,
          imageTokens: imageTokens,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      // Обновляем статус платежа
      await this.updatePaymentStatus(invoiceId, 'completed');

      // Уведомляем пользователя
      await this.notifyUserAboutRecurringPayment(
        userId,
        amount,
        videoTokens,
        imageTokens,
      );

      this.logger.log(
        `Recurring payment processed successfully for user ${userId}`,
      );
    } catch (error) {
      this.logger.error('Error processing recurring payment:', error);
      await this.updatePaymentStatus(invoiceId, 'failed');
      throw error;
    }
  }

  private async notifyUserAboutRecurringPayment(
    userId: number,
    amount: number,
    videoTokens: number,
    imageTokens: number,
  ) {
    try {
      const message = `
🔄 Автоплатеж по подписке выполнен!

💰 Сумма: ${amount} ₽
🎬 Видео токенов: +${videoTokens}
🖼 Токенов изображений: +${imageTokens}

Ваша подписка продлена! Токены зачислены на баланс.

Отменить подписку можно в любой момент в настройках.
      `;

      await this.telegramBotService.sendMessage(userId, message);
    } catch (error) {
      this.logger.error('Error notifying user about recurring payment:', error);
    }
  }
}
