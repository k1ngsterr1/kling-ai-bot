import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import TelegramBot = require('node-telegram-bot-api');
import {
  KlingAiService,
  KlingVideoRequest,
  KlingImageRequest,
} from './kling-ai.service';
import { PrismaService } from './prisma.service';
import { RobokassaService } from './robokassa.service';

@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: TelegramBot;
  private userStates: Map<number, { state: string; data?: any }> = new Map();
  private readonly adminIds: number[] = [205204465, 839885529]; // Admin IDs
  private readonly channelId = '@vse_ai'; // Channel for subscription check

  // User groups for broadcasts
  private userGroups: Map<number, 'never_paid' | 'high_intent' | 'new_id'> =
    new Map();

  // User tokens with expiration
  private userTokens: Map<
    number,
    {
      videoTokens: number;
      imageTokens: number;
      expiresAt: Date;
      fromBroadcast?: boolean;
    }
  > = new Map();

  // Pending tokens waiting for subscription
  private pendingTokens: Map<
    number,
    {
      videoTokens: number;
      imageTokens: number;
      broadcastMessageId?: number;
    }
  > = new Map();

  private broadcastStates: Map<
    number,
    {
      type?: string;
      content?: string;
      videoTokens?: number;
      imageTokens?: number;
      targetGroup?: string;
      requiresSubscription?: boolean;
    }
  > = new Map();

  constructor(
    private configService: ConfigService,
    private klingAiService: KlingAiService,
    private prisma: PrismaService,
    private robokassaService: RobokassaService,
  ) {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not defined');
    }

    this.bot = new TelegramBot(token, { polling: true });
    this.setupBot();

    // Start periodic cleanup of expired tokens (every hour)
    setInterval(
      () => {
        this.cleanupExpiredTokens();
      },
      60 * 60 * 1000,
    );
  }

  private setupBot() {
    this.logger.log('Telegram bot is starting...');

    // Handle /start command
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id;

      if (userId && msg.from) {
        // Register or update user in database
        await this.registerUser(msg.from);
      }

      this.sendWelcomeMessage(chatId);
    });

    // Handle main menu
    this.bot.onText(/\/main/, (msg) => {
      const chatId = msg.chat.id;
      this.sendMainMenu(chatId);
    });

    // Handle video command
    this.bot.onText(/\/video/, (msg) => {
      const chatId = msg.chat.id;
      this.handleVideoCommand(chatId);
    });

    // Handle image command
    this.bot.onText(/\/img/, (msg) => {
      const chatId = msg.chat.id;
      this.handleImageCommand(chatId);
    });

    // Handle balance command
    this.bot.onText(/\/balance/, (msg) => {
      const chatId = msg.chat.id;
      this.handleBalanceCommand(chatId);
    });

    // Handle help command
    this.bot.onText(/\/help/, (msg) => {
      const chatId = msg.chat.id;
      this.handleHelpCommand(chatId);
    });

    // Admin only command for broadcasts
    this.bot.onText(/\/broadcast/, (msg) => {
      const chatId = msg.chat.id;
      this.handleBroadcastCommand(chatId, msg.from?.id);
    });

    // Admin only command for managing Kling AI tokens
    this.bot.onText(/\/admin/, (msg) => {
      const chatId = msg.chat.id;
      this.handleAdminCommand(chatId, msg.from?.id);
    });

    // Handle callback queries from inline keyboards
    this.bot.on('callback_query', (callbackQuery) => {
      this.handleCallbackQuery(callbackQuery);
    });

    // Handle any message (including successful_payment)
    this.bot.on('message', async (msg) => {
      // Handle native Telegram successful payments
      try {
        if ((msg as any).successful_payment) {
          await this.handleSuccessfulPayment(msg);
          return;
        }
      } catch (err) {
        this.logger.error('Error handling successful payment:', err);
      }

      if (!msg.text?.startsWith('/')) {
        // Handle non-command messages
        this.handleTextMessage(msg);
      }
    });

    // Answer pre-checkout queries from Telegram (required for payments)
    this.bot.on('pre_checkout_query', async (preCheckoutQuery) => {
      try {
        this.logger.log(`[STARS PAYMENT] Pre-checkout query received:`);
        this.logger.log(`[STARS PAYMENT] Query ID: ${preCheckoutQuery.id}`);
        this.logger.log(
          `[STARS PAYMENT] From user: ${preCheckoutQuery.from.id} (${preCheckoutQuery.from.first_name})`,
        );
        this.logger.log(
          `[STARS PAYMENT] Currency: ${preCheckoutQuery.currency}`,
        );
        this.logger.log(
          `[STARS PAYMENT] Total amount: ${preCheckoutQuery.total_amount}`,
        );
        this.logger.log(
          `[STARS PAYMENT] Invoice payload: ${preCheckoutQuery.invoice_payload}`,
        );
        this.logger.log(
          `[STARS PAYMENT] Full query data: ${JSON.stringify(preCheckoutQuery, null, 2)}`,
        );

        await this.bot.answerPreCheckoutQuery(preCheckoutQuery.id, true);

        this.logger.log(
          `[STARS PAYMENT] ✅ Pre-checkout query answered successfully`,
        );
      } catch (err) {
        this.logger.error(
          `[STARS PAYMENT] ❌ Error answering pre_checkout_query:`,
          err,
        );
      }
    });

    // Handle photo messages
    this.bot.on('photo', (msg) => {
      this.handlePhotoMessage(msg);
    });

    // Handle document messages
    this.bot.on('document', (msg) => {
      this.handleDocumentMessage(msg);
    });

    this.bot.on('polling_error', (error) => {
      this.logger.error('Telegram bot polling error:', error);
    });
  }

  private sendWelcomeMessage(chatId: number) {
    const welcomeText = `
🏠 Главное меню

👇 Выберите действие:

📱 Видео - генерация и обработка видео
🖼 Изображения - создание и редактирование фото
💳 Баланс - управление счетом и подпиской
❓ Помощь - инструкции и поддержка
    `;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '📱 Видео', callback_data: 'video' },
          { text: '🖼 Изображение', callback_data: 'image' },
        ],
        [
          { text: '💳 Баланс', callback_data: 'balance' },
          { text: '❓ Помощь', callback_data: 'help' },
        ],
      ],
    };

    this.bot.sendMessage(chatId, welcomeText, { reply_markup: keyboard });
  }

  private sendMainMenu(chatId: number) {
    this.sendWelcomeMessage(chatId);
  }

  private handleVideoCommand(chatId: number) {
    // Set user state for video generation
    this.userStates.set(chatId, { state: 'waiting_video_prompt' });

    const videoText = `
🎬 [Видео] /video

🌟 Вы используете Kling 2.1 
📝 Опишите видео максимально подробно + можно добавить до 2 фото:

✨ Примеры удачных промптов:
• «Робот-шеф готовит пиццу на Марсе, 8К детализация»
• «Золотой дракон над средневековым замком» + фото Эйфелевой башни

🖼️ Как использовать изображения:
1. Для Standard/PRO: фото задают стиль и атмосферу
2. Для MASTER: 
   - Фото 1 = главный объект/персонаж 
   - Фото 2 = фон/локация

⚠️ Важно: 
- Длина промпта: до 300 символов
- Изображения: JPG/PNG (до 15MB)
- Баланс будет списан после выбора параметров

👇 Отправьте описание ниже:
    `;

    const keyboard = {
      inline_keyboard: [[{ text: '🔙 Назад', callback_data: 'main' }]],
    };

    this.bot.sendMessage(chatId, videoText, { reply_markup: keyboard });
  }

  private handleImageCommand(chatId: number) {
    // Set user state for image generation
    this.userStates.set(chatId, { state: 'waiting_image_prompt' });

    const imageText = `
🖼️ [Изображение] /img

🌟 Вы используете Kling 2.1 
📝 Опишите изображение максимально подробно:

✨ Примеры удачных промптов:
• «Футуристический город на закате, неоновые огни, киберпанк стиль, 8К»
• «Портрет эльфийской принцессы с золотыми волосами в волшебном лесу»
• «Космический корабль приближается к неизвестной планете, звёзды»

⚠️ Важно: 
- Длина промпта: до 300 символов
- Разрешение: высокое качество
- Баланс будет списан после выбора параметров

👇 Отправьте описание ниже:
    `;

    const keyboard = {
      inline_keyboard: [[{ text: '🏠 Главное меню', callback_data: 'main' }]],
    };

    this.bot.sendMessage(chatId, imageText, { reply_markup: keyboard });
  }

  private async handleBalanceCommand(chatId: number) {
    try {
      // Убеждаемся, что пользователь существует в базе данных
      await this.ensureUserExists(chatId);

      // Получаем данные пользователя из базы данных
      const user = await this.prisma.user.findFirst({
        where: { telegramId: chatId.toString() },
      });

      const videoTokens = user?.videoTokens || 0;
      const imageTokens = user?.imageTokens || 0;
      const isSubscribed = user?.isSubscribed || false;
      const subscriptionExpiry = user?.subscriptionExpiry;

      let subscriptionStatus = '⚠️ Подписка не активна';
      if (
        isSubscribed &&
        subscriptionExpiry &&
        subscriptionExpiry > new Date()
      ) {
        const expiryDate = subscriptionExpiry.toLocaleDateString('ru-RU');
        subscriptionStatus = `✅ Подписка активна до ${expiryDate}`;
      }

      const balanceText = `
💎 ВАШ ТЕКУЩИЙ БАЛАНС

🎬 Видео-токены: ${videoTokens}
📸 Токены изображений: ${imageTokens}

${subscriptionStatus}

🔥 ВЫГОДНЫЕ ПОДПИСКИ (ежемесячное автопополнение)

[🔹 СТАРТ] 25 видео + 100 изо · 1200 ₽/мес
▸ Базовый пакет · идеален для тестирования
▸ Автопродление · отмена в любой момент

[🔹 ПРОДВИНУТЫЙ] 50 видео + 100 изо · 2230 ₽/мес
▸ ~~2400₽~~ · экономия 170₽ (7%)
▸ Самый популярный вариант

[🔹 ПРОФИ] 100 видео + 200 изо · 4320 ₽/мес
▸ ~~4800₽~~ · экономия 480₽ (10%)
▸ Приоритетная очередь

[💎 ДОПОЛНИТЕЛЬНЫЕ ПАКЕТЫ] 
Покупай генерации, без подписок и ограничений.
      `;

      const keyboard = {
        inline_keyboard: [
          [{ text: '🔹 СТАРТ (1200₽)', callback_data: 'buy_package_1200' }],
          [
            {
              text: '🔹 ПРОДВИНУТЫЙ (2230₽)',
              callback_data: 'buy_package_2230',
            },
          ],
          [
            {
              text: '🔹 ПРОФИ (4320₽)',
              callback_data: 'buy_package_4320',
            },
          ],
          [
            {
              text: '💎 ДОПОЛНИТЕЛЬНЫЕ ПАКЕТЫ',
              callback_data: 'additional_packages',
            },
          ],

          [{ text: '🔙 Назад', callback_data: 'main' }],
        ],
      };

      await this.bot.sendMessage(chatId, balanceText, {
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error('Error in handleBalanceCommand:', error);
      await this.bot.sendMessage(
        chatId,
        'Произошла ошибка при получении баланса. Попробуйте позже.',
      );
    }
  }

  private handleHelpCommand(chatId: number) {
    const helpText = `
❓ Помощь - инструкции и поддержка

Доступные команды:
/start - Запуск бота
/main - Главное меню
/video - Работа с видео
/img - Работа с изображениями
/balance - Проверка баланса
/help - Помощь

📋 Документы:
    `;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: '🔒 Политика конфиденциальности',
            url: 'https://teletype.in/@help_24/privacy_kling',
          },
        ],
        [
          {
            text: '📜 Пользовательское соглашение',
            url: 'https://teletype.in/@help_24/agree_kling',
          },
        ],
        [
          {
            text: '💎 Оферта',
            url: 'https://teletype.in/@help_24/oferta_kling',
          },
        ],
        [
          {
            text: '📖 Подробные условия',
            url: 'https://teletype.in/@help_24/podrobno_kling',
          },
        ],
        [{ text: '🏠 Главное меню', callback_data: 'main' }],
      ],
    };

    this.bot.sendMessage(chatId, helpText, { reply_markup: keyboard });
  }

  private handleCallbackQuery(callbackQuery: TelegramBot.CallbackQuery) {
    const chatId = callbackQuery.message?.chat.id;
    const data = callbackQuery.data;

    if (!chatId) return;

    // Answer the callback query to remove loading state
    this.bot.answerCallbackQuery(callbackQuery.id);

    // Handle prefixed callback_data first (dynamic actions)
    if (data && data.startsWith('buy_stars_')) {
      const parts = data.split('_');
      const packageName = parts.slice(2, -1).join(' '); // Extract package name
      const price = parseInt(parts[parts.length - 1]); // Extract price
      this.handleBuyPackage(chatId, price, packageName);
      return;
    }

    if (data && data.startsWith('buy_card_')) {
      const parts = data.split('_');
      const packageName = parts.slice(2, -1).join(' '); // Extract package name
      const price = parseInt(parts[parts.length - 1]); // Extract price
      this.handleBuyPackage(chatId, price, packageName);
      return;
    }

    if (data && data.startsWith('pay_stars:')) {
      const parts = data.split(':');
      const invoiceId = parts[1];
      const amount = parseInt(parts[2]);
      const packageName = parts[3];
      this.handlePayStars(chatId, invoiceId, amount, packageName);
      return;
    }

    if (data && data.startsWith('pay_with_stars:')) {
      const invoiceId = data.split(':')[1];
      this.handlePayWithStars(chatId, invoiceId);
      return;
    }

    if (data && data.startsWith('admin_confirm_stars:')) {
      const invoiceId = data.split(':')[1];
      this.handleAdminConfirmStars(chatId, invoiceId);
      return;
    }

    if (data && data.startsWith('admin_cancel_stars:')) {
      const invoiceId = data.split(':')[1];
      this.handleAdminCancelStars(chatId, invoiceId);
      return;
    }

    switch (data) {
      case 'main':
        this.userStates.delete(chatId); // Clear user state
        this.sendMainMenu(chatId);
        break;
      case 'video':
        this.handleVideoCommand(chatId);
        break;
      case 'image':
        this.handleImageCommand(chatId);
        break;
      case 'balance':
        this.handleBalanceCommand(chatId);
        break;
      case 'help':
        this.handleHelpCommand(chatId);
        break;
      case 'video_settings':
        this.handleVideoSettings(chatId);
        break;
      case 'clear_images':
        this.clearImages(chatId);
        break;
      case 'quality_standard':
        this.handleQualitySelection(chatId, 'standard');
        break;
      case 'quality_pro':
        this.handleQualitySelection(chatId, 'pro');
        break;
      case 'quality_master':
        this.handleQualitySelection(chatId, 'master');
        break;
      case 'duration_5':
        this.handleDurationChoice(chatId, 5);
        break;
      case 'duration_10':
        this.handleDurationChoice(chatId, 10);
        break;
      case 'change_duration':
        this.handleDurationSelection(chatId);
        break;
      case 'aspect_1_1':
        this.handleAspectRatioChoice(chatId, '1:1');
        break;
      case 'aspect_9_16':
        this.handleAspectRatioChoice(chatId, '9:16');
        break;
      case 'aspect_16_9':
        this.handleAspectRatioChoice(chatId, '16:9');
        break;
      case 'change_aspect_ratio':
        this.handleAspectRatioSelection(chatId);
        break;
      case 'confirm_generation':
        this.handleGenerationConfirmation(chatId);
        break;
      case 'confirm_image_generation':
        this.handleImageGenerationConfirmation(chatId);
        break;
      case 'subscription_start':
        this.handleSubscriptionPlan(chatId, 'start');
        break;
      case 'subscription_advanced':
        this.handleSubscriptionPlan(chatId, 'advanced');
        break;
      case 'subscription_pro':
        this.handleSubscriptionPlan(chatId, 'pro');
        break;
      case 'additional_packages':
        this.handleAdditionalPackages(chatId);
        break;
      case 'cancel_subscription':
        this.handleCancelSubscription(chatId);
        break;
      case 'buy_50_video':
        this.handlePackagePurchase(chatId, '50 video', 2240, 'видео');
        break;
      case 'buy_100_video':
        this.handlePackagePurchase(chatId, '100 video', 4256, 'видео');
        break;
      case 'buy_250_video':
        this.handlePackagePurchase(chatId, '250 video', 9968, 'видео');
        break;
      case 'buy_100_img':
        this.handlePackagePurchase(chatId, '100 img', 449, 'изображений');
        break;
      case 'buy_200_img':
        this.handlePackagePurchase(chatId, '200 img', 790, 'изображений');
        break;
      case 'buy_500_img':
        this.handlePackagePurchase(chatId, '500 img', 1900, 'изображений');
        break;
      case 'broadcast_start':
        this.handleBroadcastStart(chatId, callbackQuery.from?.id);
        break;
      case 'broadcast_never_paid':
        this.handleBroadcastGroup(chatId, 'never_paid', callbackQuery.from?.id);
        break;
      case 'broadcast_high_intent':
        this.handleBroadcastGroup(
          chatId,
          'high_intent',
          callbackQuery.from?.id,
        );
        break;
      case 'broadcast_new_id':
        this.handleBroadcastGroup(chatId, 'new_id', callbackQuery.from?.id);
        break;
      case 'broadcast_select_never_paid':
        this.handleGroupSelection(chatId, 'never_paid', callbackQuery.from?.id);
        break;
      case 'broadcast_select_high_intent':
        this.handleGroupSelection(
          chatId,
          'high_intent',
          callbackQuery.from?.id,
        );
        break;
      case 'broadcast_select_new_id':
        this.handleGroupSelection(chatId, 'new_id', callbackQuery.from?.id);
        break;
      case 'broadcast_require_sub':
        this.handleSubscriptionRequirement(
          chatId,
          true,
          callbackQuery.from?.id,
        );
        break;
      case 'broadcast_no_sub':
        this.handleSubscriptionRequirement(
          chatId,
          false,
          callbackQuery.from?.id,
        );
        break;
      case 'broadcast_confirm':
        this.handleBroadcastConfirm(chatId, callbackQuery.from?.id);
        break;
      case 'broadcast_cancel':
        this.handleBroadcastCancel(chatId, callbackQuery.from?.id);
        break;
      case 'back_to_broadcast':
        this.handleBroadcastCommand(chatId, callbackQuery.from?.id);
        break;
      case 'check_subscription':
        this.handleCheckSubscription(chatId, callbackQuery.from?.id);
        break;
      case 'subscribe_channel':
        this.handleSubscribeChannel(chatId);
        break;
      case 'admin_tokens':
        this.handleAdminTokens(chatId, callbackQuery.from?.id);
        break;
      case 'admin_view_tokens':
        this.handleViewUserTokens(chatId, callbackQuery.from?.id);
        break;
      case 'admin_add_tokens':
        this.handleAddTokensMenu(chatId, callbackQuery.from?.id);
        break;
      case 'admin_remove_tokens':
        this.handleRemoveTokensMenu(chatId, callbackQuery.from?.id);
        break;
      case 'admin_clear_expired':
        this.handleClearExpiredTokens(chatId, callbackQuery.from?.id);
        break;
      case 'admin_back':
        this.handleAdminCommand(
          chatId,
          callbackQuery.from?.id,
          callbackQuery.message?.message_id,
        );
        break;
      case 'admin_api_keys':
        this.handleAdminApiKeys(
          chatId,
          callbackQuery.from?.id,
          callbackQuery.message?.message_id,
        );
        break;
      case 'admin_change_access_key':
        this.handleChangeAccessKey(
          chatId,
          callbackQuery.from?.id,
          callbackQuery.message?.message_id,
        );
        break;
      case 'admin_change_secret_key':
        this.handleChangeSecretKey(
          chatId,
          callbackQuery.from?.id,
          callbackQuery.message?.message_id,
        );
        break;
      case 'admin_view_current_keys':
        this.handleViewCurrentKeys(
          chatId,
          callbackQuery.from?.id,
          callbackQuery.message?.message_id,
        );
        break;
      case 'image_ratio_1:1':
        this.handleImageAspectRatioChoice(chatId, '1:1');
        break;
      case 'image_ratio_9:16':
        this.handleImageAspectRatioChoice(chatId, '9:16');
        break;
      case 'image_ratio_16:9':
        this.handleImageAspectRatioChoice(chatId, '16:9');
        break;
      case 'buy_package_1200':
        this.handleBuyPackage(chatId, 1200, 'Пакет СТАРТ');
        break;
      case 'buy_package_2230':
        this.handleBuyPackage(chatId, 2230, 'Пакет ПРОДВИНУТЫЙ');
        break;
      case 'buy_package_4320':
        this.handleBuyPackage(chatId, 4320, 'Пакет ПРОФИ');
        break;
      default:
        this.bot.sendMessage(chatId, 'Неизвестная команда');
    }
  }

  // Handle Telegram Stars payment button
  private async handlePayStars(
    chatId: number,
    invoiceId: string,
    amount: number,
    packageName: string,
  ) {
    this.logger.log(
      `[STARS PAYMENT] Starting payment process for chat ${chatId}, invoice ${invoiceId}, amount ${amount} stars, package "${packageName}"`,
    );

    try {
      const payment = await this.prisma.payment.findFirst({
        where: { invoiceId: invoiceId.toString() },
      });

      if (!payment) {
        this.logger.warn(
          `[STARS PAYMENT] Payment not found for invoice ${invoiceId}`,
        );
        await this.bot.sendMessage(
          chatId,
          '❌ Платёж не найден. Попробуйте еще раз.',
        );
        return;
      }

      this.logger.log(
        `[STARS PAYMENT] Payment found: ${JSON.stringify({
          id: payment.id,
          userId: payment.userId,
          amount: payment.amount,
          description: payment.description,
          status: payment.status,
        })}`,
      );

      // Send Telegram Stars invoice using direct HTTP request
      // because node-telegram-bot-api might not fully support XTR currency
      const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
      const url = `https://api.telegram.org/bot${token}/sendInvoice`;

      const invoiceData = {
        chat_id: chatId,
        title: packageName,
        description: payment.description || `Пакет ${packageName}`,
        payload: `pkg_${invoiceId}`,
        provider_token: '', // empty for Telegram Stars
        start_parameter: `start_${invoiceId}`,
        currency: 'XTR', // Telegram Stars currency
        prices: [
          {
            label: packageName,
            amount: amount, // amount in stars
          },
        ],
      };

      this.logger.log(
        `[STARS PAYMENT] Sending invoice request to Telegram API:`,
      );
      this.logger.log(
        `[STARS PAYMENT] URL: ${url.replace(token || '', 'HIDDEN_TOKEN')}`,
      );
      this.logger.log(
        `[STARS PAYMENT] Invoice data: ${JSON.stringify(invoiceData, null, 2)}`,
      );

      const axios = require('axios');
      const response = await axios.post(url, invoiceData);

      this.logger.log(
        `[STARS PAYMENT] Telegram API response status: ${response.status}`,
      );
      this.logger.log(
        `[STARS PAYMENT] Telegram API response data: ${JSON.stringify(response.data, null, 2)}`,
      );

      if (response.data.ok) {
        this.logger.log(
          `[STARS PAYMENT] ✅ SUCCESS: Telegram Stars invoice sent successfully for ${amount} stars to chat ${chatId}`,
        );
      } else {
        this.logger.error(
          `[STARS PAYMENT] ❌ FAILED: Telegram API returned error: ${JSON.stringify(response.data)}`,
        );
        throw new Error(`Telegram API error: ${JSON.stringify(response.data)}`);
      }
    } catch (error) {
      this.logger.error('Error sending Telegram Stars invoice:', error);
      await this.bot.sendMessage(
        chatId,
        '❌ Не удалось создать инвойс для оплаты звёздами. Попробуйте позже.',
      );
    }
  }

  // Обработчик запроса оплаты звездами (пользователь нажал 'TG STARS')
  private async handlePayWithStars(chatId: number, invoiceId: string) {
    try {
      const payment = await this.prisma.payment.findFirst({
        where: { invoiceId: invoiceId.toString() },
      });

      if (!payment) {
        await this.bot.sendMessage(
          chatId,
          '❌ Платёж не найден. Попробуйте еще раз или напишите в поддержку.',
        );
        return;
      }

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'requested_stars' },
      });

      const adminMessage = `🟡 Запрос на оплату звездами\nПользователь: ${chatId}\nПлатёж ID: ${invoiceId}\nСумма: ${payment.amount} ₽\nОписание: ${payment.description || '—'}\n\nПодтвердите оплату вручную и обновите статус платежа.`;

      for (const adminId of this.adminIds) {
        try {
          await this.bot.sendMessage(adminId, adminMessage, {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `✅ Подтвердить ${invoiceId}`,
                    callback_data: `admin_confirm_stars:${invoiceId}`,
                  },
                  {
                    text: `❌ Отменить ${invoiceId}`,
                    callback_data: `admin_cancel_stars:${invoiceId}`,
                  },
                ],
              ],
            },
          });
        } catch (err) {
          this.logger.warn(`Could not notify admin ${adminId}:`, err);
        }
      }

      await this.bot.sendMessage(
        chatId,
        '✅ Запрос на оплату звездами отправлен администраторам. После подтверждения вы получите токены. Ожидайте уведомления.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'main' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error('Error handling pay_with_stars:', error);
      await this.bot.sendMessage(
        chatId,
        '❌ Не удалось обработать запрос на оплату звездами. Попробуйте позже.',
      );
    }
  }

  // Admin confirms the stars payment: mark as completed and grant tokens
  private async handleAdminConfirmStars(
    adminChatId: number,
    invoiceId: string,
  ) {
    try {
      const payment = await this.prisma.payment.findFirst({
        where: { invoiceId: invoiceId.toString() },
      });

      if (!payment) {
        await this.bot.sendMessage(adminChatId, 'Платёж не найден.');
        return;
      }

      if (payment.status === 'completed') {
        await this.bot.sendMessage(adminChatId, 'Платёж уже подтверждён.');
        return;
      }

      // Update payment status
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'completed' },
      });

      // Grant tokens to user
      const userIdNum = Number(payment.userId);
      if (!isNaN(userIdNum)) {
        // Use existing token add method if available, else update map
        const packageDetails = {
          videoTokens: payment.videoTokensGranted || 0,
          imageTokens: payment.imageTokensGranted || 0,
        };

        await this.addTokensToUser(
          userIdNum,
          packageDetails.videoTokens,
          packageDetails.imageTokens,
        );

        await this.bot.sendMessage(
          userIdNum,
          `✅ Оплата подтверждена администрацией. На ваш баланс зачислены токены: 🎬 ${packageDetails.videoTokens} / 🖼️ ${packageDetails.imageTokens}`,
        );
      }

      await this.bot.sendMessage(
        adminChatId,
        `✅ Платёж ${invoiceId} подтверждён и токены зачислены.`,
      );
    } catch (error) {
      this.logger.error('Error confirming stars payment:', error);
      await this.bot.sendMessage(
        adminChatId,
        'Ошибка при подтверждении платежа.',
      );
    }
  }

  // Admin cancels the stars payment
  private async handleAdminCancelStars(adminChatId: number, invoiceId: string) {
    try {
      const payment = await this.prisma.payment.findFirst({
        where: { invoiceId: invoiceId.toString() },
      });

      if (!payment) {
        await this.bot.sendMessage(adminChatId, 'Платёж не найден.');
        return;
      }

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'cancelled' },
      });

      const userIdNum = Number(payment.userId);
      if (!isNaN(userIdNum)) {
        await this.bot.sendMessage(
          userIdNum,
          `❌ Платёж ${invoiceId} отменён администрацией. Токены не были зачислены.`,
        );
      }

      await this.bot.sendMessage(
        adminChatId,
        `❌ Платёж ${invoiceId} отменён.`,
      );
    } catch (error) {
      this.logger.error('Error cancelling stars payment:', error);
      await this.bot.sendMessage(adminChatId, 'Ошибка при отмене платежа.');
    }
  }

  private handleVideoSettings(chatId: number) {
    const userState = this.userStates.get(chatId);

    if (!userState?.data?.prompt) {
      this.bot.sendMessage(
        chatId,
        'Ошибка: промпт не найден. Начните заново с /video',
      );
      return;
    }

    const { prompt, images = [] } = userState.data;

    const settingsText = `
🎚️ Выберите качество видео:

⚡ STANDARD
└ Скорость: Быстрая (2-4 мин)
└ Детализация: Базовая
└ Стоимость: 1 токен за 5s

🎓 PRO 
└ Скорость: Средняя (4-8 мин)
└ Детализация: Высокая
└ Стоимость: 2 токена за 5s 

💎 MASTER 
└ Скорость: Приоритетная (1-3 мин)
└ Детализация: Кинематографичная 4k HDR
└ Стоимость: 4 токена за 5s
    `;

    const keyboard = {
      inline_keyboard: [
        [{ text: '⚡ Standard', callback_data: 'quality_standard' }],
        [{ text: '🎓 Pro', callback_data: 'quality_pro' }],
        [{ text: '💎 Master', callback_data: 'quality_master' }],
        [
          { text: '[help]', callback_data: 'help' },
          { text: '[Назад]', callback_data: 'video' },
        ],
      ],
    };

    this.bot.sendMessage(chatId, settingsText, { reply_markup: keyboard });
  }

  private clearImages(chatId: number) {
    const userState = this.userStates.get(chatId);

    if (userState?.data) {
      this.userStates.set(chatId, {
        ...userState,
        data: { ...userState.data, images: [] },
      });

      this.bot.sendMessage(
        chatId,
        '🗑️ Изображения очищены. Можете добавить новые или перейти к настройкам генерации.',
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '⚙️ Настройки генерации',
                  callback_data: 'video_settings',
                },
              ],
              [{ text: '🔙 Назад к видео', callback_data: 'video' }],
            ],
          },
        },
      );
    }
  }

  private handleQualitySelection(chatId: number, quality: string) {
    const userState = this.userStates.get(chatId);

    if (!userState?.data?.prompt) {
      this.bot.sendMessage(
        chatId,
        'Ошибка: данные не найдены. Начните заново с /video',
      );
      return;
    }

    // Save the selected quality
    this.userStates.set(chatId, {
      ...userState,
      data: { ...userState.data, quality },
    });

    // Show duration selection
    this.handleDurationSelection(chatId);
  }

  private handleDurationSelection(chatId: number) {
    const durationText = `
⏱️ Выберите длительность видео:

▫️ 5 СЕКУНД: 4 токена
   └ Идеально для TikTok/Reels/Shorts

▫️ 10 СЕКУНД: 8 токенов
   └ Полноценная сцена с развитием

👇 Выберите вариант:
    `;

    const keyboard = {
      inline_keyboard: [
        [{ text: '[5 секунд]', callback_data: 'duration_5' }],
        [{ text: '[10 секунд]', callback_data: 'duration_10' }],
        [{ text: '[Назад]', callback_data: 'video_settings' }],
      ],
    };

    this.bot.sendMessage(chatId, durationText, { reply_markup: keyboard });
  }

  private handleDurationChoice(chatId: number, duration: number) {
    const userState = this.userStates.get(chatId);

    if (!userState?.data) {
      this.bot.sendMessage(
        chatId,
        'Ошибка: данные не найдены. Начните заново с /video',
      );
      return;
    }

    // Save the selected duration
    this.userStates.set(chatId, {
      ...userState,
      data: { ...userState.data, duration },
    });

    // Show aspect ratio selection
    this.handleAspectRatioSelection(chatId);
  }

  private handleAspectRatioSelection(chatId: number) {
    const aspectRatioText = `
📐 Выберите формат видео:

▫️ [1:1] Квадрат  
   ─ Идеален для постов Instagram, Facebook

▫️ [9:16] Вертикальный  
   ─ Для TikTok, Reels, Stories

▫️ [16:9] Широкоэкранный  
   ─ Для YouTube, компьютеров, телевизоров
    `;

    const keyboard = {
      inline_keyboard: [
        [{ text: '[1:1 📱]', callback_data: 'aspect_1_1' }],
        [{ text: '[9:16 �]', callback_data: 'aspect_9_16' }],
        [{ text: '[16:9 📺]', callback_data: 'aspect_16_9' }],
        [{ text: '[Назад]', callback_data: 'change_duration' }],
      ],
    };

    this.bot.sendMessage(chatId, aspectRatioText, { reply_markup: keyboard });
  }

  private handleAspectRatioChoice(chatId: number, aspectRatio: string) {
    const userState = this.userStates.get(chatId);

    if (!userState?.data) {
      this.bot.sendMessage(
        chatId,
        'Ошибка: данные не найдены. Начните заново с /video',
      );
      return;
    }

    const { prompt, images = [], quality, duration } = userState.data;

    // Save the selected aspect ratio
    this.userStates.set(chatId, {
      ...userState,
      data: { ...userState.data, aspectRatio },
    });

    const qualityNames = {
      standard: '⚡ STANDARD',
      pro: '🎓 PRO',
      master: '💎 MASTER',
    };

    const aspectRatioNames = {
      '1:1': '[1:1] Квадрат',
      '9:16': '[9:16] Вертикальный',
      '16:9': '[16:9] Широкоэкранный',
    };

    const totalCost = duration === 5 ? 4 : 8;

    const confirmationText = `
3.4 Пользователь выбрал формат видео
✅ Ваш заказ:
Модель: V2.1 ${qualityNames[quality]}
Длительность: ${duration}s
Промпт: "${prompt}"
Стоимость: ${totalCost} токенов
Текущий баланс: 100 токенов

    `;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: '⚡ Начать генерацию',
            callback_data: 'confirm_generation',
          },
        ],
        [{ text: '[Назад]', callback_data: 'change_aspect_ratio' }],
      ],
    };

    this.bot.sendMessage(chatId, confirmationText, { reply_markup: keyboard });
  }

  private handleImageAspectRatioChoice(chatId: number, aspectRatio: string) {
    const userState = this.userStates.get(chatId);

    if (!userState?.data?.prompt) {
      this.bot.sendMessage(
        chatId,
        'Ошибка: промпт не найден. Начните заново с /img',
      );
      return;
    }

    const { prompt } = userState.data;

    // Save the selected aspect ratio
    this.userStates.set(chatId, {
      ...userState,
      data: { ...userState.data, aspectRatio },
    });

    const aspectRatioNames = {
      '1:1': '⬜ 1:1 (квадрат)',
      '9:16': '📱 9:16 (вертикальное)',
      '16:9': '🖥️ 16:9 (горизонтальное)',
    };

    const confirmationText = `
✅ Ваш заказ на изображение:
Промпт: "${prompt}"
Формат: ${aspectRatioNames[aspectRatio]}
Стоимость: 1 токен
Текущий баланс: 100 токенов
    `;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: '⚡ Начать генерацию',
            callback_data: 'confirm_image_generation',
          },
        ],
        [{ text: '🔙 Назад к изображениям', callback_data: 'image' }],
      ],
    };

    this.bot.sendMessage(chatId, confirmationText, { reply_markup: keyboard });
  }

  private async handleImageGenerationConfirmation(chatId: number) {
    const userState = this.userStates.get(chatId);

    if (!userState?.data?.prompt || !userState?.data?.aspectRatio) {
      this.bot.sendMessage(
        chatId,
        'Ошибка: данные не найдены. Начните заново с /img',
      );
      return;
    }

    const { prompt, aspectRatio } = userState.data;

    this.logger.log(
      `Generating image with prompt: "${prompt}" and aspectRatio: ${aspectRatio}`,
    );

    try {
      // Create Kling AI request for image
      const klingRequest: KlingImageRequest = {
        prompt,
        aspectRatio: aspectRatio as '1:1' | '9:16' | '16:9',
      };

      // Start generation with Kling AI
      const generationResult =
        await this.klingAiService.generateImage(klingRequest);

      if (generationResult.status === 'pending') {
        // Send initial progress message
        const initialText = `
⏳ Генерация изображения началась!
Примерное время: 1-2 мин
ID: ${generationResult.id}

🔔 Результат придет автоматически
⚠️ При ошибках уведомим в течение 10-20 секунд
        `;

        const keyboard = {
          inline_keyboard: [
            [{ text: '🏠 Главное меню', callback_data: 'main' }],
          ],
        };

        const progressMessage = await this.bot.sendMessage(
          chatId,
          initialText,
          {
            reply_markup: keyboard,
          },
        );

        // Start polling for completion without status check (wait fixed time)
        this.pollImageGenerationWithoutStatus(
          chatId,
          generationResult.id,
          progressMessage.message_id,
        );
      } else {
        this.bot.sendMessage(
          chatId,
          '❌ Ошибка при запуске генерации. Попробуйте еще раз.',
        );
      }

      // Clear user state
      this.userStates.delete(chatId);
    } catch (error) {
      this.logger.error('Error generating image:', error);

      // Check if error is related to API keys
      if (error.message?.includes('API keys not configured')) {
        this.bot.sendMessage(
          chatId,
          '❌ API ключи Kling AI не настроены!\n\nОбратитесь к администратору для настройки ключей через /admin',
        );
      } else {
        this.bot.sendMessage(
          chatId,
          '❌ Произошла ошибка при генерации изображения. Попробуйте позже.',
        );
      }
    }
  }

  private async handleGenerationConfirmation(chatId: number) {
    const userState = this.userStates.get(chatId);

    if (!userState?.data) {
      this.bot.sendMessage(
        chatId,
        'Ошибка: данные не найдены. Начните заново с /video',
      );
      return;
    }

    const {
      prompt,
      images = [],
      quality,
      duration,
      aspectRatio,
    } = userState.data;

    try {
      // Create Kling AI request
      const klingRequest: KlingVideoRequest = {
        prompt,
        quality: quality as 'standard' | 'pro' | 'master',
        duration: duration as 5 | 10,
        aspectRatio: aspectRatio as '1:1' | '9:16' | '16:9',
        images: images.map((img) => img.file_id),
      };

      // Start generation with Kling AI
      const generationResult =
        await this.klingAiService.generateVideo(klingRequest);

      const totalCost = duration === 5 ? 4 : 8;
      const estimatedMinutes = Math.ceil(
        (generationResult.estimatedTime || 180) / 60,
      );

      const generationText = `
3.5 Пользователь Нажал кнопку [⚡ Начать генерацию]
⏳ Генерация начата!
ID: #${generationResult.id}
Примерное время: ${estimatedMinutes}-${estimatedMinutes + 2} мин
Текущий статус: [██████▒▒▒▒▒▒▒▒▒ 20%]

🔔 Результат придет автоматически
⚠️ При ошибках уведомим в течение 10-20 секунд
      `;

      const keyboard = {
        inline_keyboard: [[{ text: '🏠 Главное меню', callback_data: 'main' }]],
      };

      const progressMessage = await this.bot.sendMessage(
        chatId,
        generationText,
        {
          reply_markup: keyboard,
        },
      );

      // Clear user state as generation is started
      this.userStates.delete(chatId);

      // Start polling for video status
      this.pollVideoStatus(
        chatId,
        generationResult.id,
        totalCost,
        progressMessage.message_id,
      );
    } catch (error) {
      this.logger.error('Error starting video generation:', error);

      // Check if error is related to API keys
      if (error.message?.includes('API keys not configured')) {
        this.bot.sendMessage(
          chatId,
          '❌ API ключи Kling AI не настроены!\n\nОбратитесь к администратору для настройки ключей через /admin',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🏠 Главное меню', callback_data: 'main' }],
              ],
            },
          },
        );
      } else {
        this.bot.sendMessage(
          chatId,
          '❌ Ошибка при запуске генерации. Попробуйте еще раз.',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Попробовать снова', callback_data: 'video' }],
                [{ text: '🏠 Главное меню', callback_data: 'main' }],
              ],
            },
          },
        );
      }
    }
  }

  private async pollVideoStatus(
    chatId: number,
    videoId: string,
    cost: number,
    progressMessageId: number,
  ) {
    const maxAttempts = 30; // Poll for up to 15 minutes (30 * 30 seconds)
    let attempts = 0;

    const poll = async () => {
      attempts++;

      try {
        const status = await this.klingAiService.getVideoStatus(videoId);

        // Calculate progress based on attempts and status
        const progress = this.calculateProgress(
          attempts,
          maxAttempts,
          status.status,
        );
        const progressBar = this.createProgressBar(progress);

        // Update progress message
        const estimatedMinutes = Math.ceil(180 / 60); // 3 minutes default
        const updatedText = `
3.5 Пользователь Нажал кнопку [⚡ Начать генерацию]
⏳ Генерация начата!
ID: #${videoId}
Примерное время: ${estimatedMinutes}-${estimatedMinutes + 2} мин
Текущий статус: ${progressBar} ${progress}%]

🔔 Мы пришлем результат сразу как он будет готов
        `;

        const keyboard = {
          inline_keyboard: [
            [{ text: '🏠 Главное меню', callback_data: 'main' }],
          ],
        };

        // Update the progress message
        try {
          await this.bot.editMessageText(updatedText, {
            chat_id: chatId,
            message_id: progressMessageId,
            reply_markup: keyboard,
          });
        } catch (editError) {
          this.logger.warn('Could not update progress message:', editError);
        }

        if (status.status === 'completed' && status.videoUrl) {
          // Video is ready - send video with caption and buttons
          try {
            // Send as video only
            await this.bot.sendVideo(chatId, status.videoUrl, {
              caption: `🎉 Ваше видео готово!

Видео #${videoId} | Стоимость: ${cost} токенов

📺 Спасибо за использование нашего сервиса!`,
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🎬 Создать еще видео', callback_data: 'video' }],
                  [{ text: '🏠 Главное меню', callback_data: 'main' }],
                ],
              },
            });
          } catch (videoError) {
            this.logger.warn('Could not send video directly:', videoError);
            // Fallback - send text message with download link if video sending fails
            await this.bot.sendMessage(
              chatId,
              `
🎉 Ваше видео готово!

ID: #${videoId}
💰 Списано: ${cost} токенов
📱 Скачать: ${status.videoUrl}

Спасибо за использование нашего сервиса!
            `,
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '🎬 Создать еще видео', callback_data: 'video' }],
                    [{ text: '🏠 Главное меню', callback_data: 'main' }],
                  ],
                },
              },
            );
          }

          return;
        } else if (status.status === 'failed') {
          // Generation failed - НЕМЕДЛЕННО уведомляем пользователя!
          let failureReason = 'Неизвестная причина';

          if (status.errorMessage) {
            if (status.errorMessage.includes('risk control system')) {
              failureReason =
                'Блокировка системой контроля (неподходящий контент)';
            } else if (status.errorMessage.includes('time out')) {
              failureReason = 'Превышено время ожидания';
            } else {
              failureReason = status.errorMessage;
            }
          }

          // Сразу отправляем уведомление об ошибке
          await this.bot.sendMessage(
            chatId,
            `❌ Генерация видео не удалась

ID: #${videoId}
Причина: ${failureReason}

💡 Советы:
• Используйте более нейтральные описания
• Избегайте упоминаний людей, брендов, насилия
• Попробуйте изменить формулировку

💰 Токены возвращены на ваш баланс.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔄 Попробовать снова', callback_data: 'video' }],
                  [{ text: '🏠 Главное меню', callback_data: 'main' }],
                ],
              },
            },
          );
          return;
        } else if (attempts >= maxAttempts) {
          // Timeout
          await this.bot.sendMessage(
            chatId,
            `
⏰ Превышено время ожидания

ID: #${videoId}
Генерация может все еще продолжаться.
Проверьте результат позже или обратитесь в поддержку.
          `,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🏠 Главное меню', callback_data: 'main' }],
                ],
              },
            },
          );
          return;
        }

        // Continue polling - быстрее проверяем для ранних ошибок
        const checkInterval = attempts <= 3 ? 10000 : 30000; // Первые 3 раза каждые 10 сек
        setTimeout(poll, checkInterval);
      } catch (error) {
        this.logger.error(`Error polling video status for ${videoId}:`, error);

        if (attempts < maxAttempts) {
          const checkInterval = attempts <= 3 ? 10000 : 30000; // Быстро проверяем на ошибки
          setTimeout(poll, checkInterval);
        } else {
          await this.bot.sendMessage(
            chatId,
            `
❌ Ошибка проверки статуса видео

ID: #${videoId}
Обратитесь в поддержку для получения результата.
          `,
          );
        }
      }
    };

    // Start polling after initial delay - быстрее начинаем
    setTimeout(poll, 10000);
  }

  private async pollImageGeneration(
    chatId: number,
    imageId: string,
    progressMessageId: number,
  ) {
    const maxAttempts = 20; // Poll for up to 10 minutes (20 * 30 seconds)
    let attempts = 0;

    const poll = async () => {
      attempts++;

      try {
        const status = await this.klingAiService.getImageStatus(imageId);

        // Calculate progress based on attempts and status
        const progress = this.calculateProgress(
          attempts,
          maxAttempts,
          status.status,
        );
        const progressBar = this.createProgressBar(progress);

        // Update progress message
        const estimatedMinutes = Math.ceil(120 / 60); // 2 minutes default for images
        const updatedText = `
⏳ Генерация изображения началась!
Примерное время: ${estimatedMinutes}-${estimatedMinutes + 1} мин
Текущий статус: ${progressBar} ${progress}%]

🔔 Мы пришлем результат сразу как он будет готов
        `;

        const keyboard = {
          inline_keyboard: [
            [{ text: '🏠 Главное меню', callback_data: 'main' }],
          ],
        };

        // Update the progress message
        try {
          await this.bot.editMessageText(updatedText, {
            chat_id: chatId,
            message_id: progressMessageId,
            reply_markup: keyboard,
          });
        } catch (editError) {
          this.logger.warn('Could not update progress message:', editError);
        }

        if (status.status === 'completed' && status.imageUrl) {
          // Image is ready - send image with caption and buttons
          try {
            await this.bot.sendPhoto(chatId, status.imageUrl, {
              caption: `🎉 Ваше изображение готово!

⚠️ ВНИМАНИЕ: Это тестовое изображение, так как API генерации недоступен.
💰 Списано: 1 токен

Спасибо за использование нашего сервиса!`,
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🖼 Создать еще изображение',
                      callback_data: 'image',
                    },
                  ],
                  [{ text: '🏠 Главное меню', callback_data: 'main' }],
                ],
              },
            });
          } catch (imageError) {
            this.logger.warn('Could not send image directly:', imageError);
            // Fallback - send text message with download link if image sending fails
            await this.bot.sendMessage(
              chatId,
              `🎉 Ваше изображение готово!

⚠️ ВНИМАНИЕ: Это тестовое изображение, так как API генерации недоступен.
💰 Списано: 1 токен
📱 Скачать: ${status.imageUrl}

Спасибо за использование нашего сервиса!`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '🖼 Создать еще изображение',
                        callback_data: 'image',
                      },
                    ],
                    [{ text: '🏠 Главное меню', callback_data: 'main' }],
                  ],
                },
              },
            );
          }
          return;
        } else if (status.status === 'failed') {
          // Generation failed - НЕМЕДЛЕННО уведомляем пользователя!
          let failureReason = 'Неизвестная причина';

          if (status.errorMessage) {
            if (status.errorMessage.includes('risk control system')) {
              failureReason =
                'Блокировка системой контроля (неподходящий контент)';
            } else if (status.errorMessage.includes('time out')) {
              failureReason = 'Превышено время ожидания';
            } else {
              failureReason = status.errorMessage;
            }
          }

          // Сразу отправляем уведомление об ошибке
          await this.bot.sendMessage(
            chatId,
            `❌ Генерация изображения не удалась

Причина: ${failureReason}

💡 Советы:
• Используйте более нейтральные описания
• Избегайте упоминаний людей, брендов, насилия
• Попробуйте изменить формулировку

💰 Токен возвращен на ваш баланс.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔄 Попробовать снова', callback_data: 'image' }],
                  [{ text: '🏠 Главное меню', callback_data: 'main' }],
                ],
              },
            },
          );
          return;
        } else if (attempts >= maxAttempts) {
          // Timeout
          await this.bot.sendMessage(
            chatId,
            `⏰ Превышено время ожидания

Генерация может все еще продолжаться.
Проверьте результат позже или обратитесь в поддержку.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🏠 Главное меню', callback_data: 'main' }],
                ],
              },
            },
          );
          return;
        }

        // Continue polling - быстрее проверяем для ранних ошибок
        const checkInterval = attempts <= 3 ? 10000 : 30000; // Первые 3 раза каждые 10 сек
        setTimeout(poll, checkInterval);
      } catch (error) {
        this.logger.error(`Error polling image status for ${imageId}:`, error);

        if (attempts < maxAttempts) {
          const checkInterval = attempts <= 3 ? 10000 : 30000; // Быстро проверяем на ошибки
          setTimeout(poll, checkInterval);
        } else {
          await this.bot.sendMessage(
            chatId,
            `❌ Ошибка проверки статуса изображения

Обратитесь в поддержку для получения результата.`,
          );
        }
      }
    };

    // Start polling after initial delay - быстрее начинаем
    setTimeout(poll, 10000);
  }

  private async pollImageGenerationWithoutStatus(
    chatId: number,
    imageId: string,
    progressMessageId: number,
  ) {
    const maxAttempts = 10; // Wait up to 5 minutes (10 * 30 seconds)
    let attempts = 0;

    const poll = async () => {
      attempts++;

      try {
        // Calculate progress based on attempts
        const progress = Math.min(
          95,
          Math.floor((attempts / maxAttempts) * 100),
        );
        const progressBar = this.createProgressBar(progress);

        // Update progress message
        const updatedText = `
⏳ Генерация изображения...
Примерное время: 1-2 мин
Текущий статус: ${progressBar} ${progress}%]

🔔 Мы пришлем результат сразу как он будет готов
        `;

        const keyboard = {
          inline_keyboard: [
            [{ text: '🏠 Главное меню', callback_data: 'main' }],
          ],
        };

        // Update the progress message
        try {
          await this.bot.editMessageText(updatedText, {
            chat_id: chatId,
            message_id: progressMessageId,
            reply_markup: keyboard,
          });
        } catch (editError) {
          this.logger.warn('Could not update progress message:', editError);
        }

        if (attempts >= maxAttempts) {
          // Try to get actual result from Kling AI
          try {
            this.logger.log(
              `Attempting to get final result for image ${imageId}`,
            );

            // Try to get the result without status check
            const result = await this.klingAiService.getImageResult(imageId);

            if (result && result.imageUrl) {
              // Image is ready - send actual result
              try {
                await this.bot.sendPhoto(chatId, result.imageUrl, {
                  caption: `🎉 Ваше изображение готово!

💰 Списано: 1 токен
🆔 ID генерации: ${imageId}

Спасибо за использование нашего сервиса!`,
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {
                          text: '🖼 Создать еще изображение',
                          callback_data: 'image',
                        },
                      ],
                      [{ text: '🏠 Главное меню', callback_data: 'main' }],
                    ],
                  },
                });
                return;
              } catch (imageError) {
                this.logger.warn('Could not send image directly:', imageError);
                // Fallback - send text message with download link
                await this.bot.sendMessage(
                  chatId,
                  `🎉 Ваше изображение готово!

💰 Списано: 1 токен
🆔 ID генерации: ${imageId}
📱 Скачать: ${result.imageUrl}

Спасибо за использование нашего сервиса!`,
                  {
                    reply_markup: {
                      inline_keyboard: [
                        [
                          {
                            text: '🖼 Создать еще изображение',
                            callback_data: 'image',
                          },
                        ],
                        [{ text: '🏠 Главное меню', callback_data: 'main' }],
                      ],
                    },
                  },
                );
                return;
              }
            }
          } catch (error) {
            this.logger.error(
              `Could not get final result for ${imageId}:`,
              error,
            );
          }

          // If we can't get the result, send timeout message
          await this.bot.sendMessage(
            chatId,
            `⏰ Превышено время ожидания

Генерация может все еще продолжаться.
Изображение должно появиться в вашем аккаунте Kling AI.
🆔 ID генерации: ${imageId}`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔄 Попробовать снова', callback_data: 'image' }],
                  [{ text: '🏠 Главное меню', callback_data: 'main' }],
                ],
              },
            },
          );
          return;
        }

        // Continue polling - быстрее проверяем для ранних ошибок
        const checkInterval = attempts <= 3 ? 10000 : 30000; // Первые 3 раза каждые 10 сек
        setTimeout(poll, checkInterval);
      } catch (error) {
        this.logger.error(`Error in image polling for ${imageId}:`, error);

        if (attempts < maxAttempts) {
          const checkInterval = attempts <= 3 ? 10000 : 30000; // Быстро проверяем на ошибки
          setTimeout(poll, checkInterval);
        } else {
          await this.bot.sendMessage(
            chatId,
            `❌ Ошибка во время генерации

Обратитесь в поддержку для получения результата.
🆔 ID генерации: ${imageId}`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🏠 Главное меню', callback_data: 'main' }],
                ],
              },
            },
          );
        }
      }
    };

    // Start polling after initial delay - быстрее начинаем
    setTimeout(poll, 10000);
  }

  private handleTextMessage(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) return;

    const userState = this.userStates.get(chatId);

    // Handle broadcast states first
    if (userState?.state === 'awaiting_broadcast_content') {
      this.handleBroadcastContent(msg);
      return;
    }

    if (
      userState?.state === 'awaiting_broadcast_tokens' &&
      this.isAdmin(msg.from?.id)
    ) {
      this.handleBroadcastTokens(chatId, text);
      return;
    }

    // Handle admin token management states
    if (
      userState?.state === 'awaiting_user_id_for_tokens' &&
      this.isAdmin(msg.from?.id)
    ) {
      this.handleUserIdForTokens(chatId, text, userState.data?.action);
      return;
    }

    if (
      userState?.state === 'awaiting_token_amounts' &&
      this.isAdmin(msg.from?.id)
    ) {
      this.handleTokenAmounts(
        chatId,
        text,
        userState.data?.userId,
        userState.data?.action,
      );
      return;
    }

    // Handle API keys management states
    if (
      userState?.state === 'awaiting_access_key' &&
      this.isAdmin(msg.from?.id)
    ) {
      this.handleNewAccessKey(chatId, text);
      return;
    }

    if (
      userState?.state === 'awaiting_secret_key' &&
      this.isAdmin(msg.from?.id)
    ) {
      this.handleNewSecretKey(chatId, text);
      return;
    }

    if (userState?.state === 'waiting_video_prompt') {
      // User is in video generation flow
      if (text.length > 300) {
        this.bot.sendMessage(
          chatId,
          '⚠️ Промпт слишком длинный! Максимальная длина: 300 символов. Попробуйте сократить описание.',
        );
        return;
      }

      // Move user to HIGH_INTENT group when they provide a prompt
      if (msg.from?.id) {
        const currentGroup = this.userGroups.get(msg.from.id);
        if (currentGroup === 'new_id' || currentGroup === 'never_paid') {
          this.addUserToGroup(msg.from.id, 'high_intent');
        }
      }

      // Save the prompt
      this.userStates.set(chatId, {
        state: 'video_prompt_received',
        data: { prompt: text, images: [] },
      });

      const responseText = `
✅ Промпт получен: "${text}"

📸 Теперь можете добавить до 2 изображений (необязательно) или сразу перейти к настройкам генерации.

Что делаем дальше?
      `;

      const keyboard = {
        inline_keyboard: [
          [{ text: '⚙️ Настройки генерации', callback_data: 'video_settings' }],
          [{ text: '🔙 Назад к видео', callback_data: 'video' }],
          [{ text: '🏠 Главное меню', callback_data: 'main' }],
        ],
      };

      this.bot.sendMessage(chatId, responseText, { reply_markup: keyboard });
      return;
    }

    if (userState?.state === 'waiting_image_prompt') {
      // User is in image generation flow
      if (text.length > 300) {
        this.bot.sendMessage(
          chatId,
          '⚠️ Промпт слишком длинный! Максимальная длина: 300 символов. Попробуйте сократить описание.',
        );
        return;
      }

      // Move user to HIGH_INTENT group when they provide a prompt
      if (msg.from?.id) {
        const currentGroup = this.userGroups.get(msg.from.id);
        if (currentGroup === 'new_id' || currentGroup === 'never_paid') {
          this.addUserToGroup(msg.from.id, 'high_intent');
        }
      }

      // Save the prompt and show aspect ratio selection
      this.userStates.set(chatId, {
        state: 'image_prompt_received',
        data: { prompt: text },
      });

      const responseText = `
✅ Промпт получен: "${text}"

📐 Выберите соотношение сторон для изображения:
      `;

      const keyboard = {
        inline_keyboard: [
          [
            { text: '⬜ 1:1 (квадрат)', callback_data: 'image_ratio_1:1' },
            {
              text: '📱 9:16 (вертикальное)',
              callback_data: 'image_ratio_9:16',
            },
          ],
          [
            {
              text: '🖥️ 16:9 (горизонтальное)',
              callback_data: 'image_ratio_16:9',
            },
          ],
          [
            { text: '🔙 Назад к изображениям', callback_data: 'image' },
            { text: '🏠 Главное меню', callback_data: 'main' },
          ],
        ],
      };

      this.bot.sendMessage(chatId, responseText, { reply_markup: keyboard });
      return;
    }

    // Default response for other states
    this.bot.sendMessage(
      chatId,
      `Получено сообщение: "${text}"\nИспользуйте /main для перехода в главное меню.`,
    );
  }

  private handlePhotoMessage(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const userState = this.userStates.get(chatId);

    if (userState?.state === 'video_prompt_received') {
      const currentImages = userState.data?.images || [];

      if (currentImages.length >= 2) {
        this.bot.sendMessage(
          chatId,
          '⚠️ Максимум 2 изображения! Удалите существующие или перейдите к настройкам генерации.',
        );
        return;
      }

      // Get the highest resolution photo
      const photo = msg.photo?.[msg.photo.length - 1];
      if (photo) {
        currentImages.push({
          file_id: photo.file_id,
          file_unique_id: photo.file_unique_id,
        });

        this.userStates.set(chatId, {
          ...userState,
          data: { ...userState.data, images: currentImages },
        });

        const responseText = `
📸 Изображение ${currentImages.length}/2 добавлено!

${
  currentImages.length === 2
    ? '✅ Достигнут лимит изображений (2/2)'
    : `📷 Можете добавить еще ${2 - currentImages.length} изображение`
}

Промпт: "${userState.data?.prompt}"
Изображений: ${currentImages.length}/2

Готовы к генерации?
        `;

        const keyboard = {
          inline_keyboard: [
            [
              {
                text: '⚙️ Настройки генерации',
                callback_data: 'video_settings',
              },
            ],
            [
              {
                text: '🗑️ Очистить изображения',
                callback_data: 'clear_images',
              },
            ],
            [{ text: '🔙 Назад к видео', callback_data: 'video' }],
          ],
        };

        this.bot.sendMessage(chatId, responseText, { reply_markup: keyboard });
      }
    } else {
      this.bot.sendMessage(
        chatId,
        'Для добавления изображений сначала выберите "🎬 Видео" и введите описание.',
      );
    }
  }

  private handleDocumentMessage(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const document = msg.document;

    if (!document) return;

    // Check if it's an unsupported file format
    const supportedFormats = ['jpg', 'jpeg', 'png'];
    const fileExtension = document.file_name?.split('.').pop()?.toLowerCase();
    const maxSizeMB = 20;
    const fileSizeMB = (document.file_size || 0) / (1024 * 1024);

    if (!fileExtension || !supportedFormats.includes(fileExtension)) {
      this.bot.sendMessage(
        chatId,
        '❌ Неподдерживаемый формат файла. Требуется: Jpg/PNG до 20 МБ',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'main' }],
            ],
          },
        },
      );
      return;
    }

    if (fileSizeMB > maxSizeMB) {
      this.bot.sendMessage(
        chatId,
        '❌ Неподдерживаемый формат файла. Требуется: Jpg/PNG до 20 МБ',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'main' }],
            ],
          },
        },
      );
      return;
    }

    // If format and size are valid, treat as image for video generation
    const userState = this.userStates.get(chatId);

    if (userState?.state === 'video_prompt_received') {
      const currentImages = userState.data?.images || [];

      if (currentImages.length >= 2) {
        this.bot.sendMessage(
          chatId,
          '⚠️ Максимум 2 изображения для генерации видео.',
        );
        return;
      }

      // Add the document as an image
      const updatedImages = [
        ...currentImages,
        {
          file_id: document.file_id,
          file_unique_id: document.file_unique_id,
        },
      ];

      this.userStates.set(chatId, {
        ...userState,
        data: { ...userState.data, images: updatedImages },
      });

      const responseText = `
✅ Изображение добавлено! ${
        updatedImages.length >= 2
          ? 'Достигнут максимум (2/2)'
          : `Можете добавить еще ${2 - updatedImages.length} изображение`
      }

Промпт: "${userState.data?.prompt}"
Изображений: ${updatedImages.length}/2

Готовы к генерации?
      `;

      const keyboard = {
        inline_keyboard: [
          [
            {
              text: '⚙️ Настройки генерации',
              callback_data: 'video_settings',
            },
          ],
          [
            {
              text: '🗑️ Очистить изображения',
              callback_data: 'clear_images',
            },
            { text: '🏠 Главное меню', callback_data: 'main' },
          ],
        ],
      };

      this.bot.sendMessage(chatId, responseText, { reply_markup: keyboard });
    } else {
      this.bot.sendMessage(
        chatId,
        'Для добавления изображений сначала выберите "🎬 Видео" и введите описание.',
      );
    }
  }

  // Public method to send photos
  async sendPhoto(chatId: number, photo: any, options?: any) {
    try {
      return await this.bot.sendPhoto(chatId, photo, options);
    } catch (error) {
      this.logger.error('Error sending photo:', error);
      throw error;
    }
  }

  // Public method to send videos
  async sendVideo(chatId: number, video: any, options?: any) {
    try {
      // Send only as video
      const videoResult = await this.bot.sendVideo(chatId, video, options);
      return videoResult;
    } catch (error) {
      this.logger.error('Error sending video:', error);
      throw error;
    }
  }

  private calculateProgress(
    attempts: number,
    maxAttempts: number,
    status: string,
  ): number {
    if (status === 'completed') return 100;
    if (status === 'failed') return 0;

    // Base progress on attempts (time elapsed)
    const timeProgress = Math.min((attempts / maxAttempts) * 100, 95);

    // Add status-based progress
    let statusProgress = 0;
    switch (status) {
      case 'pending':
        statusProgress = 10;
        break;
      case 'processing':
        statusProgress = 30;
        break;
      default:
        statusProgress = 20;
    }

    return Math.min(Math.max(timeProgress, statusProgress), 95);
  }

  private createProgressBar(progress: number): string {
    const totalBlocks = 15;
    const filledBlocks = Math.floor((progress / 100) * totalBlocks);
    const emptyBlocks = totalBlocks - filledBlocks;

    const filled = '█'.repeat(filledBlocks);
    const empty = '▒'.repeat(emptyBlocks);

    return `[${filled}${empty}`;
  }

  private handleSubscriptionPlan(
    chatId: number,
    plan: 'start' | 'advanced' | 'pro',
  ) {
    const plans = {
      start: {
        name: '💎 СТАРТ',
        videos: 25,
        images: 100,
        price: 1200,
        description: 'Базовый пакет • идеален для тестирования',
        oldPrice: undefined as number | undefined,
      },
      advanced: {
        name: '💎 ПРОДВИНУТЫЙ',
        videos: 50,
        images: 100,
        price: 2230,
        oldPrice: 2400,
        description: 'Самый популярный вариант',
      },
      pro: {
        name: '💎 ПРОФИ',
        videos: 100,
        images: 200,
        price: 4320,
        oldPrice: 4800,
        description: 'Приоритетная очередь',
      },
    };

    const selectedPlan = plans[plan];

    let text = '';

    if (plan === 'start') {
      const packageName = selectedPlan.name || 'СТАРТОВЫЙ ПАКЕТ';
      const amount = selectedPlan.price || 1200;
      text = `
✅ ВЫ ВЫБРАЛИ: ${packageName}
💰 Сумма: ${amount} ₽
🎬 Видео-токены: ${selectedPlan.videos}
📸 Токены изображений: ${selectedPlan.images}

Нажмите кнопку ниже для перехода к оплате:
      `;
    } else {
      const savingsText = selectedPlan.oldPrice
        ? `\n💰 Экономия: ${selectedPlan.oldPrice - selectedPlan.price}₽`
        : '';

      text = `
${selectedPlan.name}

📦 Включает:
• ${selectedPlan.videos} видео генераций
• ${selectedPlan.images} изображений
• ${selectedPlan.description}
• Автопродление (отмена в любой момент)

💵 Стоимость: ${selectedPlan.price}₽/мес${savingsText}

Для оформления подписки обратитесь к администратору.
      `;
    }

    const keyboard = {
      inline_keyboard: [
        [{ text: '💳 Оформить подписку', callback_data: `purchase_${plan}` }],
        [
          { text: '◀️ Назад к тарифам', callback_data: 'balance' },
          { text: '🏠 Главное меню', callback_data: 'main' },
        ],
      ],
    };

    this.bot.sendMessage(chatId, text, { reply_markup: keyboard });
  }

  private handleAdditionalPackages(chatId: number) {
    const text = `
💎 ДОПОЛНИТЕЛЬНЫЕ ПАКЕТЫ

🎬 Video-ТОКЕНЫ:
▫️ 50 видео · 2240₽
🔥 100 видео · 4256₽ · ~~4480₽~~ (-5%)
🔥 250 видео · 9968₽ · ~~11200₽~~ (-11%)

🖼️ Image-ТОКЕНЫ:
▫️ 100 изо · 449₽
🔥 200 изо · 790₽ · ~~898₽~~ (-12%)
🔥 500 изо · 1900₽ · ~~2245₽~~ (-15%)

Покупай генерации, без подписок и ограничений.
    `;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🎬 50 видео · 2240₽', callback_data: 'buy_50_video' },
          { text: '🖼️ 100 img · 449₽', callback_data: 'buy_100_img' },
        ],
        [
          { text: '🔥 100 видео · 4256₽', callback_data: 'buy_100_video' },
          { text: '🔥 200 img · 790₽', callback_data: 'buy_200_img' },
        ],
        [
          { text: '🔥 250 видео · 9968₽', callback_data: 'buy_250_video' },
          { text: '🔥 500 img · 1900₽', callback_data: 'buy_500_img' },
        ],
        [
          { text: '◀️ Назад', callback_data: 'balance' },
          { text: '🏠 Главное меню', callback_data: 'main' },
        ],
      ],
    };

    this.bot.sendMessage(chatId, text, { reply_markup: keyboard });
  }

  private handleCancelSubscription(chatId: number) {
    const text = `
❌ Отмена подписки

Вы действительно хотите отменить подписку?

⚠️ После отмены:
• Автопродление будет остановлено
• Доступ к функциям сохранится до конца оплаченного периода
• Неиспользованные токены останутся на балансе

Отменить подписку можно в любой момент без штрафов.
    `;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: '✅ Да, отменить подписку',
            callback_data: 'confirm_cancel_subscription',
          },
        ],
        [
          { text: '◀️ Назад', callback_data: 'balance' },
          { text: '🏠 Главное меню', callback_data: 'main' },
        ],
      ],
    };

    this.bot.sendMessage(chatId, text, { reply_markup: keyboard });
  }

  private handlePackagePurchase(
    chatId: number,
    packageName: string,
    price: number,
    type: string,
  ) {
    const text = `
✅ ВЫ ВЫБРАЛИ: ПАКЕТ "${packageName.toUpperCase()}"

📋 Срок действия: 180 дней (6 месяцев)
💳 Тип: Разовая покупка (без подписки)
💎 Совместимость: Все новые модели Kling для ${type} генерации (V2.0-V2.1)

✨ ЧТО ВЫ МОЖЕТЕ СОЗДАТЬ:

[💎 БАЗОВЫЙ КОНТЕНТ]
▶ 50 STANDARD видео (1 токен/5s)
  - Идеально для: TikTok/Reels, быстрые сторис, тестирование идей
  - Пример: 50 коротких клипов о продукте

[💎 ПРОФЕССИОНАЛЬНЫЙ КОНТЕНТ]
▶ 25 PRO видео (2 токена/5s)
  - Идеально для: рекламных роликов, инфографики, презентаций
  - Пример: 25 качественных промо-роликов для соцсетей

[💎 ПРЕМИУМ КОНТЕНТ]
▶ 12 MASTER видео (4 токена/5s)
  - Идеально для: YouTube-анонсов, продающих видео, ключевых постов
  - Пример: 12 топовых видео для запуска продукта

💳 СТОИМОСТЬ: ${price}₽
    `;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: `� TG STARS • ${price} 💫`,
            callback_data: `buy_stars_${packageName.replace(/\s+/g, '_')}_${price}`,
          },
        ],
        [
          {
            text: `💳 БАНКОВСКАЯ КАРТА • ${price}₽`,
            callback_data: `buy_card_${packageName.replace(/\s+/g, '_')}_${price}`,
          },
        ],
        [{ text: 'Назад', callback_data: 'main' }],
      ],
    };

    this.bot.sendMessage(chatId, text, { reply_markup: keyboard });
  }

  private isAdmin(userId?: number): boolean {
    return userId ? this.adminIds.includes(userId) : false;
  }

  private handleBroadcastCommand(chatId: number, userId?: number) {
    if (!this.isAdmin(userId)) {
      this.bot.sendMessage(
        chatId,
        '❌ У вас нет прав для выполнения этой команды',
      );
      return;
    }

    const text = `
📢 ПАНЕЛЬ РАССЫЛОК

Выберите группу пользователей для рассылки:

🔴 NEVER PAID - никогда не оплачивали
🟡 HIGH INTENT - оставили промпт/дошли до оплаты, но не завершили
🟢 NEW_ID - ранее не получали рассылки с пункта 8.2 (новые пользователи)

Механика:
Вы напишете пост, укажете количество генераций видео и изображений, выберите группу рассылки, укажете требуется ли подписка на канал @vse_ai.

a) Выбранным пользователям приходит пост
b) Этим пользователям добавляется токены в видео и изображения (неиспользованные удаляются через 3 дня)
c) Если указана подписка на канал, то генерации добавляются только после подписки на канал @vse_ai
    `;

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔴 NEVER PAID', callback_data: 'broadcast_never_paid' }],
        [{ text: '🟡 HIGH INTENT', callback_data: 'broadcast_high_intent' }],
        [{ text: '🟢 NEW_ID', callback_data: 'broadcast_new_id' }],
        [
          {
            text: '📝 Начать создание рассылки',
            callback_data: 'broadcast_start',
          },
        ],
      ],
    };

    this.bot.sendMessage(chatId, text, { reply_markup: keyboard });
  }

  private handleBroadcastStart(chatId: number, userId?: number) {
    if (!this.isAdmin(userId)) {
      this.bot.sendMessage(
        chatId,
        '❌ У вас нет прав для выполнения этой команды',
      );
      return;
    }

    this.broadcastStates.set(chatId, {});

    const text = `
