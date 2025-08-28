import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface RobokassaPaymentRequest {
  userId: number;
  amount: number;
  description: string;
  email?: string;
  currency?: string;
  recurring?: boolean; // Для рекуррентных платежей
  recurringFrequency?: 'monthly' | 'weekly' | 'daily'; // Частота списания
}

export interface RobokassaPaymentUrl {
  paymentUrl: string;
  invoiceId: number;
}

export interface RobokassaCallbackData {
  OutSum: string;
  InvId: string;
  SignatureValue: string;
  Fee?: string; // Комиссия
  EMail?: string; // Email плательщика
  PaymentMethod?: string; // Способ оплаты
  IncSum?: string; // Сумма к получению
  IncCurrLabel?: string; // Валюта к получению
  PreviousInvoiceID?: string; // Для рекуррентных платежей
  Recurring?: string; // Флаг рекуррентного платежа
  [key: string]: string | undefined;
}

export interface RecurringPaymentData {
  previousInvoiceId: string;
  amount: number;
  description: string;
  userId: number;
}

@Injectable()
export class RobokassaService {
  private readonly logger = new Logger(RobokassaService.name);

  // Robokassa credentials from environment
  private readonly merchantLogin: string;
  private readonly password1: string; // Для формирования подписи при инициализации
  private readonly password2: string; // Для получения уведомлений

  // URLs
  private readonly paymentUrl = 'https://auth.robokassa.ru/Merchant/Index.aspx';
  private readonly testMode: boolean;

  constructor(private configService: ConfigService) {
    this.merchantLogin =
      this.configService.get<string>('ROBOKASSA_MERCHANT_LOGIN') ||
      'kling_tgbot';
    this.password1 =
      this.configService.get<string>('ROBOKASSA_PASSWORD1') ||
      'ge2szRg0qJnrl81E0SEe';
    this.password2 =
      this.configService.get<string>('ROBOKASSA_PASSWORD2') ||
      'EJ8rKq4mtHbr65eP4LWV';
    this.testMode = false; // Отключаем тестовый режим для боевых паролей
    // this.configService.get<string>('ROBOKASSA_TEST_MODE') === 'true';

    this.logger.log('🏦 Robokassa service initialized');
    this.logger.log(`Merchant: ${this.merchantLogin}`);
    this.logger.log(`Test mode: ${this.testMode ? 'ON' : 'OFF'}`);
  }

  /**
   * Создает URL для оплаты через Robokassa
   */
  async createPaymentUrl(
    request: RobokassaPaymentRequest,
  ): Promise<RobokassaPaymentUrl> {
    const invoiceId = Date.now(); // Уникальный ID заказа
    const amount = request.amount.toFixed(2);

    this.logger.log(
      `Creating payment URL for user ${request.userId}, amount: ${amount} RUB`,
    );

    // Формируем подпись
    const signature = this.generatePaymentSignature(
      amount,
      invoiceId.toString(),
      request.userId,
      request.recurring,
    );

    // Параметры для URL
    const params = new URLSearchParams({
      MerchantLogin: this.merchantLogin,
      OutSum: amount.toString(),
      InvoiceID: invoiceId.toString(),
      Description: `Покупка ${amount} токенов`,
      SignatureValue: signature, // Используем SignatureValue
      // Временно убираем Shp_userId для отладки ошибки 29
      // Shp_userId: request.userId?.toString() || '',
      Culture: 'ru', // Локализация
    });

    // Убираем пустые параметры
    const filteredParams = new URLSearchParams();
    for (const [key, value] of params.entries()) {
      if (value && value.trim() !== '') {
        filteredParams.append(key, value);
      }
    }

    // Поддержка рекуррентных платежей (временно отключено для отладки)
    // if (request.recurring) {
    //   params.append('Recurring', 'true');
    //
    //   // Устанавливаем частоту списания
    //   if (request.recurringFrequency) {
    //     switch (request.recurringFrequency) {
    //       case 'monthly':
    //         params.append('ExpirationDate', this.getExpirationDate(30)); // 30 дней
    //         break;
    //       case 'weekly':
    //         params.append('ExpirationDate', this.getExpirationDate(7)); // 7 дней
    //         break;
    //       case 'daily':
    //         params.append('ExpirationDate', this.getExpirationDate(1)); // 1 день
    //         break;
    //     }
    //   } else {
    //     // По умолчанию месячная подписка
    //     params.append('ExpirationDate', this.getExpirationDate(30));
    //   }
    // }

    if (this.testMode) {
      filteredParams.append('IsTest', '1');
    }

    const fullPaymentUrl = `${this.paymentUrl}?${filteredParams.toString()}`;

    this.logger.log(`Payment URL created for invoice ${invoiceId}`);
    this.logger.debug(`Payment URL: ${fullPaymentUrl}`);

    return {
      paymentUrl: fullPaymentUrl,
      invoiceId: invoiceId,
    };
  }

