import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto-js';

export interface RobokassaPaymentRequest {
  userId: number;
  amount: number;
  description: string;
  email?: string;
  currency?: string;
}

export interface RobokassaPaymentUrl {
  paymentUrl: string;
  invoiceId: number;
}

export interface RobokassaCallbackData {
  OutSum: string;
  InvId: string;
  SignatureValue: string;
  [key: string]: string;
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
    this.testMode =
      this.configService.get<string>('ROBOKASSA_TEST_MODE') === 'true';

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
    );

    // Параметры для URL
    const params = new URLSearchParams({
      MerchantLogin: this.merchantLogin,
      OutSum: amount,
      InvoiceID: invoiceId.toString(),
      Description: request.description,
      SignatureValue: signature,
      Culture: 'ru',
      Encoding: 'utf-8',
    });

    // Добавляем дополнительные параметры если есть
    if (request.email) {
      params.append('Email', request.email);
    }

    if (request.currency && request.currency !== 'RUB') {
      params.append('OutSumCurrency', request.currency);
    }

    // Добавляем пользовательские данные
    params.append('Shp_UserId', request.userId.toString());

    if (this.testMode) {
      params.append('IsTest', '1');
    }

    const fullPaymentUrl = `${this.paymentUrl}?${params.toString()}`;

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
    const { OutSum, InvId, SignatureValue, ...customParams } = data;

    this.logger.log(
      `Verifying callback for invoice ${InvId}, amount: ${OutSum}`,
    );

    const expectedSignature = this.generateCallbackSignature(
      OutSum,
      InvId,
      customParams,
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
  ): string {
    // Формат: MerchantLogin:OutSum:InvoiceID:Password1[:Shp_параметры в алфавитном порядке]
    let signatureString = `${this.merchantLogin}:${amount}:${invoiceId}:${this.password1}`;

    // Добавляем Shp_ параметры в алфавитном порядке
    if (userId) {
      signatureString += `:Shp_UserId=${userId}`;
    }

    this.logger.debug(
      `Payment signature string: ${signatureString.replace(this.password1, '***')}`,
    );

    const signature = crypto.MD5(signatureString).toString().toUpperCase();

    this.logger.debug(`Payment signature: ${signature}`);

    return signature;
  }

  /**
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

    const signature = crypto.MD5(signatureString).toString().toUpperCase();

    this.logger.debug(`Callback signature: ${signature}`);

    return signature;
  }

  /**
   * Извлекает данные пользователя из callback'а
   */
  extractUserDataFromCallback(data: RobokassaCallbackData): { userId: number } {
    const userId = parseInt(data.Shp_UserId);

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
}