📝 СОЗДАНИЕ РАССЫЛКИ - ШАГ 1/5

Отправьте содержание поста для рассылки.
Это может быть:
- Текст
- Фото с подписью
- Видео с подписью
- Комбинированный контент

После отправки перейдем к настройке токенов и целевой аудитории.
    `;

    this.bot.sendMessage(chatId, text);

    // Set user state to expect broadcast content
    this.userStates.set(chatId, { state: 'awaiting_broadcast_content' });
  }

  private handleBroadcastGroup(
    chatId: number,
    groupType: string,
    userId?: number,
  ) {
    if (!this.isAdmin(userId)) {
      this.bot.sendMessage(
        chatId,
        '❌ У вас нет прав для выполнения этой команды',
      );
      return;
    }

    const groupNames = {
      never_paid: 'NEVER PAID - никогда не оплачивали',
      high_intent: 'HIGH INTENT - дошли до оплаты, но не завершили',
      new_id: 'NEW_ID - новые пользователи',
    };

    const groupName = groupNames[groupType] || 'Неизвестная группа';

    const text = `
📊 СТАТИСТИКА ГРУППЫ: ${groupName}

🔍 Анализ пользователей:
- Общее количество: подсчитывается...
- Активные за последние 7 дней: подсчитывается...
- Последняя рассылка: не проводилась

