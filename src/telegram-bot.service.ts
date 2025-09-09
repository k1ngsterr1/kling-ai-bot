import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import TelegramBot = require('node-telegram-bot-api');
import axios from 'axios';
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
  private readonly enableImageToImage = true; // Re-enable with improved base64 handling

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

  // Активные задачи на проверку изображений
  private activeImageChecks: Map<
    string,
    {
      chatId: number;
      imageId: string;
      progressMessageId: number;
      intervalId: NodeJS.Timeout;
      attempts: number;
      startTime: Date;
    }
  > = new Map();

  // Media group handling for multiple photos
  private mediaGroups: Map<
    string,
    {
      messages: TelegramBot.Message[];
      timer: NodeJS.Timeout;
    }
  > = new Map();

  constructor(
    private configService: ConfigService,
    private klingAiService: KlingAiService,
    private prisma: PrismaService,
    private robokassaService: RobokassaService,
  ) {
    console.log('🔍 Debug: Checking environment variables...');
    console.log('🔍 NODE_ENV:', process.env.NODE_ENV);
    console.log('🔍 Current working directory:', process.cwd());
    console.log(
      '🔍 TELEGRAM_BOT_TOKEN from process.env:',
      process.env.TELEGRAM_BOT_TOKEN ? 'EXISTS' : 'MISSING',
    );
    console.log(
      '🔍 All env vars:',
      Object.keys(process.env).filter((key) => key.includes('TELEGRAM')),
    );

    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    console.log('🔍 Token from ConfigService:', token ? 'EXISTS' : 'MISSING');

    if (!token) {
      console.error('❌ TELEGRAM_BOT_TOKEN is not defined in ConfigService');
      console.error(
        '❌ Process env keys containing TELEGRAM:',
        Object.keys(process.env).filter((key) => key.includes('TELEGRAM')),
      );
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

    // Очищаем активные проверки изображений при старте
    this.stopAllImageChecks();
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

    // Admin only command for adding new API key pair
    this.bot.onText(/\/add_api_key/, (msg) => {
      const chatId = msg.chat.id;
      this.handleAddApiKeyCommand(chatId, msg.from?.id, msg.text);
    });

    // Handle get image command with ID parameter
    this.bot.onText(/\/getimg (.+)/, (msg, match) => {
      const chatId = msg.chat.id;
      const taskId = match ? match[1].trim() : '';

      if (!taskId) {
        this.bot.sendMessage(
          chatId,
          `❌ Укажите ID задачи

Использование: /getimg [ID]
Пример: /getimg 789627571846647814

💡 ID задачи вы получили при создании изображения.`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🖼 Создать новое изображение',
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

      this.handleFetchImageCommand(chatId, taskId);
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
      this.handlePhotoWithMediaGroup(msg);
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
🌟 Вы используете Kling 2.1 
📝 Опишите видео максимально подробно + можно добавить до 2 фото:

✨ Примеры удачных промптов:
• «Робот-шеф готовит пиццу на Марсе, 8К детализация»
• «Золотой дракон над средневековым замком» + фото Эйфелевой башни

🖼️ Как использовать изображения (до 2 шт):
📸 **1 фото** = Начальный кадр видео
📸 **2 фото** = Начальный кадр + Конечный кадр
   ↳ Видео плавно переходит от первого ко второму изображению

💡 **Режимы работы:**
• **Standard/Pro:** Фото задают общий стиль и атмосферу
• **Master:** Точное управление начальным и конечным кадрами

⚠️ Важно: 
- Длина промпта: до 300 символов
- Изображения: JPG/PNG (до 10MB, мин. 300x300px)
- Соотношение сторон: от 1:2.5 до 2.5:1
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
🎨 СОЗДАНИЕ ИЗОБРАЖЕНИЙ
Доступные генерации:

[🚀 ТЕКСТ → ШЕДЕВР]  
Создание по описанию (Kling V2.1)  
▸ Пример: "Космический корабль в стиле киберпанк, 4К"  
▸ Стоимость: 1 токен  
▸ Результат: 1 уникальное изображение  

[✨ Изображение → ТРАНСФОРМАЦИЯ]  
Преобразование изображения (V2.0)  
▸ Пример: Ваше фото + "В стиле Пикассо"  
▸ Стоимость: 1 токен  
▸ Результат: 1 стилизованное изображение

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
      const subscriptionType = user?.subscriptionType;
      const lastPaymentMethod = user?.lastPaymentMethod;
      const lastPaymentDate = user?.lastPaymentDate;

      // 🔥 СПЕЦИАЛЬНОЕ ОТОБРАЖЕНИЕ ДЛЯ БЕЗЛИМИТНОГО ПОЛЬЗОВАТЕЛЯ
      if (chatId === 205204465 || chatId === 975314612) {
        const balanceText = `
👑 ВАШ СТАТУС: БЕЗЛИМИТНЫЙ ДОСТУП

🎬 Видео-токены: ∞ (неограниченно)
📸 Токены изображений: ∞ (неограниченно)

✅ Статус: 👑 АДМИН С БЕЗЛИМИТНЫМ ДОСТУПОМ
🔥 Все функции доступны без ограничений!

💎 У вас есть полный доступ ко всем возможностям бота:
• Неограниченная генерация видео
• Неограниченная генерация изображений  
• Все качества доступны (Standard/Pro/Master)
• Приоритетная обработка запросов

🚀 Наслаждайтесь безлимитными возможностями!
        `;

        const keyboard = {
          inline_keyboard: [
            [{ text: '🎬 Создать видео', callback_data: 'video' }],
            [{ text: '🖼 Создать изображение', callback_data: 'image' }],
            [{ text: '🏠 Главное меню', callback_data: 'main' }],
          ],
        };

        await this.bot.sendMessage(chatId, balanceText, {
          reply_markup: keyboard,
        });
        return;
      }

      let subscriptionStatus = '⚠️ Подписка не активна';
      let subscriptionDetails = '';

      if (
        isSubscribed &&
        subscriptionExpiry &&
        subscriptionExpiry > new Date()
      ) {
        const expiryDate = subscriptionExpiry.toLocaleDateString('ru-RU');
        subscriptionStatus = `✅ Подписка активна до ${expiryDate}`;

        if (subscriptionType) {
          subscriptionDetails = `\n🔄 Тип: ${subscriptionType}`;
        }

        if (lastPaymentMethod) {
          subscriptionDetails += `\n💳 Способ: ${lastPaymentMethod === 'robokassa' ? 'Банковская карта (Robokassa)' : 'Telegram Stars'}`;
        }

        if (lastPaymentDate) {
          const paymentDate = lastPaymentDate.toLocaleDateString('ru-RU');
          subscriptionDetails += `\n📅 Последний платеж: ${paymentDate}`;
        }

        // Показываем информацию о возобновлении
        if (lastPaymentMethod === 'robokassa') {
          subscriptionDetails +=
            '\n\n🔄 Подписка продлевается автоматически каждый месяц через Robokassa';
        } else {
          subscriptionDetails +=
            '\n\n💫 Токены получены через Telegram Stars (единоразово)';
        }
      } else if (subscriptionExpiry && subscriptionExpiry <= new Date()) {
        const expiredDate = subscriptionExpiry.toLocaleDateString('ru-RU');
        subscriptionStatus = `⏰ Подписка истекла ${expiredDate}`;

        if (lastPaymentMethod === 'robokassa') {
          subscriptionDetails =
            '\n\n💡 Для возобновления подписки используйте /buy';
        }
      }

      const balanceText = `
💎 ВАШ ТЕКУЩИЙ БАЛАНС

🎬 Видео-токены: ${videoTokens}
📸 Токены изображений: ${imageTokens}

${subscriptionStatus}${subscriptionDetails}

🔥 ВЫГОДНЫЕ ПОДПИСКИ (ежемесячное автопополнение)

[🔹 СТАРТ] 25 видео + 100 изо · 1200 ₽/мес
▸ Базовый пакет · идеален для тестирования
▸ Автопродление · отмена в любой момент

[🔹 ПРОДВИНУТЫЙ] 50 видео + 100 изо · 2230 ₽/мес
▸ <s>2400₽</s> · экономия 170₽ (7%)
▸ Самый популярный вариант

[🔹 ПРОФИ] 100 видео + 200 изо · 4320 ₽/мес
▸ <s>4800₽</s> · экономия 480₽ (10%)
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
        parse_mode: 'HTML',
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
      this.handleStarsPurchase(chatId, packageName, price);
      return;
    }

    if (data && data.startsWith('buy_card_')) {
      const parts = data.split('_');
      const packageName = parts.slice(2, -1).join(' '); // Extract package name
      const price = parseInt(parts[parts.length - 1]); // Extract price
      this.handleCardPurchase(chatId, packageName, price);
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
      case 'buy_tokens':
        this.showTariffPlans(chatId);
        break;
      case 'tariff_basic':
        this.handleTariffPurchase(chatId, 'basic', false);
        break;
      case 'tariff_premium':
        this.handleTariffPurchase(chatId, 'premium', false);
        break;
      case 'tariff_unlimited':
        this.handleTariffPurchase(chatId, 'unlimited', false);
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
      case 'admin_create_new_pair':
        this.handleCreateNewApiKeyPair(
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
      case 'image_ratio_4:3':
        this.handleImageAspectRatioChoice(chatId, '4:3');
        break;
      case 'image_ratio_3:4':
        this.handleImageAspectRatioChoice(chatId, '3:4');
        break;
      case 'image_ratio_3:2':
        this.handleImageAspectRatioChoice(chatId, '3:2');
        break;
      case 'image_ratio_2:3':
        this.handleImageAspectRatioChoice(chatId, '2:3');
        break;
      case 'image_ratio_21:9':
        this.handleImageAspectRatioChoice(chatId, '21:9');
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
      case 'purchase_start':
        this.handleSubscriptionPurchase(
          chatId,
          'start',
          callbackQuery.from?.id,
        );
        break;
      case 'purchase_advanced':
        this.handleSubscriptionPurchase(
          chatId,
          'advanced',
          callbackQuery.from?.id,
        );
        break;
      case 'purchase_pro':
        this.handleSubscriptionPurchase(chatId, 'pro', callbackQuery.from?.id);
        break;
      case 'confirm_cancel_subscription':
        this.handleConfirmCancelSubscription(chatId, callbackQuery.from?.id);
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

⚡ STANDARD (Kling V1 + STD режим)
└ Скорость: Быстрая (2-4 мин)
└ Детализация: Базовая
└ Режим: Standard (экономичный)
└ Стоимость: 1 токен за 5s

🎓 PRO (Kling V2 Master + PRO режим)
└ Скорость: Средняя (4-8 мин)
└ Детализация: Высокая
└ Модель: Kling V2 Master
└ Режим: Professional (высокое качество)
└ Стоимость: 2 токена за 5s 

💎 MASTER (Kling V2.1 Master + PRO режим)
└ Скорость: Приоритетная (1-3 мин)
└ Детализация: Кинематографичная 4k HDR
└ Модель: Kling V2.1 Master (новейшая)
└ Режим: Professional (максимальное качество)
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
    const userState = this.userStates.get(chatId);
    const quality = userState?.data?.quality || 'standard';

    // Рассчитываем стоимость для показа пользователю
    let cost5s, cost10s;
    if (quality === 'standard') {
      cost5s = 1;
      cost10s = 2;
    } else if (quality === 'pro') {
      cost5s = 2;
      cost10s = 4;
    } else {
      // master
      cost5s = 4;
      cost10s = 8;
    }

    const durationText = `
⏱️ Выберите длительность видео:

▫️ 5 СЕКУНД: ${cost5s} ${cost5s === 1 ? 'токен' : cost5s < 5 ? 'токена' : 'токенов'}
   └ Идеально для TikTok/Reels/Shorts

▫️ 10 СЕКУНД: ${cost10s} ${cost10s < 5 ? 'токена' : 'токенов'}
   └ Полноценная сцена с развитием

👇 Выберите вариант:
    `;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: `[5 секунд - ${cost5s} ${cost5s === 1 ? 'токен' : cost5s < 5 ? 'токена' : 'токенов'}]`,
            callback_data: 'duration_5',
          },
        ],
        [
          {
            text: `[10 секунд - ${cost10s} ${cost10s < 5 ? 'токена' : 'токенов'}]`,
            callback_data: 'duration_10',
          },
        ],
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
        [{ text: '[1:1 🔲]', callback_data: 'aspect_1_1' }],
        [{ text: '[9:16 📱]', callback_data: 'aspect_9_16' }],
        [{ text: '[16:9 📺]', callback_data: 'aspect_16_9' }],
        [{ text: '[Назад]', callback_data: 'change_duration' }],
      ],
    };

    this.bot.sendMessage(chatId, aspectRatioText, { reply_markup: keyboard });
  }

  private async handleAspectRatioChoice(chatId: number, aspectRatio: string) {
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

    // Рассчитываем стоимость на основе качества и длительности
    let totalCost;
    if (quality === 'standard') {
      totalCost = duration === 5 ? 1 : 2; // Standard: 1 токен за 5с, 2 токена за 10с
    } else if (quality === 'pro') {
      totalCost = duration === 5 ? 2 : 4; // Pro: 2 токена за 5с, 4 токена за 10с
    } else {
      // master
      totalCost = duration === 5 ? 4 : 8; // Master: 4 токена за 5с, 8 токенов за 10с
    }

    // Получаем реальный баланс пользователя
    let currentBalance = 0;
    try {
      // 🔥 СПЕЦИАЛЬНАЯ ОБРАБОТКА ДЛЯ БЕЗЛИМИТНОГО ПОЛЬЗОВАТЕЛЯ
      if (chatId === 205204465 || chatId === 975314612) {
        currentBalance = 999999; // Показываем безлимит как большое число
      } else {
        await this.ensureUserExists(chatId);
        const user = await this.prisma.user.findFirst({
          where: { telegramId: chatId.toString() },
        });
        currentBalance = user?.videoTokens || 0;
      }
    } catch (error) {
      this.logger.error('Error getting user balance:', error);
      currentBalance = 0;
    }

    const balanceText =
      chatId === 205204465 || chatId === 975314612
        ? '∞ (безлимитный доступ)'
        : `${currentBalance} токенов`;

    const confirmationText = `
✅ Ваш заказ:
Модель: V2.1 ${qualityNames[quality]}
Длительность: ${duration}s
Промпт: "${prompt}"
Стоимость: ${totalCost} токенов
Текущий баланс: ${balanceText}

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

  /**
   * Проверяет баланс пользователя и активность подписки перед генерацией
   */
  private async checkUserBalance(
    userId: number,
    requiredTokens: number,
    tokenType: 'video' | 'image',
  ): Promise<{
    hasBalance: boolean;
    currentBalance: number;
    message?: string;
  }> {
    try {
      // 🔥 БЕЗЛИМИТНЫЙ ДОСТУП для пользователя 205204465
      if (userId === 205204465 || userId === 975314612) {
        this.logger.log(
          `👑 Безлимитный доступ предоставлен пользователю ${userId} для ${tokenType}`,
        );
        return {
          hasBalance: true,
          currentBalance: 999999, // Показываем большой баланс
          message: '👑 У вас безлимитный доступ!',
        };
      }

      // Получаем пользователя из базы данных
      const user = await this.prisma.user.findUnique({
        where: { telegramId: userId.toString() },
      });

      if (!user) {
        return {
          hasBalance: false,
          currentBalance: 0,
          message: 'Пользователь не найден в базе данных',
        };
      }

      // Проверяем подписку (если есть)
      const now = new Date();
      const hasActiveSubscription =
        user.isSubscribed &&
        user.subscriptionExpiry &&
        user.subscriptionExpiry > now;

      let currentBalance =
        tokenType === 'video' ? user.videoTokens : user.imageTokens;

      // Если подписка истекла, уведомляем пользователя
      if (
        user.isSubscribed &&
        user.subscriptionExpiry &&
        user.subscriptionExpiry <= now
      ) {
        // Подписка истекла - деактивируем
        await this.prisma.user.update({
          where: { telegramId: userId.toString() },
          data: {
            isSubscribed: false,
            subscriptionType: null,
          },
        });

        const expiredDate = user.subscriptionExpiry.toLocaleDateString('ru-RU');
        return {
          hasBalance: false,
          currentBalance,
          message: `⏰ Ваша подписка истекла ${expiredDate}

💰 Текущий баланс: ${currentBalance} токенов для ${tokenType === 'video' ? 'видео' : 'изображений'}
🔄 Требуется: ${requiredTokens} токенов

Для продления подписки или покупки токенов используйте /buy`,
        };
      }

      if (currentBalance < requiredTokens) {
        const tokenName = tokenType === 'video' ? 'видео' : 'изображений';
        let message = `❌ Недостаточно токенов для генерации!

💰 Требуется: ${requiredTokens} токенов для ${tokenName}
🏦 У вас: ${currentBalance} токенов`;

        if (hasActiveSubscription) {
          const expiryDate =
            user.subscriptionExpiry!.toLocaleDateString('ru-RU');
          message += `

📅 Активная подписка до: ${expiryDate}
🔄 Тип: ${user.subscriptionType}`;
        }

        message += `

Для покупки токенов используйте /buy`;

        return {
          hasBalance: false,
          currentBalance,
          message,
        };
      }

      return {
        hasBalance: true,
        currentBalance,
      };
    } catch (error) {
      this.logger.error('Error checking user balance:', error);
      return {
        hasBalance: false,
        currentBalance: 0,
        message: 'Ошибка проверки баланса. Попробуйте позже.',
      };
    }
  }

  /**
   * Списывает токены у пользователя
   */
  private async deductTokens(
    userId: number,
    tokens: number,
    tokenType: 'video' | 'image',
  ): Promise<boolean> {
    try {
      // 🔥 БЕЗЛИМИТНЫЙ ДОСТУП для пользователя 205204465 - НЕ СПИСЫВАЕМ ТОКЕНЫ
      if (userId === 205204465) {
        this.logger.log(
          `👑 Безлимитный пользователь ${userId} - токены НЕ списываются (${tokens} ${tokenType})`,
        );
        return true; // Возвращаем успех, но токены не списываем
      }

      const updateData =
        tokenType === 'video'
          ? { videoTokens: { decrement: tokens } }
          : { imageTokens: { decrement: tokens } };

      await this.prisma.user.update({
        where: { telegramId: userId.toString() },
        data: updateData,
      });

      this.logger.log(
        `Deducted ${tokens} ${tokenType} tokens from user ${userId}`,
      );
      return true;
    } catch (error) {
      this.logger.error('Error deducting tokens:', error);
      return false;
    }
  }

  /**
   * Обрабатывает покупку тарифа
   */
  private async handleTariffPurchase(
    chatId: number,
    tariffType: 'basic' | 'premium' | 'unlimited',
    recurring: boolean,
  ) {
    try {
      this.logger.log(
        `Creating tariff payment: ${tariffType}, recurring: ${recurring}, user: ${chatId}`,
      );

      // Отправляем запрос на создание платежа
      const response = await fetch(
        'http://localhost:3000/payment/create-tariff',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            userId: chatId,
            tariffType: tariffType,
            recurring: recurring,
          }),
        },
      );

      const result = await response.json();

      if (result.success) {
        const tariffNames = {
          basic: 'БАЗОВЫЙ',
          premium: 'ПРЕМИУМ',
          unlimited: 'БЕЗЛИМИТНЫЙ',
        };

        const text = `
💳 **Оплата тарифа ${tariffNames[tariffType]}**

💰 Сумма: ${result.amount}₽
📦 Включено:
   • ${result.tariff.videoTokens} видео токенов
   • ${result.tariff.imageTokens} токенов изображений
   ${recurring ? '• 🔄 Автоматическое продление каждый месяц' : '• 📅 Разовая покупка на месяц'}

🔗 Для оплаты перейдите по ссылке ниже:
        `;

        const keyboard = {
          inline_keyboard: [
            [
              {
                text: '💳 Оплатить',
                url: result.paymentUrl,
              },
            ],
            [{ text: '🔙 Назад к тарифам', callback_data: 'buy_tokens' }],
            [{ text: '🏠 Главное меню', callback_data: 'main' }],
          ],
        };

        this.bot.sendMessage(chatId, text, {
          reply_markup: keyboard,
          parse_mode: 'Markdown',
        });

        this.logger.log(
          `Payment URL created for user ${chatId}: ${result.paymentUrl}`,
        );
      } else {
        this.bot.sendMessage(
          chatId,
          `❌ Ошибка создания платежа: ${result.error}`,
        );
      }
    } catch (error) {
      this.logger.error('Error creating tariff payment:', error);
      this.bot.sendMessage(
        chatId,
        '❌ Произошла ошибка при создании платежа. Попробуйте позже.',
      );
    }
  }

  /**
   * Показывает тарифные планы для покупки
   */
  private async showTariffPlans(chatId: number) {
    const text = `
🔥 ВЫГОДНЫЕ ПОДПИСКИ (ежемесячное автопополнение)

[🔹 СТАРТ] 25 видео + 100 изо · 1200 ₽/мес
▸ Базовый пакет · идеален для тестирования
▸ Автопродление · отмена в любой момент

[🔹 ПРОДВИНУТЫЙ] 50 видео + 100 изо · 2230 ₽/мес
▸ <s>2400₽</s> · экономия 170₽ (7%)
▸ Самый популярный вариант

[🔹 ПРОФИ] 100 видео + 200 изо · 4320 ₽/мес
▸ <s>4800₽</s> · экономия 480₽ (10%)
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

    this.bot.sendMessage(chatId, text, {
      reply_markup: keyboard,
      parse_mode: 'HTML',
    });
  }

  private async handleImageAspectRatioChoice(
    chatId: number,
    aspectRatio: string,
  ) {
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
      '1:1': '🔲 1:1 (квадрат)',
      '9:16': '📱 9:16 (вертикальное)',
      '16:9': '🖥️ 16:9 (горизонтальное)',
      '4:3': '📋 4:3 (стандарт)',
      '3:4': '📋 3:4 (портрет)',
      '3:2': '🖼️ 3:2 (фото)',
      '2:3': '🖼️ 2:3 (портрет фото)',
      '21:9': '🎬 21:9 (ультраширокий)',
    };

    // Получаем реальный баланс пользователя для изображений
    let currentBalance = 0;
    try {
      // 🔥 СПЕЦИАЛЬНАЯ ОБРАБОТКА ДЛЯ БЕЗЛИМИТНОГО ПОЛЬЗОВАТЕЛЯ
      if (chatId === 205204465 || chatId === 975314612) {
        currentBalance = 999999; // Показываем безлимит как большое число
      } else {
        await this.ensureUserExists(chatId);
        const user = await this.prisma.user.findFirst({
          where: { telegramId: chatId.toString() },
        });
        currentBalance = user?.imageTokens || 0;
      }
    } catch (error) {
      this.logger.error('Error getting user image balance:', error);
      currentBalance = 0;
    }

    const balanceText =
      chatId === 205204465 || chatId === 975314612
        ? '∞ (безлимитный доступ)'
        : `${currentBalance} токенов`;

    const confirmationText = `
✅ Ваш заказ на изображение:
Промпт: "${prompt}"
Формат: ${aspectRatioNames[aspectRatio]}
Стоимость: 1 токен
Текущий баланс: ${balanceText}
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

    const { prompt, aspectRatio, referencePhoto } = userState.data;

    // 🔍 Логирование начала генерации
    this.logger.log(`🎨 === IMAGE GENERATION START ===`);
    this.logger.log(`👤 User: ${chatId}`);
    this.logger.log(`📝 Prompt: "${prompt}"`);
    this.logger.log(`📐 Aspect: ${aspectRatio}`);
    this.logger.log(`📸 Has ref photo: ${!!referencePhoto}`);
    this.logger.log(`⚙️ Image-to-image enabled: ${this.enableImageToImage}`);

    // Проверяем баланс пользователя (1 токен за изображение)
    const balanceCheck = await this.checkUserBalance(chatId, 1, 'image');

    if (!balanceCheck.hasBalance) {
      const keyboard = {
        inline_keyboard: [
          [{ text: '💰 Купить токены', callback_data: 'buy_tokens' }],
          [{ text: '🏠 Главное меню', callback_data: 'main' }],
        ],
      };

      this.bot.sendMessage(
        chatId,
        balanceCheck.message || 'Недостаточно токенов',
        { reply_markup: keyboard },
      );
      return;
    }

    this.logger.log(
      `Generating image with prompt: "${prompt}" and aspectRatio: ${aspectRatio}`,
    );

    try {
      // Списываем токены перед генерацией
      const tokensDeducted = await this.deductTokens(chatId, 1, 'image');
      if (!tokensDeducted) {
        this.bot.sendMessage(
          chatId,
          '❌ Ошибка списания токенов. Попробуйте позже.',
        );
        return;
      }

      // Create Kling AI request for image
      const klingRequest: KlingImageRequest = {
        prompt,
        aspectRatio: aspectRatio as
          | '1:1'
          | '9:16'
          | '16:9'
          | '4:3'
          | '3:4'
          | '3:2'
          | '2:3'
          | '21:9',
        numberOfImages: 1,
      };

      this.logger.log(`🔧 Initial request created`);

      // Set resolution based on whether we have a reference image
      if (referencePhoto && this.enableImageToImage) {
        this.logger.log(
          `📷 Processing reference image (file_id: ${referencePhoto.file_id})`,
        );

        // For image-to-image generation, use 1k resolution
        klingRequest.resolution = '1k';
        this.logger.log(`🔧 Set resolution: 1k (image-to-image)`);

        try {
          this.logger.log(`🔄 Converting Telegram image to base64...`);
          // Convert Telegram file to base64 for Kling AI
          const base64Image = await this.convertTelegramImageToBase64(
            referencePhoto.file_id,
          );
          this.logger.log(
            `✅ Base64 conversion successful (length: ${base64Image.length} chars)`,
          );

          klingRequest.images = [base64Image];
          klingRequest.modelName = 'kling-v1-5'; // Use v1.5 for image-to-image
          klingRequest.imageReference = 'subject'; // Use subject reference by default
          klingRequest.imageFidelity = 0.7; // Medium-high fidelity

          this.logger.log(`🛠️ Image-to-image parameters set:`);
          this.logger.log(`   - modelName: ${klingRequest.modelName}`);
          this.logger.log(
            `   - imageReference: ${klingRequest.imageReference}`,
          );
          this.logger.log(`   - imageFidelity: ${klingRequest.imageFidelity}`);
          this.logger.log(
            `   - images array length: ${klingRequest.images.length}`,
          );

          this.logger.log(
            '🖼️ Using reference image with 1k resolution (base64 converted)',
          );
        } catch (error) {
          this.logger.error(
            '❌ Error converting reference image to base64:',
            error,
          );
          this.logger.error(`   Error type: ${error.constructor.name}`);
          this.logger.error(`   Error message: ${error.message}`);

          // Try without reference image
          this.logger.warn(
            '🔄 Falling back to text-to-image generation without reference',
          );
          klingRequest.resolution = '2k';
          this.logger.log(`🔧 Changed resolution to: 2k (fallback mode)`);

          // Ensure all image-related fields are removed
          if (klingRequest.images) delete klingRequest.images;
          if (klingRequest.modelName) delete klingRequest.modelName;
          if (klingRequest.imageReference) delete klingRequest.imageReference;
          if (klingRequest.imageFidelity) delete klingRequest.imageFidelity;
          if (klingRequest.humanFidelity) delete klingRequest.humanFidelity;

          this.logger.log(`🧹 Cleaned up image-to-image parameters`);
        }
      } else {
        // For text-to-image generation, use 2k resolution
        klingRequest.resolution = '2k';
        this.logger.log(`🔧 Set resolution: 2k (text-to-image)`);

        if (referencePhoto && !this.enableImageToImage) {
          this.logger.warn(
            '🚫 Image-to-image is temporarily disabled, using text-to-image instead',
          );
        }
      }

      // Debug logging before sending to Kling AI
      this.logger.log(`📋 Final request config:`);
      this.logger.log(`   - Prompt: "${klingRequest.prompt}"`);
      this.logger.log(`   - Resolution: ${klingRequest.resolution}`);
      this.logger.log(`   - Aspect ratio: ${klingRequest.aspectRatio}`);
      this.logger.log(`   - Number of images: ${klingRequest.numberOfImages}`);
      this.logger.log(`   - Model: ${klingRequest.modelName || 'default'}`);
      this.logger.log(`   - Has images: ${!!klingRequest.images}`);
      this.logger.log(
        `   - Image reference: ${klingRequest.imageReference || 'N/A'}`,
      );
      this.logger.log(
        `   - Image fidelity: ${klingRequest.imageFidelity || 'N/A'}`,
      );
      this.logger.log(`📤 Sending request to Kling AI...`);
      this.logger.log(
        `  - Image reference: ${klingRequest.imageReference || 'none'}`,
      );

      this.logger.log(`📤 Sending request to Kling AI...`);

      // Start generation with Kling AI
      const generationResult =
        await this.klingAiService.generateImage(klingRequest);

      this.logger.log(`📥 Received response from Kling AI:`);
      this.logger.log(`   - Status: ${generationResult.status}`);
      this.logger.log(`   - ID: ${generationResult.id}`);
      this.logger.log(`   - Response type: ${typeof generationResult}`);
      this.logger.log(
        `   - Response keys: ${Object.keys(generationResult).join(', ')}`,
      );

      if (generationResult.status === 'pending') {
        this.logger.log(`✅ Image generation started successfully`);

        // Send initial progress message
        const isUsingReference =
          referencePhoto && this.enableImageToImage && klingRequest.images;
        const hasReference = isUsingReference
          ? '📷 С референсным изображением'
          : referencePhoto && !this.enableImageToImage
            ? '🆕 Новое изображение (ref. изображение временно отключено)'
            : '🆕 Новое изображение';
        const resolutionText = klingRequest.resolution === '1k' ? '1K' : '2K';
        const initialText = `
⏳ Генерация изображения началась!
${hasReference} (${resolutionText})
Примерное время: 1-2 мин
ID: ${generationResult.id}

💰 Списан 1 токен
🏦 Остаток: ${balanceCheck.currentBalance - 1} токенов

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

        // Start polling for completion and send image automatically when ready
        this.pollImageGeneration(
          chatId,
          generationResult.id,
          progressMessage.message_id,
        );
      } else {
        this.logger.error(`❌ Image generation failed to start:`);
        this.logger.error(`   - Status: ${generationResult.status}`);
        this.logger.error(
          `   - Full response: ${JSON.stringify(generationResult)}`,
        );

        // Если генерация не запустилась, возвращаем токены
        await this.prisma.user.update({
          where: { telegramId: chatId.toString() },
          data: { imageTokens: { increment: 1 } },
        });

        this.logger.log(`💰 Token refunded to user ${chatId}`);

        this.bot.sendMessage(
          chatId,
          '❌ Ошибка при запуске генерации. Токен возвращен. Попробуйте еще раз.',
        );
      }

      // Clear user state
      this.userStates.delete(chatId);
      this.logger.log(`🧹 Cleared user state for ${chatId}`);
    } catch (error) {
      this.logger.error(
        '❌ Critical error in handleImageGenerationConfirmation:',
        error,
      );
      this.logger.error(`   Error type: ${error.constructor.name}`);
      this.logger.error(`   Error message: ${error.message}`);
      this.logger.error(`   Error stack: ${error.stack}`);

      if (error.response) {
        this.logger.error(`   HTTP Response status: ${error.response.status}`);
        this.logger.error(
          `   HTTP Response data: ${JSON.stringify(error.response.data)}`,
        );
      }

      // Return tokens on error
      try {
        await this.prisma.user.update({
          where: { telegramId: chatId.toString() },
          data: { imageTokens: { increment: 1 } },
        });
      } catch (dbError) {
        this.logger.error('Error returning tokens:', dbError);
      }

      // Check if error is related to API keys
      if (error.message?.includes('API keys not configured')) {
        this.bot.sendMessage(
          chatId,
          '❌ API ключи Kling AI не настроены!\n\nТокен возвращен на ваш баланс.\n\nОбратитесь к администратору для настройки ключей через /admin',
        );
      } else if (error.message?.includes('Failed to process reference image')) {
        this.bot.sendMessage(
          chatId,
          '❌ Ошибка обработки референсного изображения.\n\n💡 Попробуйте:\n• Отправить изображение в формате JPG/PNG\n• Уменьшить размер файла\n• Использовать другое изображение\n\n🔄 Токен возвращен на ваш баланс',
        );
      } else {
        this.bot.sendMessage(
          chatId,
          '❌ Произошла ошибка при генерации изображения.\n\n🔄 Токен возвращен на ваш баланс.\nПопробуйте позже.',
        );
      }

      // Clear user state
      this.userStates.delete(chatId);
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

    // Рассчитываем стоимость генерации на основе качества и длительности
    let totalCost;
    if (quality === 'standard') {
      totalCost = duration === 5 ? 1 : 2; // Standard: 1 токен за 5с, 2 токена за 10с
    } else if (quality === 'pro') {
      totalCost = duration === 5 ? 2 : 4; // Pro: 2 токена за 5с, 4 токена за 10с
    } else {
      // master
      totalCost = duration === 5 ? 4 : 8; // Master: 4 токена за 5с, 8 токенов за 10с
    }

    // Проверяем баланс пользователя перед генерацией
    const balanceCheck = await this.checkUserBalance(
      chatId,
      totalCost,
      'video',
    );

    if (!balanceCheck.hasBalance) {
      const keyboard = {
        inline_keyboard: [
          [{ text: '💰 Купить токены', callback_data: 'buy_tokens' }],
          [{ text: '🏠 Главное меню', callback_data: 'main' }],
        ],
      };

      this.bot.sendMessage(
        chatId,
        balanceCheck.message || 'Недостаточно токенов',
        { reply_markup: keyboard },
      );
      return;
    }

    try {
      // Списываем токены перед генерацией
      const tokensDeducted = await this.deductTokens(
        chatId,
        totalCost,
        'video',
      );
      if (!tokensDeducted) {
        this.bot.sendMessage(
          chatId,
          '❌ Ошибка списания токенов. Попробуйте позже.',
        );
        return;
      }

      // Create Kling AI request
      const klingRequest: KlingVideoRequest = {
        prompt,
        quality: quality as 'standard' | 'pro' | 'master',
        duration: duration as 5 | 10,
        aspectRatio: aspectRatio as '1:1' | '9:16' | '16:9',
      };

      // ✅ ДОБАВЛЯЕМ ВЫБОР МОДЕЛИ И РЕЖИМА НА ОСНОВЕ КАЧЕСТВА
      if (quality === 'master') {
        klingRequest.modelName = 'kling-v2-1-master';
        klingRequest.mode = 'std'; // Master использует pro режим для максимального качества
      } else if (quality === 'pro') {
        klingRequest.modelName = 'kling-v2-master';
        klingRequest.mode = 'pro'; // Pro использует pro режим для высокого качества
      } else {
        klingRequest.modelName = 'kling-v1'; // Для standard используем базовую модель
        klingRequest.mode = 'std'; // Standard использует std режим для экономичности
      }

      // Convert images to base64 if provided
      if (images && images.length > 0) {
        try {
          const base64Images = await Promise.all(
            images.map((img) => this.convertTelegramImageToBase64(img.file_id)),
          );

          // Используем новую логику с image и image_tail
          if (base64Images.length >= 1) {
            klingRequest.image = base64Images[0]; // Первое изображение - начальный кадр
            this.logger.log('🖼️ Set start frame (image) for video generation');
          }

          if (base64Images.length >= 2) {
            klingRequest.image_tail = base64Images[1]; // Второе изображение - конечный кадр
            this.logger.log(
              '🖼️ Set end frame (image_tail) for video generation',
            );
          }

          this.logger.log(
            `🖼️ Converted ${base64Images.length} images to base64 for video generation (${klingRequest.image ? 'start' : ''}${klingRequest.image && klingRequest.image_tail ? '+' : ''}${klingRequest.image_tail ? 'end' : ''} frames)`,
          );
        } catch (error) {
          this.logger.error('Error converting images to base64:', error);
          // Continue without images
          this.logger.warn(
            'Continuing video generation without reference images',
          );
        }
      }

      // Start generation with Kling AI
      const generationResult =
        await this.klingAiService.generateVideo(klingRequest);

      const estimatedMinutes = Math.ceil(
        (generationResult.estimatedTime || 180) / 60,
      );

      const generationText = `
⏳ Генерация начата!
ID: #${generationResult.id}
Модель: ${klingRequest.modelName || 'kling-v1'}
Примерное время: ${estimatedMinutes}-${estimatedMinutes + 2} мин

💰 Списано: ${totalCost} токенов
🏦 Остаток: ${balanceCheck.currentBalance - totalCost} токенов

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
        duration, // Передаём длительность видео
      );
    } catch (error) {
      this.logger.error('Error starting video generation:', error);

      // Возвращаем токены если генерация не запустилась
      await this.prisma.user.update({
        where: { telegramId: chatId.toString() },
        data: { videoTokens: { increment: totalCost } },
      });

      // Check if error is related to API keys
      if (error.message?.includes('API keys not configured')) {
        this.bot.sendMessage(
          chatId,
          '❌ API ключи Kling AI не настроены!\n\nТокены возвращены на ваш баланс.\n\nОбратитесь к администратору для настройки ключей через /admin',
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
          `❌ Ошибка при запуске генерации. Токены (${totalCost}) возвращены на ваш баланс. Попробуйте еще раз.`,
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
    videoDuration: number = 5, // Добавлена длительность видео
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
            // Send as video only - НЕ КАК ГИФКА! Используем специальный метод
            await this.sendVideoAsVideo(chatId, status.videoUrl, {
              caption: `🎉 Ваше видео готово!




Generated by @kling_tgbot`,
              reply_markup: {
                inline_keyboard: [
                  [{ text: '⬇️ Скачать', url: status.videoUrl }],
                  [{ text: '🎬 Создать еще видео', callback_data: 'video' }],
                  [{ text: '🏠 Главное меню', callback_data: 'main' }],
                ],
              },
              // Принудительно отправляем как видеофайл, а не как анимацию
              width: 1024,
              height: 1024,
              duration: videoDuration, // Используем реальную длительность видео
            });
          } catch (videoError) {
            this.logger.warn('Could not send video directly:', videoError);
            // Fallback - send text message with download link if video sending fails
            await this.bot.sendMessage(
              chatId,
              `

ID: #${videoId}
💰 Списано: ${cost} токенов
📱 Скачать: ${status.videoUrl}

            `,
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '⬇️ Скачать', url: status.videoUrl }],
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

  // Helper: fetch a Kling AI image by task id and send to chat
  private async handleFetchImageCommand(chatId: number, taskId: string) {
    try {
      const loadingMsg = await this.bot.sendMessage(
        chatId,
        `🔍 Проверяю статус задачи: ${taskId}...`,
      );

      // Пытаемся получить результат напрямую
      const result = await this.klingAiService.getImageResult(taskId);

      if (result && result.imageUrl) {
        // Изображение готово
        this.logger.log(
          `Found completed image for ${taskId}: ${result.imageUrl}`,
        );

        try {
          await this.bot.sendPhoto(chatId, result.imageUrl, {
            caption: `
Generated by @kling_tgbot`,
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
        } catch (photoError) {
          this.logger.warn(
            'Could not send photo directly, sending as text:',
            photoError,
          );
          await this.bot.sendMessage(
            chatId,
            `🎉 Изображение найдено и готово!

ID: ${taskId}
Статус: Завершено ✅
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
        }

        // Удаляем сообщение о проверке
        try {
          await this.bot.deleteMessage(chatId, loadingMsg.message_id);
        } catch (deleteError) {
          this.logger.warn('Could not delete loading message:', deleteError);
        }

        return;
      }

      // Если результата нет, проверяем статус
      try {
        const status = await this.klingAiService.getImageStatus(taskId);

        if (status.status === 'failed') {
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

          await this.bot.sendMessage(
            chatId,
            `❌ Генерация изображения не удалась

ID: ${taskId}
Статус: Ошибка ❌
Причина: ${failureReason}

💡 Советы:
• Используйте более нейтральные описания
• Избегайте упоминаний людей, брендов, насилия
• Попробуйте изменить формулировку`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔄 Попробовать снова', callback_data: 'image' }],
                  [{ text: '🏠 Главное меню', callback_data: 'main' }],
                ],
              },
            },
          );
        } else if (status.status === 'processing') {
          await this.bot.sendMessage(
            chatId,
            `⏳ Генерация изображения все еще выполняется

ID: ${taskId}
Статус: В процессе ⏳

Попробуйте проверить результат через несколько минут командой:
/getimg ${taskId}

💡 Вы можете создать новое изображение, пока ждёте это.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🔄 Проверить еще раз',
                      callback_data: `fetch_img_${taskId}`,
                    },
                  ],
                  [
                    {
                      text: '🖼 Создать новое изображение',
                      callback_data: 'image',
                    },
                  ],
                  [{ text: '🏠 Главное меню', callback_data: 'main' }],
                ],
              },
            },
          );
        } else {
          await this.bot.sendMessage(
            chatId,
            `❓ Неизвестный статус задачи

ID: ${taskId}
Статус: ${status.status}

Попробуйте проверить позже или обратитесь в поддержку.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🔄 Проверить еще раз',
                      callback_data: `fetch_img_${taskId}`,
                    },
                  ],
                  [{ text: '🏠 Главное меню', callback_data: 'main' }],
                ],
              },
            },
          );
        }
      } catch (statusError) {
        this.logger.warn(`Could not get status for ${taskId}:`, statusError);
        await this.bot.sendMessage(
          chatId,
          `❌ Не удалось проверить статус задачи

ID: ${taskId}

Возможные причины:
• Задача не найдена (неверный ID)
• Временные проблемы с сервисом
• Задача слишком старая

Попробуйте:
• Проверить правильность ID
• Повторить проверку через несколько минут
• Создать новое изображение`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🖼 Создать новое изображение',
                    callback_data: 'image',
                  },
                ],
                [{ text: '🏠 Главное меню', callback_data: 'main' }],
              ],
            },
          },
        );
      }

      // Удаляем сообщение о проверке
      try {
        await this.bot.deleteMessage(chatId, loadingMsg.message_id);
      } catch (deleteError) {
        this.logger.warn('Could not delete loading message:', deleteError);
      }
    } catch (error) {
      this.logger.error('Error in handleFetchImageCommand:', error);
      await this.bot.sendMessage(
        chatId,
        `❌ Ошибка при проверке результата

Попробуйте:
• Повторить команду через несколько минут
• Проверить правильность ID задачи
• Создать новое изображение

Если проблема продолжается - обратитесь в поддержку.`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🖼 Создать новое изображение',
                  callback_data: 'image',
                },
              ],
              [{ text: '🏠 Главное меню', callback_data: 'main' }],
            ],
          },
        },
      );
    }
  }

  private async pollImageGeneration(
    chatId: number,
    imageId: string,
    progressMessageId: number,
  ) {
    // Проверяем, не запущена ли уже проверка для этого imageId
    const existingCheck = this.activeImageChecks.get(imageId);
    if (existingCheck) {
      this.logger.warn(`Image check for ${imageId} is already running`);
      return;
    }

    const maxAttempts = 40; // Проверяем до 20 минут (40 * 30 сек)
    let attempts = 0;
    const startTime = new Date();

    // Функция проверки
    const checkImage = async () => {
      attempts++;

      try {
        this.logger.log(
          `Checking image ${imageId}, attempt ${attempts}/${maxAttempts}`,
        );

        // Пытаемся получить готовый результат напрямую (как в fetch-image-by-id.js)
        let imageResult: any = null;

        try {
          imageResult = await this.klingAiService.getImageResult(imageId);
        } catch (resultError) {
          this.logger.warn(
            `Could not get direct result for ${imageId}:`,
            resultError,
          );
        }

        // Если получили результат - отправляем пользователю и завершаем проверку
        if (imageResult && imageResult.imageUrl) {
          this.logger.log(
            `✅ Image ${imageId} is ready! URL: ${imageResult.imageUrl}`,
          );

          try {
            await this.bot.sendPhoto(chatId, imageResult.imageUrl, {
              caption: `
Generated by @kling_tgbot`,
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

            // Удаляем прогресс сообщение
            try {
              await this.bot.deleteMessage(chatId, progressMessageId);
            } catch (deleteError) {
              this.logger.warn(
                'Could not delete progress message:',
                deleteError,
              );
            }
          } catch (imageError) {
            this.logger.warn(
              'Could not send image, sending as text:',
              imageError,
            );
            await this.bot.sendMessage(
              chatId,
              `
📱 Скачать: ${imageResult.imageUrl}

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

          // ✅ ЗАВЕРШАЕМ ПРОВЕРКУ - изображение получено
          this.stopImageCheck(imageId);
          return;
        }

        // Если результата нет, проверяем статус (если доступен)
        let status: any = null;
        try {
          status = await this.klingAiService.getImageStatus(imageId);
        } catch (statusError) {
          this.logger.warn(`Could not get status for ${imageId}:`, statusError);
        }

        // Если статус показывает ошибку - завершаем с ошибкой
        if (status && status.status === 'failed') {
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

          await this.bot.sendMessage(
            chatId,
            `❌ Генерация изображения не удалась

ID: ${imageId}
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

          try {
            await this.bot.deleteMessage(chatId, progressMessageId);
          } catch (deleteError) {
            this.logger.warn('Could not delete progress message:', deleteError);
          }

          // ✅ ЗАВЕРШАЕМ ПРОВЕРКУ - получена ошибка
          this.stopImageCheck(imageId);
          return;
        }

        // Обновляем прогресс, если еще не достигли максимума попыток
        if (attempts < maxAttempts) {
          // Рассчитываем прогресс на основе времени и попыток
          const timeElapsed = Date.now() - startTime.getTime();
          const timeProgress = Math.min(
            (timeElapsed / (10 * 60 * 1000)) * 100,
            90,
          ); // 10 минут = 90%
          const attemptProgress = (attempts / maxAttempts) * 100;
          const progress = Math.min(
            Math.max(timeProgress, attemptProgress),
            95,
          );

          const progressBar = this.createProgressBar(progress);

          const updatedText = `⏳ Генерация изображения...
ID: ${imageId}
Примерное время: 1-3 мин
Текущий статус: ${progressBar} ${Math.floor(progress)}%]

🔔 Мы пришлем результат автоматически`;

          const keyboard = {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'main' }],
            ],
          };

          try {
            await this.bot.editMessageText(updatedText, {
              chat_id: chatId,
              message_id: progressMessageId,
              reply_markup: keyboard,
            });
          } catch (editError) {
            this.logger.warn('Could not update progress message:', editError);
          }
        }

        // Если достигли максимума попыток - завершаем с тайм-аутом
        if (attempts >= maxAttempts) {
          this.logger.warn(
            `Max attempts reached for ${imageId}, stopping check`,
          );

          await this.bot.sendMessage(
            chatId,
            `⏰ Превышено время ожидания

ID: ${imageId}
Генерация может все еще продолжаться.
Проверьте результат позже командой /getimg ${imageId} или создайте новое изображение.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '� Попробовать снова', callback_data: 'image' }],
                  [{ text: '🏠 Главное меню', callback_data: 'main' }],
                ],
              },
            },
          );

          try {
            await this.bot.deleteMessage(chatId, progressMessageId);
          } catch (deleteError) {
            this.logger.warn('Could not delete progress message:', deleteError);
          }

          // ✅ ЗАВЕРШАЕМ ПРОВЕРКУ - достигнут тайм-аут
          this.stopImageCheck(imageId);
          return;
        }
      } catch (error) {
        this.logger.error(
          `Error checking image ${imageId}, attempt ${attempts}:`,
          error,
        );

        if (attempts >= maxAttempts) {
          await this.bot.sendMessage(
            chatId,
            `❌ Ошибка во время генерации изображения

ID: ${imageId}
Попробуйте создать новое изображение.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔄 Попробовать снова', callback_data: 'image' }],
                  [{ text: '🏠 Главное меню', callback_data: 'main' }],
                ],
              },
            },
          );

          try {
            await this.bot.deleteMessage(chatId, progressMessageId);
          } catch (deleteError) {
            this.logger.warn('Could not delete progress message:', deleteError);
          }

          // ✅ ЗАВЕРШАЕМ ПРОВЕРКУ - критическая ошибка
          this.stopImageCheck(imageId);
          return;
        }
      }
    };

    // Создаем интервал для проверки каждые 30 секунд
    const intervalId = setInterval(checkImage, 30000);

    // Сохраняем информацию о активной проверке
    this.activeImageChecks.set(imageId, {
      chatId,
      imageId,
      progressMessageId,
      intervalId,
      attempts: 0,
      startTime,
    });

    // Запускаем первую проверку через 10 секунд
    setTimeout(checkImage, 10000);

    this.logger.log(
      `Started automatic image check for ${imageId} (chatId: ${chatId})`,
    );
  }

  // Метод для остановки проверки изображения
  private stopImageCheck(imageId: string) {
    const check = this.activeImageChecks.get(imageId);
    if (check) {
      clearInterval(check.intervalId);
      this.activeImageChecks.delete(imageId);
      this.logger.log(`Stopped image check for ${imageId}`);
    }
  }

  // Метод для очистки всех активных проверок (при перезапуске)
  private stopAllImageChecks() {
    for (const [imageId, check] of this.activeImageChecks.entries()) {
      clearInterval(check.intervalId);
    }
    this.activeImageChecks.clear();
    this.logger.log('Stopped all active image checks');
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
                  caption: `Generated by @kling_tgbot`,
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
📱 Скачать: ${result.imageUrl}

`,
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

    // Quick command: /get_image <taskId> or /getimg <taskId> - fetch image by Kling task id
    if (text.startsWith('/get_image ') || text.startsWith('/getimg ')) {
      const parts = text.split(/\s+/);
      const taskId = parts[1];
      if (!taskId) {
        this.bot.sendMessage(
          chatId,
          '❌ Укажите ID задачи. Пример: /get_image 789627571846647814',
        );
        return;
      }

      this.handleFetchImageCommand(chatId, taskId);
      return;
    }

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

      // Save the prompt and go directly to video settings
      this.userStates.set(chatId, {
        state: 'video_prompt_received',
        data: { prompt: text, images: [] },
      });

      // Go directly to video settings
      this.handleVideoSettings(chatId);
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

      // Save the prompt and show aspect ratio selection directly
      this.userStates.set(chatId, {
        state: 'image_prompt_received',
        data: { prompt: text },
      });

      const responseText = `
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

  private handlePhotoWithMediaGroup(msg: TelegramBot.Message) {
    const mediaGroupId = msg.media_group_id;

    this.logger.log(
      `📸 Received photo message. Media Group ID: ${mediaGroupId || 'none'}`,
    );

    // If no media group ID, process as single photo
    if (!mediaGroupId) {
      this.logger.log('📸 Processing as single photo (no media group)');
      this.handlePhotoMessage(msg);
      return;
    }

    this.logger.log(`📸 Processing photo in media group: ${mediaGroupId}`);

    // Get or create media group
    let mediaGroup = this.mediaGroups.get(mediaGroupId);

    if (!mediaGroup) {
      this.logger.log(`📸 Creating new media group: ${mediaGroupId}`);
      mediaGroup = {
        messages: [],
        timer: setTimeout(() => {
          // Process the grouped messages after a delay
          const group = this.mediaGroups.get(mediaGroupId);
          if (group) {
            this.logger.log(
              `📸 Processing media group ${mediaGroupId} with ${group.messages.length} photos`,
            );
            this.processMediaGroup(group.messages);
            this.mediaGroups.delete(mediaGroupId);
          }
        }, 100), // 100ms delay to collect all photos in group
      };
      this.mediaGroups.set(mediaGroupId, mediaGroup);
    }

    // Add message to group
    mediaGroup.messages.push(msg);
    this.logger.log(
      `📸 Added photo to media group ${mediaGroupId}. Total photos: ${mediaGroup.messages.length}`,
    );
  }

  private processMediaGroup(messages: TelegramBot.Message[]) {
    if (messages.length === 0) return;

    this.logger.log(`📸 Processing ${messages.length} photos from media group`);

    // Use the first message as the main message (it usually has the caption)
    const mainMessage = messages[0];
    const allPhotos = messages
      .map((msg) => msg.photo?.[msg.photo.length - 1])
      .filter(Boolean);

    this.logger.log(`📸 Caption: "${mainMessage.caption || 'none'}"`);
    this.logger.log(`📸 Photos extracted: ${allPhotos.length}`);

    // Create a combined message object with all photos
    const combinedMessage = {
      ...mainMessage,
      photoCount: allPhotos.length,
      allPhotos: allPhotos,
    };

    this.handleMultiplePhotos(combinedMessage);
  }

  private handleMultiplePhotos(msg: any) {
    const chatId = msg.chat.id;
    const userState = this.userStates.get(chatId);
    const caption = msg.caption?.trim();
    const photoCount = msg.photoCount || 1;
    const allPhotos = msg.allPhotos || [msg.photo?.[msg.photo.length - 1]];

    this.logger.log(`📸 Handling ${photoCount} photos for chat ${chatId}`);
    this.logger.log(`📸 Caption: "${caption || 'none'}"`);
    this.logger.log(`📸 User state: ${userState?.state || 'none'}`);

    // Ignore messages from bots (including our own bot)
    if (msg.from?.is_bot) {
      this.logger.log('📸 Ignoring message from bot');
      return;
    }

    // Ignore messages with our bot's generated caption
    if (caption && caption.includes('Generated by @kling_tgbot')) {
      this.logger.log('📸 Ignoring message with bot caption');
      return;
    }

    // Check if user is waiting for image prompt with reference photo
    if (userState?.state === 'waiting_image_prompt' && caption) {
      this.logger.log(
        '📸 ✅ Processing image generation with reference photo (multiple photos flow)',
      );

      if (caption.length > 300) {
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

      // Save prompt and first photo as reference
      const referencePhoto = allPhotos[0];
      this.userStates.set(chatId, {
        state: 'image_prompt_received',
        data: {
          prompt: caption,
          referencePhoto: {
            file_id: referencePhoto.file_id,
            file_unique_id: referencePhoto.file_unique_id,
          },
        },
      });

      const responseText = `
📸 Референсное изображение добавлено!

Промпт: "${caption}"
📷 С референсным фото

Выберите соотношение сторон:
      `;

      const keyboard = {
        inline_keyboard: [
          [
            { text: '⬜ 1:1 (квадрат)', callback_data: 'image_ratio_1:1' },
            { text: '📱 9:16 (вертикаль)', callback_data: 'image_ratio_9:16' },
          ],
          [
            {
              text: '🖥️ 16:9 (горизонталь)',
              callback_data: 'image_ratio_16:9',
            },
            { text: '📋 4:3', callback_data: 'image_ratio_4:3' },
          ],
          [
            { text: '🖼️ 3:2', callback_data: 'image_ratio_3:2' },
            { text: '🎬 21:9 (ультра)', callback_data: 'image_ratio_21:9' },
          ],
          [{ text: '🔙 Назад к изображениям', callback_data: 'image' }],
        ],
      };

      this.bot.sendMessage(chatId, responseText, { reply_markup: keyboard });
      return;
    }

    // If photo has caption and user is not in video flow, treat caption as video prompt
    if (
      caption &&
      (!userState ||
        (userState.state !== 'video_prompt_received' &&
          userState.state !== 'waiting_image_prompt'))
    ) {
      if (caption.length > 300) {
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

      // Add all photos to the video generation flow
      const photoObjects = allPhotos.map((photo) => ({
        file_id: photo.file_id,
        file_unique_id: photo.file_unique_id,
      }));

      // Limit to 2 photos maximum
      const limitedPhotos = photoObjects.slice(0, 2);

      // Start video generation flow with prompt and images
      this.userStates.set(chatId, {
        state: 'video_prompt_received',
        data: {
          prompt: caption,
          images: limitedPhotos,
        },
      });

      const responseText = `
📸 ${limitedPhotos.length === 1 ? 'Изображение' : 'Изображения'} ${limitedPhotos.length}/2 добавлено!
${
  limitedPhotos.length === 2
    ? '✅ Достигнут лимит изображений (2/2)'
    : `📷 Можете добавить еще ${2 - limitedPhotos.length} изображение`
}

Промпт: "${caption}"
Изображений: ${limitedPhotos.length}/2

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
      return;
    }

    // Check if user is in video generation process (has video prompt)
    if (
      userState?.data?.prompt &&
      userState?.state === 'video_prompt_received'
    ) {
      const currentImages = userState.data?.images || [];
      const totalImagesAfterAdd = currentImages.length + photoCount;

      if (totalImagesAfterAdd > 2) {
        this.bot.sendMessage(
          chatId,
          '⚠️ Максимум 2 изображения! Удалите существующие или перейдите к настройкам генерации.',
        );
        return;
      }

      // Add all photos to current images
      const newPhotos = allPhotos.map((photo) => ({
        file_id: photo.file_id,
        file_unique_id: photo.file_unique_id,
      }));

      const updatedImages = [...currentImages, ...newPhotos].slice(0, 2);

      this.userStates.set(chatId, {
        ...userState,
        data: { ...userState.data, images: updatedImages },
      });

      const addedCount = updatedImages.length - currentImages.length;
      const responseText = `
📸 ${addedCount === 1 ? 'Изображение' : 'Изображения'} добавлено! (${addedCount} шт.)

${
  updatedImages.length === 2
    ? '✅ Достигнут лимит изображений (2/2)'
    : `📷 Можете добавить еще ${2 - updatedImages.length} изображение`
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
          ],
          [{ text: '🔙 Назад к видео', callback_data: 'video' }],
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

  private handlePhotoMessage(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const userState = this.userStates.get(chatId);
    const caption = msg.caption?.trim();

    this.logger.log(`📸 Single photo message for chat ${chatId}`);
    this.logger.log(`📸 Caption: "${caption || 'none'}"`);
    this.logger.log(`📸 User state: ${userState?.state || 'none'}`);

    // Ignore messages from bots (including our own bot)
    if (msg.from?.is_bot) {
      this.logger.log('📸 Ignoring single photo from bot');
      return;
    }

    // Ignore messages with our bot's generated caption
    if (caption && caption.includes('Generated by @kling_tgbot')) {
      this.logger.log('📸 Ignoring single photo with bot caption');
      return;
    }

    // Check if user is waiting for image prompt with reference photo
    if (userState?.state === 'waiting_image_prompt' && caption) {
      this.logger.log(
        '📸 ✅ Processing single image generation with reference photo',
      );

      if (caption.length > 300) {
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

      // Save prompt and photo as reference
      const photo = msg.photo?.[msg.photo.length - 1];
      if (photo) {
        this.userStates.set(chatId, {
          state: 'image_prompt_received',
          data: {
            prompt: caption,
            referencePhoto: {
              file_id: photo.file_id,
              file_unique_id: photo.file_unique_id,
            },
          },
        });

        const responseText = `
📸 Референсное изображение добавлено!

Промпт: "${caption}"
📷 С референсным фото

Выберите соотношение сторон:
        `;

        const keyboard = {
          inline_keyboard: [
            [
              { text: '⬜ 1:1 (квадрат)', callback_data: 'image_ratio_1:1' },
              {
                text: '📱 9:16 (вертикаль)',
                callback_data: 'image_ratio_9:16',
              },
            ],
            [
              {
                text: '🖥️ 16:9 (горизонталь)',
                callback_data: 'image_ratio_16:9',
              },
              { text: '📋 4:3', callback_data: 'image_ratio_4:3' },
            ],
            [
              { text: '🖼️ 3:2', callback_data: 'image_ratio_3:2' },
              { text: '🎬 21:9 (ультра)', callback_data: 'image_ratio_21:9' },
            ],
            [{ text: '🔙 Назад к изображениям', callback_data: 'image' }],
          ],
        };

        this.bot.sendMessage(chatId, responseText, { reply_markup: keyboard });
      }
      return;
    }

    // If photo has caption and user is not in video flow or image flow, treat caption as video prompt
    if (
      caption &&
      (!userState ||
        (userState.state !== 'video_prompt_received' &&
          userState.state !== 'waiting_image_prompt'))
    ) {
      if (caption.length > 300) {
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

      // Get the highest resolution photo
      const photo = msg.photo?.[msg.photo.length - 1];
      if (photo) {
        // Start video generation flow with prompt and first image
        this.userStates.set(chatId, {
          state: 'video_prompt_received',
          data: {
            prompt: caption,
            images: [
              {
                file_id: photo.file_id,
                file_unique_id: photo.file_unique_id,
              },
            ],
          },
        });

        const responseText = `
📸 Изображение 1/2 добавлено!
📷 Можете добавить еще 1 изображение

Промпт: "${caption}"
Изображений: 1/2

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
      return;
    }

    // Check if user is in video generation process (has video prompt)
    if (
      userState?.data?.prompt &&
      userState?.state === 'video_prompt_received'
    ) {
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

  private async getTelegramFileUrl(fileId: string): Promise<string> {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    const file = await this.bot.getFile(fileId);
    if (!file.file_path) throw new Error('Telegram did not return file_path');
    // CAUTION: this URL contains your bot token — do not log it
    return `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  }

  private async convertTelegramImageToBase64(fileId: string): Promise<string> {
    this.logger.log(`🔄 Starting image conversion for file_id: ${fileId}`);

    try {
      this.logger.log(`📥 Getting Telegram file URL...`);
      const fileUrl = await this.getTelegramFileUrl(fileId);

      // Get file info
      const file = await this.bot.getFile(fileId);
      this.logger.log(
        `📊 File info - path: ${file.file_path}, size: ${Math.round((file.file_size || 0) / 1024)}KB`,
      );

      this.logger.log(`🌐 Downloading image from Telegram servers...`);
      // Download the image
      const response = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
        timeout: 30000, // 30 seconds timeout
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; KlingAI-Bot/1.0)',
        },
      });

      this.logger.log(
        `✅ Download complete: ${response.data.byteLength} bytes received`,
      );

      // Check file size according to Kling AI requirements
      const minSize = 10 * 1024; // 10KB minimum (rough estimate for 300x300px)
      const maxSize = 10 * 1024 * 1024; // 10MB maximum per API docs

      if (response.data.byteLength < minSize) {
        this.logger.error(
          `❌ File too small: ${Math.round(response.data.byteLength / 1024)}KB. Kling AI requires images ≥300x300px.`,
        );
        throw new Error(
          'Image too small. Kling AI requires images at least 300x300 pixels. Please use a larger image.',
        );
      }

      if (response.data.byteLength > maxSize) {
        this.logger.error(
          `❌ File too large: ${Math.round(response.data.byteLength / 1024 / 1024)}MB (max 10MB)`,
        );
        throw new Error(
          'Image file too large (max 10MB). Please use a smaller image.',
        );
      }

      // Check if it's a valid image format
      const contentType = response.headers['content-type'];
      this.logger.log(`🔍 Content type: ${contentType}`);

      // Get file extension from file path for additional validation
      const fileExtension = file.file_path?.split('.').pop()?.toLowerCase();
      this.logger.log(`📂 File extension: ${fileExtension}`);

      // Telegram sometimes returns application/octet-stream for images
      // So we need to check both content-type and file extension
      const isValidImage =
        (contentType && contentType.startsWith('image/')) ||
        (fileExtension &&
          ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(
            fileExtension,
          )) ||
        (contentType === 'application/octet-stream' &&
          fileExtension &&
          ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(fileExtension));

      if (!isValidImage) {
        this.logger.error(`❌ Invalid image format:`);
        this.logger.error(`   Content-Type: ${contentType}`);
        this.logger.error(`   File extension: ${fileExtension}`);
        this.logger.error(`   File path: ${file.file_path}`);
        throw new Error('File is not a valid image format');
      }

      this.logger.log(
        `✅ Image format validated: ${contentType} (ext: ${fileExtension}), ${Math.round(response.data.byteLength / 1024)}KB`,
      );

      // Additional validation: check file signature (magic bytes)
      const buffer = Buffer.from(response.data);
      const signature = buffer.subarray(0, 8);
      this.logger.log(
        `🔍 File signature (first 8 bytes): ${signature.toString('hex')}`,
      );

      // Check magic bytes for common image formats and get MIME type
      const isValidBySignature = this.isValidImageSignature(signature);
      const detectedMimeType = this.getMimeTypeFromSignature(signature);

      if (!isValidBySignature) {
        this.logger.warn(
          `⚠️ File signature doesn't match known image formats, but proceeding anyway due to Telegram quirks`,
        );
      } else {
        this.logger.log(`✅ File signature validation passed`);
      }

      this.logger.log(`🔍 Detected MIME type: ${detectedMimeType}`);

      this.logger.log(`🔄 Converting to base64...`);
      // Convert to base64 - return only the base64 string without data URL prefix
      const base64 = Buffer.from(response.data).toString('base64');

      // Validate base64 format
      if (!base64 || base64.length === 0) {
        this.logger.error(`❌ Base64 conversion failed: empty result`);
        throw new Error('Failed to convert image to base64');
      }

      this.logger.log(`📏 Base64 length: ${base64.length} characters`);

      // Clean base64 string (remove any whitespace/newlines)
      const cleanBase64 = base64.replace(/\s/g, '');

      if (cleanBase64.length !== base64.length) {
        this.logger.log(
          `🧹 Cleaned base64: removed ${base64.length - cleanBase64.length} whitespace characters`,
        );
      }

      // Additional validation - check if base64 is valid
      this.logger.log(`🔍 Validating base64 format...`);
      try {
        Buffer.from(cleanBase64, 'base64');
        this.logger.log(`✅ Base64 validation passed`);
      } catch (e) {
        this.logger.error(`❌ Base64 validation failed: ${e.message}`);
        throw new Error('Generated invalid base64 string');
      }

      this.logger.log(
        `✅ Image conversion complete! Final base64 length: ${cleanBase64.length} chars`,
      );

      // Return only the clean base64 string
      return cleanBase64;
    } catch (error) {
      this.logger.error('❌ convertTelegramImageToBase64 failed:', error);
      this.logger.error(`   Error type: ${error.constructor.name}`);
      this.logger.error(`   Error message: ${error.message}`);
      if (error.response) {
        this.logger.error(`   HTTP status: ${error.response.status}`);
        this.logger.error(
          `   HTTP data: ${JSON.stringify(error.response.data)}`,
        );
      }
      throw new Error(`Failed to process reference image: ${error.message}`);
    }
  }

  private isValidImageSignature(signature: Buffer): boolean {
    const hex = signature.toString('hex').toLowerCase();

    // Check for common image format signatures (magic bytes)
    const imageSignatures = [
      'ffd8ff', // JPEG
      '89504e47', // PNG
      '47494638', // GIF
      '424d', // BMP
      '52494646', // WEBP (starts with RIFF)
      '00000100', // ICO
      '00000200', // CUR
    ];

    return imageSignatures.some((sig) => hex.startsWith(sig));
  }

  private getMimeTypeFromSignature(signature: Buffer): string {
    const hex = signature.toString('hex').toLowerCase();

    if (hex.startsWith('ffd8ff')) return 'image/jpeg';
    if (hex.startsWith('89504e47')) return 'image/png';
    if (hex.startsWith('47494638')) return 'image/gif';
    if (hex.startsWith('424d')) return 'image/bmp';
    if (hex.startsWith('52494646')) return 'image/webp';
    if (hex.startsWith('00000100')) return 'image/x-icon';
    if (hex.startsWith('00000200')) return 'image/x-icon';

    // Default to JPEG if unknown
    return 'image/jpeg';
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
    const caption = msg.caption?.trim();

    // If document has caption and user is not in video flow, treat caption as video prompt
    if (
      caption &&
      (!userState || userState.state !== 'video_prompt_received')
    ) {
      if (caption.length > 300) {
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

      // Start video generation flow with prompt and first image
      this.userStates.set(chatId, {
        state: 'video_prompt_received',
        data: {
          prompt: caption,
          images: [
            {
              file_id: document.file_id,
              file_unique_id: document.file_unique_id,
            },
          ],
        },
      });

      const responseText = `
📸 Изображение 1/2 добавлено!
📷 Можете добавить еще 1 изображение

Промпт: "${caption}"
Изображений: 1/2

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
      return;
    }

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

  // Специальный метод для принудительной отправки видео (НЕ КАК ГИФКА!)
  private async sendVideoAsVideo(
    chatId: number,
    videoUrl: string,
    options?: any,
  ) {
    try {
      // Пробуем разные способы принудительной отправки как видео

      // Способ 1: Отправляем как видео с принудительными параметрами
      try {
        this.logger.log(
          `📹 Попытка #1: Отправка видео как ВИДЕОФАЙЛ (не GIF) для чата ${chatId}`,
        );
        this.logger.log(
          `📹 Параметры: width=${options?.width || 1024}, height=${options?.height || 1024}, duration=${options?.duration || 5}`,
        );

        const result = await this.bot.sendVideo(chatId, videoUrl, {
          ...options,
          // Принудительные параметры для видео
          width: options?.width || 1024,
          height: options?.height || 1024,
          duration: options?.duration || 5,
          // Дополнительные опции для предотвращения автоконвертации в GIF
          parse_mode: options?.parse_mode || undefined,
        });

        this.logger.log(
          `✅ Видео успешно отправлено как ВИДЕОФАЙЛ для чата ${chatId}`,
        );
        return result;
      } catch (videoError) {
        this.logger.warn(
          `❌ Способ #1 неудачен для чата ${chatId}, пробуем способ #2:`,
          videoError,
        );

        // Способ 2: Отправляем как документ с video MIME-type если видео не отправляется
        try {
          this.logger.log(
            `📹 Попытка #2: Отправка как документ для чата ${chatId}`,
          );

          // Создаем объект InputFile для отправки как документ
          const videoAsDocument = {
            url: videoUrl,
            filename: `kling_video_${Date.now()}.mp4`,
          };

          const result = await this.bot.sendDocument(
            chatId,
            videoAsDocument.url,
            {
              caption: options?.caption,
              reply_markup: options?.reply_markup,
            },
          );

          this.logger.log(
            `✅ Видео успешно отправлено как ДОКУМЕНТ для чата ${chatId}`,
          );
          return result;
        } catch (docError) {
          this.logger.warn(
            `❌ Способ #2 также неудачен для чата ${chatId}:`,
            docError,
          );
          throw docError;
        }
      }
    } catch (error) {
      this.logger.error(
        `❌ ВСЕ способы отправки видео неудачны для чата ${chatId}:`,
        error,
      );
      // Fallback - отправляем ссылку текстом
      this.logger.log(
        `📹 Fallback: Отправка как текстовая ссылка для чата ${chatId}`,
      );
      await this.bot.sendMessage(
        chatId,
        `🎥 Ваше видео готово!\n\n📱 Скачать: ${videoUrl}\n\n${options?.caption || ''}`,
        {
          reply_markup: options?.reply_markup,
        },
      );
      throw error;
    }
  }

  // Public method to send videos
  async sendVideo(chatId: number, video: any, options?: any) {
    try {
      // Send only as video - НЕ КАК ГИФКА!
      const videoOptions = {
        ...options,
        // Принудительно отправляем как видеофайл
        width: options?.width || 1024,
        height: options?.height || 1024,
        duration: options?.duration || 5,
      };

      const videoResult = await this.bot.sendVideo(chatId, video, videoOptions);
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
        price: 1,
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

  private async handleSubscriptionPurchase(
    chatId: number,
    plan: 'start' | 'advanced' | 'pro',
    userId?: number,
  ) {
    try {
      const plans = {
        start: {
          name: '💎 СТАРТ',
          videos: 25,
          images: 100,
          price: 1200,
          recurring: false, // Стартовый план - разовый платеж
        },
        advanced: {
          name: '💎 ПРОДВИНУТЫЙ',
          videos: 50,
          images: 100,
          price: 2230,
          recurring: true, // Продвинутый план - подписка
        },
        pro: {
          name: '💎 ПРОФИ',
          videos: 100,
          images: 200,
          price: 4320,
          recurring: true, // Профи план - подписка
        },
      };

      const selectedPlan = plans[plan];

      // Убеждаемся, что пользователь существует в базе данных
      await this.ensureUserExists(chatId);

      const description = `Подписка ${selectedPlan.name} - ${selectedPlan.videos} видео + ${selectedPlan.images} изображений`;

      // Создаем URL для оплаты через Robokassa
      const paymentData = await this.robokassaService.createPaymentUrl({
        userId: chatId,
        amount: selectedPlan.price,
        description: description,
        recurring: selectedPlan.recurring,
        recurringFrequency: 'monthly', // Месячная подписка
      });

      // Сохраняем информацию о платеже в базе данных
      await this.prisma.payment.create({
        data: {
          invoiceId: paymentData.invoiceId.toString(),
          userId: chatId.toString(),
          amount: selectedPlan.price,
          packageType: selectedPlan.recurring ? 'subscription' : 'tokens',
          description: description,
          status: 'pending',
          videoTokensGranted: selectedPlan.videos,
          imageTokensGranted: selectedPlan.images,
        },
      });

      const text = `
✅ ВЫ ВЫБРАЛИ: ${selectedPlan.name}

📦 Включает:
• ${selectedPlan.videos} видео токенов  
• ${selectedPlan.images} токенов изображений
${selectedPlan.recurring ? '• Автопродление каждый месяц' : '• Разовый платеж'}

💰 Стоимость: ${selectedPlan.price}₽${selectedPlan.recurring ? '/мес' : ''}

Нажмите кнопку для перехода к оплате:
      `;

      const keyboard = {
        inline_keyboard: [
          [
            {
              text: `💳 ОПЛАТИТЬ ${selectedPlan.price}₽`,
              url: paymentData.paymentUrl,
            },
          ],
          [
            {
              text: '📄 Оферта',
              url: 'https://teletype.in/@help_24/oferta_kling',
            },
          ],
          [
            { text: '🔙 Назад к тарифам', callback_data: 'balance' },
            { text: '🏠 Главное меню', callback_data: 'main' },
          ],
        ],
      };

      await this.bot.sendMessage(chatId, text, { reply_markup: keyboard });
    } catch (error) {
      this.logger.error(
        `Error in handleSubscriptionPurchase for plan ${plan}:`,
        error,
      );
      await this.bot.sendMessage(
        chatId,
        '❌ Произошла ошибка при создании платежа. Попробуйте позже.',
      );
    }
  }

  private handleAdditionalPackages(chatId: number) {
    const text = `
💎 ДОПОЛНИТЕЛЬНЫЕ ПАКЕТЫ

🎬 Video-ТОКЕНЫ:
▫️ 50 видео · 2240₽
🔥 100 видео · 4256₽ · <s>4480₽</s> (-5%)
🔥 250 видео · 9968₽ · <s>11200₽</s> (-11%)

🖼️ Image-ТОКЕНЫ:
▫️ 100 изо · 449₽
🔥 200 изо · 790₽ · <s>898₽</s> (-12%)
🔥 500 изо · 1900₽ · <s>2245₽</s> (-15%)

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

    this.bot.sendMessage(chatId, text, {
      reply_markup: keyboard,
      parse_mode: 'HTML',
    });
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

  private async handleConfirmCancelSubscription(
    chatId: number,
    userId?: number,
  ) {
    try {
      // Находим активные подписки пользователя
      const activePayments = await this.prisma.payment.findMany({
        where: {
          userId: chatId.toString(),
          packageType: 'subscription',
          status: 'completed',
        },
        orderBy: {
          completedAt: 'desc',
        },
        take: 1, // Берем последнюю активную подписку
      });

      if (activePayments.length === 0) {
        await this.bot.sendMessage(
          chatId,
          '❌ У вас нет активных подписок для отмены.',
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

      const lastPayment = activePayments[0];

      // Отменяем рекуррентный платеж через Robokassa
      const cancelled = await this.robokassaService.cancelRecurringPayment(
        lastPayment.invoiceId,
      );

      if (cancelled) {
        // Обновляем статус в базе данных
        await this.prisma.payment.update({
          where: { id: lastPayment.id },
          data: { status: 'cancelled' },
        });

        await this.bot.sendMessage(
          chatId,
          `✅ Подписка отменена

Ваша подписка успешно отменена. Автопродление остановлено.

• Неиспользованные токены остаются на балансе
• Доступ к функциям сохраняется до конца оплаченного периода
• Вы можете оформить новую подписку в любой момент

Спасибо за использование нашего сервиса!`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '💰 Пополнить баланс', callback_data: 'balance' }],
                [{ text: '🏠 Главное меню', callback_data: 'main' }],
              ],
            },
          },
        );
      } else {
        await this.bot.sendMessage(
          chatId,
          '❌ Произошла ошибка при отмене подписки. Попробуйте позже или обратитесь в поддержку.',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🏠 Главное меню', callback_data: 'main' }],
              ],
            },
          },
        );
      }
    } catch (error) {
      this.logger.error('Error cancelling subscription:', error);
      await this.bot.sendMessage(
        chatId,
        '❌ Произошла ошибка при отмене подписки. Попробуйте позже.',
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
        [{ text: '🔙 Назад', callback_data: 'additional_packages' }],
      ],
    };

    this.bot.sendMessage(chatId, text, { reply_markup: keyboard });
  }

  // Handle Stars payment purchase
  private async handleStarsPurchase(
    chatId: number,
    packageName: string,
    price: number,
  ) {
    try {
      // Убеждаемся, что пользователь существует в базе данных
      await this.ensureUserExists(chatId);

      // Определяем количество токенов для каждого пакета (по названию)
      const packageDetails = this.getPackageDetailsByName(packageName);

      // Создаем описание для платежа
      const description = `${packageName} - ${packageDetails.videoTokens} видео-токенов + ${packageDetails.imageTokens} токенов изображений`;

      // Создаем запись в базе данных для отслеживания (Stars = разовая покупка)
      const payment = await this.prisma.payment.create({
        data: {
          invoiceId: Date.now().toString(),
          userId: chatId.toString(),
          amount: price,
          packageType: 'tokens',
          description: description,
          status: 'pending',
          paymentMethod: 'telegram_stars', // Telegram Stars - разовая покупка
          subscriptionDuration: null, // Нет срока действия для Stars
          videoTokensGranted: packageDetails.videoTokens,
          imageTokensGranted: packageDetails.imageTokens,
        },
      });

      // Отправляем инвойс Telegram Stars
      await this.handlePayStars(chatId, payment.invoiceId, price, packageName);
    } catch (error) {
      this.logger.error('Error in handleStarsPurchase:', error);
      await this.bot.sendMessage(
        chatId,
        '❌ Произошла ошибка при создании платежа. Попробуйте позже.',
      );
    }
  }

  // Handle Card payment purchase
  private async handleCardPurchase(
    chatId: number,
    packageName: string,
    price: number,
  ) {
    try {
      // Убеждаемся, что пользователь существует в базе данных
      await this.ensureUserExists(chatId);

      // Определяем количество токенов для каждого пакета (по названию)
      const packageDetails = this.getPackageDetailsByName(packageName);

      // Создаем описание для платежа
      const description = `${packageName} - ${packageDetails.videoTokens} видео-токенов + ${packageDetails.imageTokens} токенов изображений`;

      // Создаем URL для оплаты через Robokassa
      const paymentData = await this.robokassaService.createPaymentUrl({
        userId: chatId,
        amount: price,
        description: description,
      });

      // Сохраняем информацию о платеже в базе данных
      await this.prisma.payment.create({
        data: {
          invoiceId: paymentData.invoiceId.toString(),
          userId: chatId.toString(),
          amount: price,
          packageType: 'tokens',
          description: description,
          status: 'pending',
          videoTokensGranted: packageDetails.videoTokens,
          imageTokensGranted: packageDetails.imageTokens,
        },
      });

      const message = `
    ✅ ВЫ ВЫБРАЛИ: <b>${packageName}</b>

    💰 Сумма: ${price} ₽
    🎬 ${packageDetails.videoTokens} Видео-токенов
    📸 ${packageDetails.imageTokens} Токенов изображений

    💳 <b>СТОИМОСТЬ</b>: ${price} ₽

    Нажмите кнопку ниже для перехода к оплате:
      `;

      const keyboard = {
        inline_keyboard: [
          [
            {
              text: `💳 ОПЛАТИТЬ ${price}₽`,
              url: paymentData.paymentUrl,
            },
          ],
          [
            {
              text: '📄 Оферта',
              url: 'https://teletype.in/@help_24/oferta_kling',
            },
          ],
          [{ text: '🔙 Назад', callback_data: 'additional_packages' }],
        ],
      };

      await this.bot.sendMessage(chatId, message, {
        reply_markup: keyboard,
        parse_mode: 'HTML',
      });
    } catch (error) {
      this.logger.error('Error in handleCardPurchase:', error);
      await this.bot.sendMessage(
        chatId,
        '❌ Произошла ошибка при создании платежа. Попробуйте позже.',
      );
    }
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
      // Video message - отправляем как видео, НЕ КАК ГИФКУ!
      await this.sendVideo(userId, originalMessage.video.file_id, {
        caption: originalMessage.caption,
        // Принудительные параметры для видео
        width: originalMessage.video.width || 1024,
        height: originalMessage.video.height || 1024,
        duration: originalMessage.video.duration || 5,
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
➕ Создание новой пары ключей
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
            text: '➕ Создать новую пару',
            callback_data: 'admin_create_new_pair',
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

  private async handleViewCurrentKeys(
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

    try {
      // Get all API keys from KlingAiService
      const allApiKeys = await this.klingAiService.getAllApiKeys();
      const currentApiKey = this.klingAiService.getCurrentApiKey();

      let text = `
👁️ ВСЕ API КЛЮЧИ KLING AI

📊 Всего ключей: ${allApiKeys.length}
${currentApiKey ? `🎯 Активный: ${currentApiKey.name}` : '❌ Нет активного ключа'}

`;

      if (allApiKeys.length === 0) {
        text += `❌ API ключи не настроены

Используйте команду /add_api_key для добавления новой пары ключей.`;
      } else {
        allApiKeys.forEach((key, index) => {
          const isActive = currentApiKey && currentApiKey.id === key.id;
          const statusIcon = isActive ? '🟢' : key.isAvailable ? '🟡' : '🔴';
          const activeText = isActive ? ' [АКТИВНЫЙ]' : '';

          text += `
${statusIcon} **${key.name}**${activeText}
   🆔 ID: ${key.id}
   🔑 Access: ${key.accessKey}
   � Приоритет: ${key.priority}
   ⚡ Запросов: ${key.requestCount}
   ❌ Ошибок: ${key.errorCount}
   📅 Последнее использование: ${key.lastUsed ? new Date(key.lastUsed).toLocaleString('ru-RU') : 'Никогда'}
   ${key.isActive ? '✅ Активен' : '⏸️ Неактивен'}
   ${key.isAvailable ? '🟢 Доступен' : '🔴 Недоступен'}
`;
        });
      }

      text += `
⚠️ Ключи частично скрыты для безопасности`;

      const keyboard = {
        inline_keyboard: [
          [
            {
              text: '➕ Добавить новую пару',
              callback_data: 'admin_create_new_pair',
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
          [{ text: '◀️ Назад', callback_data: 'admin_api_keys' }],
        ],
      };

      if (messageId) {
        this.bot.editMessageText(text, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: keyboard,
          parse_mode: 'Markdown',
        });
      } else {
        this.bot.sendMessage(chatId, text, {
          reply_markup: keyboard,
          parse_mode: 'Markdown',
        });
      }
    } catch (error) {
      this.logger.error('Error in handleViewCurrentKeys:', error);
      const errorText = `❌ Ошибка при получении информации о ключах: ${error.message}`;

      if (messageId) {
        this.bot.editMessageText(errorText, {
          chat_id: chatId,
          message_id: messageId,
        });
      } else {
        this.bot.sendMessage(chatId, errorText);
      }
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
          [{ text: '🔙 Назад', callback_data: 'balance' }],
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
              data: {
                status: 'completed',
                completedAt: new Date(),
              },
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

              // Для Telegram Stars (разовая покупка) - просто добавляем токены без подписки
              await this.prisma.user.update({
                where: { telegramId: userIdNum.toString() },
                data: {
                  videoTokens: { increment: v },
                  imageTokens: { increment: i },
                  lastPaymentMethod: 'telegram_stars',
                  lastPaymentDate: new Date(),
                },
              });

              // Notify user
              await this.bot.sendMessage(
                userIdNum,
                `✅ Оплата звездами подтверждена!

💫 На ваш баланс зачислены токены:
🎬 Видео: +${v}
🖼 Изображения: +${i}

💎 Токены добавлены навсегда и не имеют срока действия!
Приятного использования!`,
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
        return { videoTokens: 25, imageTokens: 100 };
    }
  }

  private getPackageDetailsByName(packageName: string): {
    videoTokens: number;
    imageTokens: number;
  } {
    // Map package names to token amounts
    switch (packageName.toLowerCase()) {
      case '50 video':
        return { videoTokens: 50, imageTokens: 0 };
      case '100 video':
        return { videoTokens: 100, imageTokens: 0 };
      case '250 video':
        return { videoTokens: 250, imageTokens: 0 };
      case '100 img':
        return { videoTokens: 0, imageTokens: 100 };
      case '200 img':
        return { videoTokens: 0, imageTokens: 200 };
      case '500 img':
        return { videoTokens: 0, imageTokens: 500 };
      default:
        return { videoTokens: 1, imageTokens: 1 };
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

  // Admin method for creating new API key pair
  private handleCreateNewApiKeyPair(
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
➕ СОЗДАНИЕ НОВОЙ ПАРЫ API КЛЮЧЕЙ

Для создания новой пары API ключей, пожалуйста:

1️⃣ Сначала отправьте Access Key
2️⃣ Затем отправьте Secret Key
3️⃣ Опционально укажите имя для пары

📝 Формат сообщения:
\`/add_api_key\`
\`Access Key\`
\`Secret Key\`
\`Имя пары (опционально)\`

Пример:
\`/add_api_key\`
\`ak-xxx...\`
\`sk-xxx...\`
\`Основной ключ\`

⚠️ Новые ключи будут автоматически протестированы перед сохранением!
    `;

    const keyboard = {
      inline_keyboard: [
        [{ text: '◀️ Назад к API ключам', callback_data: 'admin_api_keys' }],
      ],
    };

    if (messageId) {
      this.bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard,
        parse_mode: 'Markdown',
      });
    } else {
      this.bot.sendMessage(chatId, text, {
        reply_markup: keyboard,
        parse_mode: 'Markdown',
      });
    }
  }

  // Handle /add_api_key command
  private async handleAddApiKeyCommand(
    chatId: number,
    userId?: number,
    messageText?: string,
  ) {
    if (!this.isAdmin(userId)) {
      this.bot.sendMessage(
        chatId,
        '❌ У вас нет прав для выполнения этой команды',
      );
      return;
    }

    if (!messageText) {
      this.bot.sendMessage(
        chatId,
        '❌ Ошибка: не удалось получить текст сообщения',
      );
      return;
    }

    // Парсим сообщение
    const lines = messageText
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line);

    if (lines.length < 3) {
      const errorText = `
❌ НЕВЕРНЫЙ ФОРМАТ

Используйте следующий формат:
\`/add_api_key\`
\`Access Key\`
\`Secret Key\`
\`Имя пары (опционально)\`

Пример:
\`/add_api_key\`
\`ak-xxx...\`
\`sk-xxx...\`
\`Основной ключ\`
      `;

      this.bot.sendMessage(chatId, errorText, { parse_mode: 'Markdown' });
      return;
    }

    const accessKey = lines[1];
    const secretKey = lines[2];
    const customName = lines[3] || undefined;

    // Показываем процесс
    const processingMsg = await this.bot.sendMessage(
      chatId,
      '🧪 Тестирование новых API ключей...',
    );

    try {
      // Сначала тестируем ключи
      const testResult = await this.klingAiService.testNewApiKeyPair(
        accessKey,
        secretKey,
      );

      if (!testResult.valid) {
        await this.bot.editMessageText(
          `❌ ТЕСТ НЕ ПРОЙДЕН\n\nОшибка: ${testResult.error}\n\nПроверьте правильность ключей и попробуйте снова.`,
          {
            chat_id: chatId,
            message_id: processingMsg.message_id,
          },
        );
        return;
      }

      // Если тест прошел, создаем новую пару
      await this.bot.editMessageText(
        '✅ Тест пройден успешно! Создание новой пары...',
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
        },
      );

      const createResult = await this.klingAiService.createNewApiKeyPair(
        accessKey,
        secretKey,
        customName,
      );

      if (createResult.success) {
        const successText = `
✅ ПАРА API КЛЮЧЕЙ СОЗДАНА УСПЕШНО!

🆔 ID: ${createResult.id}
📝 Имя: ${createResult.name}
🔑 Access Key: ${accessKey.substring(0, 8)}...
🔐 Secret Key: ${secretKey.substring(0, 8)}...

Новая пара готова к использованию!
        `;

        await this.bot.editMessageText(successText, {
          chat_id: chatId,
          message_id: processingMsg.message_id,
        });
      } else {
        await this.bot.editMessageText(
          `❌ ОШИБКА ПРИ СОЗДАНИИ\n\nОшибка: ${createResult.error}`,
          {
            chat_id: chatId,
            message_id: processingMsg.message_id,
          },
        );
      }
    } catch (error) {
      this.logger.error('Error in handleAddApiKeyCommand:', error);
      await this.bot.editMessageText(
        `❌ ПРОИЗОШЛА ОШИБКА\n\nПодробности: ${error.message}`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
        },
      );
    }
  }
}