  /**
   * Проверяет подпись callback'а от Robokassa
   */
  verifyCallback(data: RobokassaCallbackData): boolean {
    const {
      OutSum,
      InvId,
      SignatureValue,
      Fee,
      EMail,
      PaymentMethod,
      IncSum,
      IncCurrLabel,
      PreviousInvoiceID,
      Recurring,
      ...customParams
    } = data;

    this.logger.log(
      `Verifying callback for invoice ${InvId}, amount: ${OutSum}${PreviousInvoiceID ? ` (recurring from ${PreviousInvoiceID})` : ''}`,
    );

    // Фильтруем только строковые значения для customParams
    const filteredCustomParams: Record<string, string> = {};
    Object.entries(customParams).forEach(([key, value]) => {
      if (typeof value === 'string') {
        filteredCustomParams[key] = value;
      }
    });

    const expectedSignature = this.generateCallbackSignature(
      OutSum,
      InvId,
      filteredCustomParams,
    );
    const receivedSignature = SignatureValue.toLowerCase();
    const expectedSignatureLower = expectedSignature.toLowerCase();

    const isValid = receivedSignature === expectedSignatureLower;

    if (isValid) {
      this.logger.log(`✅ Callback signature verified for invoice ${InvId}`);
    } else {
      this.logger.error(`❌ Invalid callback signature for invoice ${InvId}`);
      this.logger.error(`Expected: ${expectedSignatureLower}`);
      this.logger.error(`Received: ${receivedSignature}`);
    }

    return isValid;
  }

  /**
   * Генерирует подпись для создания платежа
   */
  private generatePaymentSignature(
    amount: string,
    invoiceId: string,
    userId?: number,
    isRecurring?: boolean,
  ): string {
    // Простая формула без дополнительных параметров: MerchantLogin:OutSum:InvoiceID:Password1
    let signatureString = `${this.merchantLogin}:${amount}:${invoiceId}:${this.password1}`;

    // Временно убираем Shp параметры для отладки ошибки 29
    // if (userId) {
    //   signatureString += `:Shp_userId=${userId}`;
    // }

    this.logger.debug(
      `Payment signature string: ${signatureString.replace(this.password1, '***')}`,
    );

    // Используем нативный crypto модуль
    const signature = require('crypto')
      .createHash('md5')
      .update(signatureString)
      .digest('hex')
      .toUpperCase();

    this.logger.debug(`Payment signature: ${signature}`);

    return signature;
  } /**
   * Генерирует подпись для проверки callback'а
   */
  private generateCallbackSignature(
    amount: string,
    invoiceId: string,
    customParams: Record<string, string>,
  ): string {
    // Сортируем дополнительные параметры по алфавиту
    const sortedParams = Object.keys(customParams)
      .filter((key) => key.startsWith('Shp_'))
      .sort()
      .map((key) => `${key}=${customParams[key]}`)
      .join(':');

    // Формат: OutSum:InvoiceID[:дополнительные_параметры]:Password2
    let signatureString = `${amount}:${invoiceId}`;

    if (sortedParams) {
      signatureString += `:${sortedParams}`;
    }

    signatureString += `:${this.password2}`;

    this.logger.debug(
      `Callback signature string: ${signatureString.replace(this.password2, '***')}`,
    );

    const signature = require('crypto')
      .createHash('md5')
      .update(signatureString)
      .digest('hex')
      .toUpperCase();

    this.logger.debug(`Callback signature: ${signature}`);

    return signature;
  }

  /**
   * Извлекает данные пользователя из callback'а
   */
  extractUserDataFromCallback(data: RobokassaCallbackData): { userId: number } {
    const userIdStr = data.Shp_UserId;

    if (!userIdStr) {
      throw new Error('Missing user ID in callback data');
    }

    const userId = parseInt(userIdStr);

    if (isNaN(userId)) {
      throw new Error('Invalid user ID in callback data');
    }

    return { userId };
  }