Для создания рассылки для этой группы используйте кнопку "📝 Начать создание рассылки" в главном меню рассылок.
    `;

    const keyboard = {
      inline_keyboard: [
        [{ text: '◀️ Назад к рассылкам', callback_data: 'back_to_broadcast' }],
      ],
    };

    this.bot.sendMessage(chatId, text, { reply_markup: keyboard });
  }

  private async handleBroadcastContent(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const userState = this.userStates.get(chatId);

    if (!this.isAdmin(msg.from?.id)) {
      return;
    }

    if (userState?.state !== 'awaiting_broadcast_content') {
      return;
    }

    // Store the message content for broadcast
    const broadcastState = this.broadcastStates.get(chatId) || {};
    broadcastState.content = JSON.stringify(msg);
    this.broadcastStates.set(chatId, broadcastState);

    const text = `
📝 СОЗДАНИЕ РАССЫЛКИ - ШАГ 2/5

✅ Контент сохранен!

Теперь укажите количество токенов для рассылки:

Формат: [количество_видео] [количество_изображений]
Пример: 5 10

Отправьте в следующем сообщении.
    `;

    this.bot.sendMessage(chatId, text);
    this.userStates.set(chatId, { state: 'awaiting_broadcast_tokens' });
  }

  private handleBroadcastTokens(chatId: number, text: string) {
    const tokens = text.trim().split(/\s+/);

    if (tokens.length !== 2) {
      this.bot.sendMessage(
        chatId,
        '❌ Неверный формат! Используйте: [количество_видео] [количество_изображений]\nПример: 5 10',
      );
      return;
    }

    const videoTokens = parseInt(tokens[0]);
    const imageTokens = parseInt(tokens[1]);

    if (
      isNaN(videoTokens) ||
      isNaN(imageTokens) ||
      videoTokens < 0 ||
      imageTokens < 0
    ) {
      this.bot.sendMessage(
        chatId,
        '❌ Некорректные числа! Используйте положительные числа.\nПример: 5 10',
      );
      return;
    }

    // Update broadcast state
    const broadcastState = this.broadcastStates.get(chatId) || {};
    broadcastState.videoTokens = videoTokens;
    broadcastState.imageTokens = imageTokens;
    this.broadcastStates.set(chatId, broadcastState);

    const text1 = `
📝 СОЗДАНИЕ РАССЫЛКИ - ШАГ 3/5

✅ Токены установлены:
🎬 Видео: ${videoTokens} токенов
🖼️ Изображения: ${imageTokens} токенов

Теперь выберите целевую группу пользователей:
    `;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: '🔴 NEVER PAID',
            callback_data: 'broadcast_select_never_paid',
          },
        ],
        [
          {
            text: '🟡 HIGH INTENT',
            callback_data: 'broadcast_select_high_intent',
          },
        ],
        [{ text: '🟢 NEW_ID', callback_data: 'broadcast_select_new_id' }],
      ],
    };

    this.bot.sendMessage(chatId, text1, { reply_markup: keyboard });
    this.userStates.set(chatId, { state: 'awaiting_group_selection' });
  }

  private handleGroupSelection(chatId: number, group: string, userId?: number) {
    if (!this.isAdmin(userId)) {
      this.bot.sendMessage(
        chatId,
        '❌ У вас нет прав для выполнения этой команды',
      );
      return;
    }

    const broadcastState = this.broadcastStates.get(chatId) || {};
    broadcastState.targetGroup = group;
    this.broadcastStates.set(chatId, broadcastState);

    const groupNames = {
      never_paid: 'NEVER PAID',
      high_intent: 'HIGH INTENT',
      new_id: 'NEW_ID',
    };

    const text = `