  /**
   * Форматирует ответ для Robokassa
   */
  formatRobokassaResponse(success: boolean, message?: string): string {
    if (success) {
      return `OK${message ? ': ' + message : ''}`;
    } else {
      return `ERROR: ${message || 'Payment processing failed'}`;
    }
  }

  /**
   * Получает дату истечения для рекуррентного платежа
   */
  private getExpirationDate(days: number): string {
    const expirationDate = new Date();
    expirationDate.setDate(expirationDate.getDate() + days);

    // Формат: YYYY-MM-DDThh:mm:ss
    const year = expirationDate.getFullYear();
    const month = String(expirationDate.getMonth() + 1).padStart(2, '0');
    const day = String(expirationDate.getDate()).padStart(2, '0');
    const hours = String(expirationDate.getHours()).padStart(2, '0');
    const minutes = String(expirationDate.getMinutes()).padStart(2, '0');
    const seconds = String(expirationDate.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
  }

  /**
   * Создает рекуррентный платеж на основе предыдущего
   */
  async createRecurringPayment(
    data: RecurringPaymentData,
  ): Promise<RobokassaPaymentUrl> {
    const invoiceId = Date.now();
    const amount = data.amount.toFixed(2);

    this.logger.log(
      `Creating recurring payment for user ${data.userId}, amount: ${amount} RUB, based on invoice ${data.previousInvoiceId}`,
    );

    // Формируем подпись для рекуррентного платежа
    const signature = this.generateRecurringSignature(
      amount,
      invoiceId.toString(),
      data.previousInvoiceId,
      data.userId,
    );

    // Параметры для рекуррентного платежа
    const params = new URLSearchParams({
      MerchantLogin: this.merchantLogin,
      OutSum: amount,
      InvoiceID: invoiceId.toString(),
      Description: data.description,
      SignatureValue: signature,
      PreviousInvoiceID: data.previousInvoiceId,
      Recurring: 'true',
      Culture: 'ru',
      Encoding: 'utf-8',
    });

    // Добавляем пользовательские данные
    params.append('Shp_UserId', data.userId.toString());

    if (this.testMode) {
      params.append('IsTest', '1');
    }

    const fullPaymentUrl = `${this.paymentUrl}?${params.toString()}`;

    this.logger.log(`Recurring payment URL created for invoice ${invoiceId}`);

    return {
      paymentUrl: fullPaymentUrl,
      invoiceId: invoiceId,
    };
  }

  /**
   * Генерирует подпись для рекуррентного платежа
   */
  private generateRecurringSignature(
    amount: string,
    invoiceId: string,
    previousInvoiceId: string,
    userId?: number,
  ): string {
    // Формат для рекуррентного платежа: MerchantLogin:OutSum:InvoiceID:PreviousInvoiceID:Password1[:Shp_параметры]
    let signatureString = `${this.merchantLogin}:${amount}:${invoiceId}:${previousInvoiceId}:${this.password1}`;

    // Собираем все Shp_ параметры
    const shpParams: string[] = [];

    if (userId) {
      shpParams.push(`Shp_UserId=${userId}`);
    }

    // Добавляем параметры в алфавитном порядке
    if (shpParams.length > 0) {
      shpParams.sort(); // Сортируем по алфавиту
      signatureString += `:${shpParams.join(':')}`;
    }

    this.logger.debug(
      `Recurring signature string: ${signatureString.replace(this.password1, '***')}`,
    );

    const signature = require('crypto')
      .createHash('md5')
      .update(signatureString)
      .digest('hex')
      .toUpperCase();

    this.logger.debug(`Recurring signature: ${signature}`);

    return signature;
  }

  /**
   * Проверяет, является ли платеж рекуррентным
   */
  isRecurringPayment(data: RobokassaCallbackData): boolean {
    return !!(data.PreviousInvoiceID || data.Recurring);
  }

  /**
   * Отменяет рекуррентный платеж
   */
  async cancelRecurringPayment(invoiceId: string): Promise<boolean> {
    this.logger.log(`Cancelling recurring payment for invoice ${invoiceId}`);

    // В реальной реализации здесь должен быть API-вызов к Robokassa для отмены подписки
    // Пока что просто логируем
    this.logger.log(`Recurring payment ${invoiceId} marked for cancellation`);

    return true;
  }
}