📝 СОЗДАНИЕ РАССЫЛКИ - ШАГ 4/5

✅ Группа выбрана: ${groupNames[group]}

Требуется ли подписка на канал @vse_ai?
Если да, то токены будут добавлены только после подписки.
    `;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: '✅ Требуется подписка',
            callback_data: 'broadcast_require_sub',
          },
        ],
        [{ text: '❌ Без подписки', callback_data: 'broadcast_no_sub' }],
      ],
    };

    this.bot.sendMessage(chatId, text, { reply_markup: keyboard });
  }

  private handleSubscriptionRequirement(
    chatId: number,
    requiresSubscription: boolean,
    userId?: number,
  ) {
    if (!this.isAdmin(userId)) {
      this.bot.sendMessage(
        chatId,
        '❌ У вас нет прав для выполнения этой команды',
      );
      return;
    }

    const broadcastState = this.broadcastStates.get(chatId) || {};
    broadcastState.requiresSubscription = requiresSubscription;
    this.broadcastStates.set(chatId, broadcastState);

    const groupNames = {
      never_paid: 'NEVER PAID',
      high_intent: 'HIGH INTENT',
      new_id: 'NEW_ID',
    };

    const groupName = broadcastState.targetGroup
      ? groupNames[broadcastState.targetGroup] || 'Неизвестная'
      : 'Не выбрана';
    const subText = requiresSubscription
      ? '✅ Требуется подписка на @vse_ai'
      : '❌ Без подписки';

    const text = `
📝 СОЗДАНИЕ РАССЫЛКИ - ШАГ 5/5

📋 ИТОГОВЫЕ НАСТРОЙКИ:
🎬 Видео токены: ${broadcastState.videoTokens || 0}
🖼️ Токены изображений: ${broadcastState.imageTokens || 0}
👥 Целевая группа: ${groupName}
📺 Подписка: ${subText}

⚠️ ВНИМАНИЕ: После подтверждения рассылка будет отправлена всем пользователям выбранной группы!

Неиспользованные токены удаляются через 3 дня.
    `;

    const keyboard = {
      inline_keyboard: [
        [{ text: '🚀 ЗАПУСТИТЬ РАССЫЛКУ', callback_data: 'broadcast_confirm' }],
        [{ text: '❌ Отменить', callback_data: 'broadcast_cancel' }],
      ],
    };

    this.bot.sendMessage(chatId, text, { reply_markup: keyboard });
  }

  private async handleBroadcastConfirm(chatId: number, userId?: number) {
    if (!this.isAdmin(userId)) {
      this.bot.sendMessage(
        chatId,
        '❌ У вас нет прав для выполнения этой команды',
      );
      return;
    }

    const broadcastState = this.broadcastStates.get(chatId);

    if (
      !broadcastState ||
      !broadcastState.content ||
      !broadcastState.targetGroup
    ) {
      this.bot.sendMessage(
        chatId,
        '❌ Ошибка: неполная информация для рассылки',
      );
      return;
    }

    this.bot.sendMessage(
      chatId,
      '🚀 Рассылка запущена! Это может занять некоторое время...',
    );

    // Get target users by group
    const targetUsers = this.getUsersByGroup(
      broadcastState.targetGroup as 'never_paid' | 'high_intent' | 'new_id',
    );
    let sentCount = 0;

    // Parse the stored message
    const originalMessage = JSON.parse(broadcastState.content);

    for (const targetUserId of targetUsers) {
      try {
        // Send the broadcast message
        await this.sendBroadcastMessage(targetUserId, originalMessage);

        // Handle tokens
        if (broadcastState.requiresSubscription) {
          // Check if user is already subscribed
          const isSubscribed = await this.checkUserSubscription(targetUserId);

          if (isSubscribed) {
            // Add tokens directly
            this.addTokensToUser(
              targetUserId,
              broadcastState.videoTokens || 0,
              broadcastState.imageTokens || 0,
            );
          } else {
            // Store pending tokens and send subscription message
            this.pendingTokens.set(targetUserId, {
              videoTokens: broadcastState.videoTokens || 0,
              imageTokens: broadcastState.imageTokens || 0,
            });

            await this.sendSubscriptionPrompt(
              targetUserId,
              broadcastState.videoTokens || 0,
              broadcastState.imageTokens || 0,
            );
          }
        } else {
          // Add tokens directly
          this.addTokensToUser(
            targetUserId,
            broadcastState.videoTokens || 0,
            broadcastState.imageTokens || 0,
          );
        }

        sentCount++;

        // Small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        this.logger.error(
          `Failed to send broadcast to user ${targetUserId}:`,
          error,
        );
      }
    }

    const text = `
✅ РАССЫЛКА ЗАВЕРШЕНА!

📊 Статистика:
• Целевая группа: ${broadcastState.targetGroup}
• Отправлено: ${sentCount} пользователей
• Токены добавлены: ${broadcastState.videoTokens}🎬 + ${broadcastState.imageTokens}🖼️
• Подписка требуется: ${broadcastState.requiresSubscription ? 'Да' : 'Нет'}
    `;

    this.bot.sendMessage(chatId, text);

    // Clean up
    this.broadcastStates.delete(chatId);
    this.userStates.delete(chatId);
  }

  private handleBroadcastCancel(chatId: number, userId?: number) {
    if (!this.isAdmin(userId)) {
      this.bot.sendMessage(
        chatId,
        '❌ У вас нет прав для выполнения этой команды',
      );
      return;
    }

    // Clean up
    this.broadcastStates.delete(chatId);
    this.userStates.delete(chatId);

    this.bot.sendMessage(chatId, '❌ Рассылка отменена');
  }

  // Utility methods for broadcast system

  private getUsersByGroup(
    group: 'never_paid' | 'high_intent' | 'new_id',
  ): number[] {
    const users: number[] = [];

    for (const [userId, userGroup] of this.userGroups.entries()) {
      if (userGroup === group) {
        users.push(userId);
      }
    }

    // For demo purposes, return some mock users if no real users found
    if (users.length === 0) {
      // In real implementation, this would query the database
      this.logger.warn(`No users found for group ${group}, using demo mode`);
    }

    return users;
  }

  private async sendBroadcastMessage(userId: number, originalMessage: any) {
    if (originalMessage.text) {
      // Text message
      await this.bot.sendMessage(userId, originalMessage.text);
    } else if (originalMessage.photo) {
      // Photo message
      const photo = originalMessage.photo[originalMessage.photo.length - 1]; // Get highest quality
      await this.bot.sendPhoto(userId, photo.file_id, {
        caption: originalMessage.caption,
      });
    } else if (originalMessage.video) {
      // Video message
      await this.bot.sendVideo(userId, originalMessage.video.file_id, {
        caption: originalMessage.caption,
      });
    } else if (originalMessage.document) {
      // Document message
      await this.bot.sendDocument(userId, originalMessage.document.file_id, {
        caption: originalMessage.caption,
      });
    }
  }

  private async checkUserSubscription(userId: number): Promise<boolean> {
    try {
      const chatMember = await this.bot.getChatMember(this.channelId, userId);
      return ['member', 'administrator', 'creator'].includes(chatMember.status);
    } catch (error) {
      this.logger.error(
        `Error checking subscription for user ${userId}:`,
        error,
      );
      return false;
    }
  }

  private addTokensToUser(
    userId: number,
    videoTokens: number,
    imageTokens: number,
  ) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 3); // 3 days from now

    const existing = this.userTokens.get(userId);

    if (existing) {
      // Add to existing tokens
      existing.videoTokens += videoTokens;
      existing.imageTokens += imageTokens;
      existing.expiresAt = expiresAt; // Reset expiration
      existing.fromBroadcast = true;
    } else {
      // Create new token record
      this.userTokens.set(userId, {
        videoTokens,
        imageTokens,
        expiresAt,
        fromBroadcast: true,
      });
    }

    this.logger.log(
      `Added tokens to user ${userId}: ${videoTokens} video, ${imageTokens} image`,
    );
  }

  private async sendSubscriptionPrompt(
    userId: number,
    videoTokens: number,
    imageTokens: number,
  ) {
    const text = `
🎁 Вам начислены бесплатные генерации!

Чтобы активировать их, подпишитесь на наш канал @vse_ai.

🔓 После подписки вы получите:
• ${imageTokens} генераций изображений
• ${videoTokens} генераций видео (5 сек)

⏳ Генерации действуют 3 дня. Успейте использовать!
    `;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: '✅ Подписаться на @vse_ai',
            callback_data: 'subscribe_channel',
          },
        ],
        [
          {
            text: '▶️ Проверить подписку',
            callback_data: 'check_subscription',
          },
        ],
      ],
    };

    await this.bot.sendMessage(userId, text, { reply_markup: keyboard });
  }

  private handleSubscribeChannel(chatId: number) {
    this.bot.sendMessage(
      chatId,
      `Перейдите по ссылке для подписки: ${this.channelId}\n\nПосле подписки нажмите "Проверить подписку"`,
    );
  }

  private async handleCheckSubscription(chatId: number, userId?: number) {
    if (!userId) return;

    const pendingTokensData = this.pendingTokens.get(chatId);
    if (!pendingTokensData) {
      this.bot.sendMessage(chatId, '❌ У вас нет ожидающих токенов');
      return;
    }

    const isSubscribed = await this.checkUserSubscription(userId);

    if (isSubscribed) {
      // Add the pending tokens
      this.addTokensToUser(
        chatId,
        pendingTokensData.videoTokens,
        pendingTokensData.imageTokens,
      );

      // Remove from pending
      this.pendingTokens.delete(chatId);

      const text = `
✅ Подписка подтверждена!

🎉 Вам начислены токены:
• ${pendingTokensData.imageTokens} генераций изображений
• ${pendingTokensData.videoTokens} генераций видео (5 сек)

⏳ Токены действуют 3 дня
      `;

      this.bot.sendMessage(chatId, text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎬 Создать видео', callback_data: 'video' }],
            [{ text: '🏠 Главное меню', callback_data: 'main' }],
          ],
        },
      });
    } else {
      this.bot.sendMessage(
        chatId,
        '❌ Подписка не найдена. Убедитесь, что вы подписались на канал @vse_ai',
      );
    }
  }

  // Method to clean up expired tokens (should be called periodically)
  private cleanupExpiredTokens() {
    const now = new Date();

    for (const [userId, tokenData] of this.userTokens.entries()) {
      if (tokenData.expiresAt < now) {
        this.userTokens.delete(userId);
        this.logger.log(`Cleaned up expired tokens for user ${userId}`);
      }
    }
  }

  // Method to add user to a group (to be called when user performs certain actions)
  public addUserToGroup(
    userId: number,
    group: 'never_paid' | 'high_intent' | 'new_id',
  ) {
    this.userGroups.set(userId, group);
    this.logger.log(`User ${userId} added to group ${group}`);
  }

  // Admin token management methods

  private handleAdminCommand(
    chatId: number,
    userId?: number,
    messageId?: number,
  ) {
    if (!this.isAdmin(userId)) {
      this.bot.sendMessage(
        chatId,
        '❌ У вас нет прав для выполнения этой команды',
      );
      return;
    }

    const text = `
⚙️ ПАНЕЛЬ АДМИНИСТРАТОРА

Управление системой и токенами пользователей:

🔧 Управление токенами:
• Просмотр токенов пользователей
• Добавление токенов
• Удаление токенов
• Очистка истекших токенов

🔑 Управление Kling AI API:
• Просмотр текущих ключей
• Изменение Access Key
• Изменение Secret Key

📊 Статистика системы в разработке
    `;

    const keyboard = {
      inline_keyboard: [
        [{ text: '💎 Управление токенами', callback_data: 'admin_tokens' }],
        [
          {
            text: '🔑 Управление API ключами',
            callback_data: 'admin_api_keys',
          },
        ],
        [{ text: '🏠 Главное меню', callback_data: 'main' }],
      ],
    };

    if (messageId) {
      // Update existing message
      this.bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard,
      });
    } else {
      // Send new message
      this.bot.sendMessage(chatId, text, { reply_markup: keyboard });
    }
  }

  private handleAdminTokens(chatId: number, userId?: number) {
    if (!this.isAdmin(userId)) {
      this.bot.sendMessage(
        chatId,
        '❌ У вас нет прав для выполнения этой команды',
      );
      return;
    }

    const totalUsers = this.userTokens.size;
    const now = new Date();
    let activeTokens = 0;
    let expiredTokens = 0;

    for (const [, tokenData] of this.userTokens.entries()) {
      if (tokenData.expiresAt > now) {
        activeTokens++;
      } else {
        expiredTokens++;
      }
    }

    const text = `
💎 УПРАВЛЕНИЕ ТОКЕНАМИ

📊 Статистика:
• Всего пользователей с токенами: ${totalUsers}
• Активные токены: ${activeTokens}
• Истекшие токены: ${expiredTokens}

Выберите действие:
    `;

    const keyboard = {
      inline_keyboard: [
        [{ text: '👁️ Просмотр токенов', callback_data: 'admin_view_tokens' }],
        [{ text: '➕ Добавить токены', callback_data: 'admin_add_tokens' }],
        [{ text: '➖ Удалить токены', callback_data: 'admin_remove_tokens' }],
        [
          {
            text: '🗑️ Очистить истекшие',
            callback_data: 'admin_clear_expired',
          },
        ],
        [{ text: '◀️ Назад', callback_data: 'admin_back' }],
      ],
    };

    this.bot.sendMessage(chatId, text, { reply_markup: keyboard });
  }

  private handleViewUserTokens(chatId: number, userId?: number) {
    if (!this.isAdmin(userId)) {
      this.bot.sendMessage(
        chatId,
        '❌ У вас нет прав для выполнения этой команды',
      );
      return;
    }

    let text = '👁️ ПРОСМОТР ТОКЕНОВ ПОЛЬЗОВАТЕЛЕЙ\n\n';

    if (this.userTokens.size === 0) {
      text += 'Нет пользователей с токенами.';
    } else {
      const now = new Date();
      let counter = 1;

      for (const [userId, tokenData] of this.userTokens.entries()) {
        const isExpired = tokenData.expiresAt < now;
        const expiryText = isExpired
          ? '❌ ИСТЕК'
          : `⏳ до ${tokenData.expiresAt.toLocaleString()}`;
        const broadcastMark = tokenData.fromBroadcast ? ' 📢' : '';

        text += `${counter}. User ID: ${userId}${broadcastMark}\n`;
        text += `   🎬 Видео: ${tokenData.videoTokens} | 🖼️ Изображения: ${tokenData.imageTokens}\n`;
        text += `   ${expiryText}\n\n`;

        counter++;

        // Limit to 20 users per message to avoid hitting Telegram's message limit
        if (counter > 20) {
          text += `... и еще ${this.userTokens.size - 20} пользователей`;
          break;
        }
      }
    }

    const keyboard = {
      inline_keyboard: [
        [{ text: '🔄 Обновить', callback_data: 'admin_view_tokens' }],
        [{ text: '◀️ Назад к токенам', callback_data: 'admin_tokens' }],
      ],
    };

    this.bot.sendMessage(chatId, text, { reply_markup: keyboard });
  }

  private handleAddTokensMenu(chatId: number, userId?: number) {
    if (!this.isAdmin(userId)) {
      this.bot.sendMessage(
        chatId,
        '❌ У вас нет прав для выполнения этой команды',
      );
      return;
    }

    const text = `
➕ ДОБАВЛЕНИЕ ТОКЕНОВ

Отправьте ID пользователя, которому нужно добавить токены.

Пример: 123456789
    `;

    this.bot.sendMessage(chatId, text);
    this.userStates.set(chatId, {
      state: 'awaiting_user_id_for_tokens',
      data: { action: 'add' },
    });
  }

  private handleRemoveTokensMenu(chatId: number, userId?: number) {
    if (!this.isAdmin(userId)) {
      this.bot.sendMessage(
        chatId,
        '❌ У вас нет прав для выполнения этой команды',
      );
      return;
    }

    const text = `
➖ УДАЛЕНИЕ ТОКЕНОВ

Отправьте ID пользователя, у которого нужно удалить токены.

Пример: 123456789
    `;

    this.bot.sendMessage(chatId, text);
    this.userStates.set(chatId, {
      state: 'awaiting_user_id_for_tokens',
      data: { action: 'remove' },
    });
  }

  private handleUserIdForTokens(chatId: number, text: string, action: string) {
    const targetUserId = parseInt(text.trim());

    if (isNaN(targetUserId)) {
      this.bot.sendMessage(
        chatId,
        '❌ Некорректный ID пользователя. Введите число.',
      );
      return;
    }

    const actionText = action === 'add' ? 'добавить' : 'удалить';
    const currentTokens = this.userTokens.get(targetUserId);

    let statusText = '';
    if (currentTokens) {
      const now = new Date();
      const isExpired = currentTokens.expiresAt < now;
      statusText = `\n\nТекущие токены:\n🎬 Видео: ${currentTokens.videoTokens}\n🖼️ Изображения: ${currentTokens.imageTokens}\nСтатус: ${isExpired ? '❌ Истек' : '✅ Активен'}`;
    } else {
      statusText = '\n\n❌ У пользователя нет токенов';
    }

    const text1 = `
${action === 'add' ? '➕' : '➖'} ${actionText.toUpperCase()} ТОКЕНЫ

Пользователь ID: ${targetUserId}${statusText}

Введите количество токенов в формате:
[видео_токены] [токены_изображений]

Пример: 5 10
    `;

    this.bot.sendMessage(chatId, text1);
    this.userStates.set(chatId, {
      state: 'awaiting_token_amounts',
      data: { userId: targetUserId, action },
    });
  }

  private handleTokenAmounts(
    chatId: number,
    text: string,
    targetUserId: number,
    action: string,
  ) {
    const amounts = text.trim().split(/\s+/);

    if (amounts.length !== 2) {
      this.bot.sendMessage(
        chatId,
        '❌ Неверный формат! Используйте: [видео] [изображения]\nПример: 5 10',
      );
      return;
    }

    const videoTokens = parseInt(amounts[0]);
    const imageTokens = parseInt(amounts[1]);

    if (
      isNaN(videoTokens) ||
      isNaN(imageTokens) ||
      videoTokens < 0 ||
      imageTokens < 0
    ) {
      this.bot.sendMessage(
        chatId,
        '❌ Некорректные числа! Используйте положительные числа.',
      );
      return;
    }

    if (action === 'add') {
      this.addTokensToUser(targetUserId, videoTokens, imageTokens);

      const text1 = `
✅ ТОКЕНЫ ДОБАВЛЕНЫ

Пользователь ID: ${targetUserId}
➕ Добавлено:
• 🎬 Видео токенов: ${videoTokens}
• 🖼️ Токенов изображений: ${imageTokens}

⏳ Действуют 3 дня
      `;

      this.bot.sendMessage(chatId, text1);

      // Notify user about new tokens
      try {
        this.bot.sendMessage(
          targetUserId,
          `
🎁 Вам начислены токены администратором!

• 🎬 Видео токенов: ${videoTokens}
• 🖼️ Токенов изображений: ${imageTokens}

⏳ Действуют 3 дня. Успейте использовать!
        `,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🎬 Создать видео', callback_data: 'video' }],
                [{ text: '🏠 Главное меню', callback_data: 'main' }],
              ],
            },
          },
        );
      } catch (error) {
        this.logger.warn(
          `Could not notify user ${targetUserId} about new tokens`,
        );
      }
    } else {
      // Remove tokens
      const currentTokens = this.userTokens.get(targetUserId);

      if (!currentTokens) {
        this.bot.sendMessage(
          chatId,
          '❌ У пользователя нет токенов для удаления',
        );
        this.userStates.delete(chatId);
        return;
      }

      const newVideoTokens = Math.max(
        0,
        currentTokens.videoTokens - videoTokens,
      );
      const newImageTokens = Math.max(
        0,
        currentTokens.imageTokens - imageTokens,
      );

      if (newVideoTokens === 0 && newImageTokens === 0) {
        // Remove user completely if no tokens left
        this.userTokens.delete(targetUserId);
      } else {
        // Update with remaining tokens
        this.userTokens.set(targetUserId, {
          ...currentTokens,
          videoTokens: newVideoTokens,
          imageTokens: newImageTokens,
        });
      }

      const text1 = `
✅ ТОКЕНЫ УДАЛЕНЫ

Пользователь ID: ${targetUserId}
➖ Удалено:
• 🎬 Видео токенов: ${Math.min(videoTokens, currentTokens.videoTokens)}
• 🖼️ Токенов изображений: ${Math.min(imageTokens, currentTokens.imageTokens)}

Осталось:
• 🎬 Видео: ${newVideoTokens}
• 🖼️ Изображения: ${newImageTokens}
      `;

      this.bot.sendMessage(chatId, text1);
    }

    this.userStates.delete(chatId);
  }

  private handleClearExpiredTokens(chatId: number, userId?: number) {
    if (!this.isAdmin(userId)) {
      this.bot.sendMessage(
        chatId,
        '❌ У вас нет прав для выполнения этой команды',
      );
      return;
    }

    const beforeCount = this.userTokens.size;
    this.cleanupExpiredTokens();
    const afterCount = this.userTokens.size;
    const removedCount = beforeCount - afterCount;

    const text = `
🗑️ ОЧИСТКА ЗАВЕРШЕНА

📊 Результат:
• Было пользователей с токенами: ${beforeCount}
• Удалено истекших записей: ${removedCount}
• Осталось активных: ${afterCount}
    `;

    this.bot.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '◀️ Назад к токенам', callback_data: 'admin_tokens' }],
        ],
      },
    });
  }

  // API Keys management methods

  private handleAdminApiKeys(
    chatId: number,
    userId?: number,
    messageId?: number,
  ) {
    if (!this.isAdmin(userId)) {
      this.bot.sendMessage(
        chatId,
        '❌ У вас нет прав для выполнения этой команды',
      );
      return;
    }

    const text = `
🔑 УПРАВЛЕНИЕ KLING AI API КЛЮЧАМИ

Здесь вы можете просматривать и изменять API ключи для Kling AI:

🔍 Просмотр текущих ключей
🔧 Изменение Access Key
🔧 Изменение Secret Key

⚠️ ВНИМАНИЕ: Изменение ключей повлияет на все генерации видео!
    `;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: '👁️ Просмотреть текущие ключи',
            callback_data: 'admin_view_current_keys',
          },
        ],
        [
          {
            text: '🔧 Изменить Access Key',
            callback_data: 'admin_change_access_key',
          },
        ],
        [
          {
            text: '🔧 Изменить Secret Key',
            callback_data: 'admin_change_secret_key',
          },
        ],
        [{ text: '◀️ Назад к админ панели', callback_data: 'admin_back' }],
      ],
    };

    if (messageId) {
      // Update existing message
      this.bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard,
      });
    } else {
      // Send new message
      this.bot.sendMessage(chatId, text, { reply_markup: keyboard });
    }
  }

  private handleViewCurrentKeys(
    chatId: number,
    userId?: number,
    messageId?: number,
  ) {
    if (!this.isAdmin(userId)) {
      this.bot.sendMessage(
        chatId,
        '❌ У вас нет прав для выполнения этой команды',
      );
      return;
    }

    // Get current keys from KlingAiService
    const currentAccessKey =
      this.klingAiService.getCurrentAccessKey() || 'Не установлен';
    const currentSecretKey =
      this.klingAiService.getCurrentSecretKey() || 'Не установлен';

    // Mask the keys for security (show only first 6 and last 4 characters)
    const maskedAccessKey =
      currentAccessKey.length > 10
        ? `${currentAccessKey.substring(0, 6)}***${currentAccessKey.substring(currentAccessKey.length - 4)}`
        : currentAccessKey;

    const maskedSecretKey =
      currentSecretKey.length > 10
        ? `${currentSecretKey.substring(0, 6)}***${currentSecretKey.substring(currentSecretKey.length - 4)}`
        : currentSecretKey;

    const text = `
👁️ ТЕКУЩИЕ API КЛЮЧИ KLING AI

🔑 Access Key: \`${maskedAccessKey}\`
🔐 Secret Key: \`${maskedSecretKey}\`

⚠️ Ключи частично скрыты для безопасности
    `;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: '🔧 Изменить Access Key',
            callback_data: 'admin_change_access_key',
          },
        ],
        [
          {
            text: '🔧 Изменить Secret Key',
            callback_data: 'admin_change_secret_key',
          },
        ],
        [{ text: '◀️ Назад', callback_data: 'admin_api_keys' }],
      ],
    };

    if (messageId) {
      // Update existing message
      this.bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard,
        parse_mode: 'Markdown',
      });
    } else {
      // Send new message
      this.bot.sendMessage(chatId, text, {
        reply_markup: keyboard,
        parse_mode: 'Markdown',
      });
    }
  }

  private handleChangeAccessKey(
    chatId: number,
    userId?: number,
    messageId?: number,
  ) {
    if (!this.isAdmin(userId)) {
      this.bot.sendMessage(
        chatId,
        '❌ У вас нет прав для выполнения этой команды',
      );
      return;
    }

    const text = `
🔧 ИЗМЕНЕНИЕ ACCESS KEY

Отправьте новый Access Key для Kling AI API.

⚠️ ВАЖНО:
• Убедитесь, что ключ корректный
• После изменения все новые генерации будут использовать новый ключ
• Текущие генерации могут не пострадать

Отправьте новый Access Key:
    `;

    if (messageId) {
      // Update existing message
      this.bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
      });
    } else {
      // Send new message
      this.bot.sendMessage(chatId, text);
    }

    this.userStates.set(chatId, { state: 'awaiting_access_key' });
  }

  private handleChangeSecretKey(
    chatId: number,
    userId?: number,
    messageId?: number,
  ) {
    if (!this.isAdmin(userId)) {
      this.bot.sendMessage(
        chatId,
        '❌ У вас нет прав для выполнения этой команды',
      );
      return;
    }

    const text = `
🔧 ИЗМЕНЕНИЕ SECRET KEY

Отправьте новый Secret Key для Kling AI API.

⚠️ ВАЖНО:
• Убедитесь, что ключ корректный
• После изменения все новые генерации будут использовать новый ключ
• Secret Key используется для подписи JWT токенов

Отправьте новый Secret Key:
    `;

    if (messageId) {
      // Update existing message
      this.bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
      });
    } else {
      // Send new message
      this.bot.sendMessage(chatId, text);
    }

    this.userStates.set(chatId, { state: 'awaiting_secret_key' });
  }

  private async handleNewAccessKey(chatId: number, text: string) {
    const newAccessKey = text.trim();

    if (!newAccessKey || newAccessKey.length < 10) {
      this.bot.sendMessage(
        chatId,
        '❌ Access Key слишком короткий. Введите корректный ключ.',
      );
      return;
    }

    try {
      // Update the access key (this will save to database and update KlingAiService)
      await this.updateKlingAccessKey(newAccessKey);

      const maskedKey = `${newAccessKey.substring(0, 6)}***${newAccessKey.substring(newAccessKey.length - 4)}`;

      const successText = `
✅ ACCESS KEY ОБНОВЛЕН!

🔑 Новый Access Key: \`${maskedKey}\`

Ключ успешно применен к Kling AI сервису.
Новые генерации будут использовать обновленный ключ.
      `;

      this.bot.sendMessage(chatId, successText, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '◀️ Назад к API ключам',
                callback_data: 'admin_api_keys',
              },
            ],
          ],
        },
      });

      this.userStates.delete(chatId);
      this.logger.log(`Access key updated by admin ${chatId}`);
    } catch (error) {
      this.logger.error('Error updating access key:', error);
      this.bot.sendMessage(
        chatId,
        '❌ Ошибка при обновлении ключа. Попробуйте еще раз.',
      );
    }
  }

  private async handleNewSecretKey(chatId: number, text: string) {
    const newSecretKey = text.trim();

    if (!newSecretKey || newSecretKey.length < 10) {
      this.bot.sendMessage(
        chatId,
        '❌ Secret Key слишком короткий. Введите корректный ключ.',
      );
      return;
    }

    try {
      // Update the secret key (this will save to database and update KlingAiService)
      await this.updateKlingSecretKey(newSecretKey);

      const maskedKey = `${newSecretKey.substring(0, 6)}***${newSecretKey.substring(newSecretKey.length - 4)}`;

      const successText = `
✅ SECRET KEY ОБНОВЛЕН!

🔐 Новый Secret Key: \`${maskedKey}\`

Ключ успешно применен к Kling AI сервису.
Новые генерации будут использовать обновленный ключ для JWT подписи.
      `;

      this.bot.sendMessage(chatId, successText, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '◀️ Назад к API ключам',
                callback_data: 'admin_api_keys',
              },
            ],
          ],
        },
      });

      this.userStates.delete(chatId);
      this.logger.log(`Secret key updated by admin ${chatId}`);
    } catch (error) {
      this.logger.error('Error updating secret key:', error);
      this.bot.sendMessage(
        chatId,
        '❌ Ошибка при обновлении ключа. Попробуйте еще раз.',
      );
    }
  }

  // Database methods for storing Kling AI keys

  public async updateKlingAccessKey(newAccessKey: string): Promise<void> {
    await this.klingAiService.updateAccessKey(newAccessKey);
  }

  public async updateKlingSecretKey(newSecretKey: string): Promise<void> {
    await this.klingAiService.updateSecretKey(newSecretKey);
  }

  // Database methods
  private async registerUser(user: TelegramBot.User): Promise<void> {
    try {
      const telegramId = user.id.toString();

      // Try to find existing user
      const existingUser = await this.prisma.user.findUnique({
        where: { telegramId },
      });

      if (existingUser) {
        // Update existing user's last activity and info
        await this.prisma.user.update({
          where: { telegramId },
          data: {
            username: user.username || null,
            firstName: user.first_name || null,
            lastName: user.last_name || null,
            languageCode: user.language_code || null,
            isPremium: (user as any).is_premium || false,
            lastActiveAt: new Date(),
          },
        });

        this.logger.log(
          `Updated existing user: ${telegramId} (${user.username || user.first_name})`,
        );
      } else {
        // Create new user
        await this.prisma.user.create({
          data: {
            telegramId,
            username: user.username || null,
            firstName: user.first_name || null,
            lastName: user.last_name || null,
            languageCode: user.language_code || null,
            isBot: user.is_bot || false,
            isPremium: (user as any).is_premium || false,
            userType: 'NEW_ID',
            lastActiveAt: new Date(),
          },
        });

        this.logger.log(
          `Registered new user: ${telegramId} (${user.username || user.first_name})`,
        );

        // Add to in-memory group tracking for compatibility
        this.addUserToGroup(user.id, 'new_id');
      }
    } catch (error) {
      this.logger.error('Error registering user:', error);
    }
  }

  // Ensure user exists in database
  private async ensureUserExists(chatId: number): Promise<void> {
    try {
      const existingUser = await this.prisma.user.findUnique({
        where: { telegramId: chatId.toString() },
      });

      if (!existingUser) {
        this.logger.log(`Creating user record for chatId: ${chatId}`);

        // Create a basic user record
        await this.prisma.user.create({
          data: {
            telegramId: chatId.toString(),
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

        this.logger.log(`Created user record for chatId: ${chatId}`);

        // Add to in-memory group tracking for compatibility
        this.addUserToGroup(chatId, 'new_id');
      }
    } catch (error) {
      this.logger.error(
        `Error ensuring user exists for chatId ${chatId}:`,
        error,
      );
      throw error;
    }
  }

  // Payment-related methods
  private async handleBuyPackage(
    chatId: number,
    amount: number,
    packageName: string,
  ) {
    try {
      this.logger.log(
        `User ${chatId} wants to buy package: ${packageName} for ${amount} RUB`,
      );

      // Убеждаемся, что пользователь существует в базе данных
      await this.ensureUserExists(chatId);

      // Определяем количество токенов для каждого пакета
      const packageDetails = this.getPackageDetails(amount);

      // Создаем описание для платежа
      const description = `${packageName} - ${packageDetails.videoTokens} видео-токенов + ${packageDetails.imageTokens} токенов изображений`;

      // Создаем URL для оплаты через Robokassa
      const paymentData = await this.robokassaService.createPaymentUrl({
        userId: chatId,
        amount: amount,
        description: description,
      });

      // Сохраняем информацию о платеже в базе данных
      await this.prisma.payment.create({
        data: {
          invoiceId: paymentData.invoiceId.toString(),
          userId: chatId.toString(),
          amount: amount,
          packageType: 'tokens',
          description: description,
          status: 'pending',
          videoTokensGranted: packageDetails.videoTokens,
          imageTokensGranted: packageDetails.imageTokens,
        },
      });

      const message = `
    ✅ ВЫ ВЫБРАЛИ: <b>${packageName}</b>

    ▫️ <b>Срок действия</b>: 1 месяц  
    ▫️ <b>Автопродление</b>: Да (ежемесячно) 


    💰 Сумма: ${amount} ₽
    🎬 ${packageDetails.videoTokens} Видео-токенов
    📸 ${packageDetails.imageTokens} Токенов изображений

    💳 <b>СТОИМОСТЬ ПОДПИСКИ</b>:  
    ${amount} ₽/мес  

    ⚠️ <b>ВАЖНЫЕ УСЛОВИЯ</b>:  
    1. Нажимая оплатить я даю согласие на регулярные списания, на обработку персональных данных и принимаю условия публичной оферты 
    2. Отменить можно в любой момент в разделе "Баланс"  
    3. Неиспользованные токены сгорают при обновлении периода 
      `;

      // Show payment options with both Robokassa and Telegram Stars
      const keyboard = {
        inline_keyboard: [
          [
            {
              text: `TG STARS ${amount}💫`,
              callback_data: `pay_stars:${paymentData.invoiceId}:${amount}:${packageName}`,
            },
          ],
          [
            {
              text: `💳 БАНКОВСКАЯ КАРТА • ${amount}₽`,
              url: paymentData.paymentUrl,
            },
          ],
          [
            {
              text: '📄 Оферта',
              url: 'https://teletype.in/@help_24/oferta_kling',
            },
          ],
        ],
      };

      await this.bot.sendMessage(chatId, message, {
        reply_markup: keyboard,
        parse_mode: 'HTML',
      });
    } catch (error) {
      this.logger.error('Error creating payment:', error);
      await this.bot.sendMessage(
        chatId,
        'Произошла ошибка при создании платежа. Попробуйте позже.',
      );
    }
  }

  // Handle successful native Telegram payments
  private async handleSuccessfulPayment(msg: TelegramBot.Message) {
    this.logger.log(
      `[STARS PAYMENT] Successful payment received from chat ${msg.chat.id}`,
    );

    try {
      const pay = (msg as any).successful_payment;
      if (!pay) {
        this.logger.warn(
          `[STARS PAYMENT] No successful_payment data in message`,
        );
        return;
      }

      this.logger.log(
        `[STARS PAYMENT] Payment details: ${JSON.stringify(pay, null, 2)}`,
      );

      // Payload was set as pkg_<invoiceId>
      const payload = pay.invoice_payload || '';
      const invoiceId = payload.startsWith('pkg_')
        ? payload.replace('pkg_', '')
        : undefined;

      this.logger.log(
        `[STARS PAYMENT] Extracted invoice ID: ${invoiceId} from payload: ${payload}`,
      );

      if (invoiceId) {
        const payment = await this.prisma.payment.findFirst({
          where: { invoiceId: invoiceId.toString() },
        });

        this.logger.log(
          `[STARS PAYMENT] Database payment found: ${payment ? 'Yes' : 'No'}`,
        );

        if (payment) {
          this.logger.log(
            `[STARS PAYMENT] Payment status: ${payment.status}, Amount: ${payment.amount}, User: ${payment.userId}`,
          );

          if (payment.status !== 'completed') {
            await this.prisma.payment.update({
              where: { id: payment.id },
              data: { status: 'completed' },
            });

            this.logger.log(
              `[STARS PAYMENT] Payment status updated to completed`,
            );

            const userIdNum = Number(payment.userId);
            if (!isNaN(userIdNum)) {
              const v = payment.videoTokensGranted || 0;
              const i = payment.imageTokensGranted || 0;

              this.logger.log(
                `[STARS PAYMENT] Granting tokens to user ${userIdNum}: ${v} video, ${i} image`,
              );

              await this.addTokensToUser(userIdNum, v, i);

              // Notify user
              await this.bot.sendMessage(
                userIdNum,
                `✅ Оплата подтверждена. На ваш баланс зачислены токены: 🎬 ${v} / 🖼️ ${i}`,
              );

              this.logger.log(
                `[STARS PAYMENT] ✅ User ${userIdNum} notified about successful payment`,
              );

              // Notify admins
              for (const adminId of this.adminIds) {
                try {
                  await this.bot.sendMessage(
                    adminId,
                    `✅ Платёж ${invoiceId} подтверждён (Telegram). Пользователь: ${userIdNum}`,
                  );
                } catch (err) {
                  this.logger.warn(`Could not notify admin ${adminId}:`, err);
                }
              }
            }
          }
        } else {
          // Fallback: create a payment record if not found
          await this.prisma.payment.create({
            data: {
              invoiceId: invoiceId,
              userId: msg.from?.id.toString() || 'unknown',
              amount: Number(pay.total_amount) / 100,
              packageType: 'tokens',
              description: pay.title || 'Telegram payment',
              status: 'completed',
            },
          });

          await this.bot.sendMessage(
            msg.chat.id,
            '✅ Оплата принята. Спасибо!',
          );
        }
      } else {
        await this.bot.sendMessage(msg.chat.id, '✅ Оплата принята. Спасибо!');
      }
    } catch (error) {
      this.logger.error('Error handling successful payment message:', error);
    }
  }

  private getPackageDetails(amount: number): {
    videoTokens: number;
    imageTokens: number;
  } {
    switch (amount) {
      case 1200:
        return { videoTokens: 25, imageTokens: 100 };
      case 2230:
        return { videoTokens: 50, imageTokens: 100 };
      case 4320:
        return { videoTokens: 100, imageTokens: 200 };
      case 2000:
        return { videoTokens: 100, imageTokens: 200 };
      default:
        return { videoTokens: 1, imageTokens: 3 };
    }
  }

  // Public method to send messages from payment controller (updated to be public)
  public async sendMessage(chatId: number, text: string, options?: any) {
    try {
      return await this.bot.sendMessage(chatId, text, options);
    } catch (error) {
      this.logger.error('Error sending message:', error);
      throw error;
    }
  }
}
