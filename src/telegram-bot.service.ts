import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import TelegramBot = require('node-telegram-bot-api');

@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: TelegramBot;

  constructor(private configService: ConfigService) {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not defined');
    }

    this.bot = new TelegramBot(token, { polling: true });
    this.setupBot();
  }

  private setupBot() {
    this.logger.log('Telegram bot is starting...');

    // Handle /start command
    this.bot.onText(/\/start/, (msg) => {
      const chatId = msg.chat.id;
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

    // Handle callback queries from inline keyboards
    this.bot.on('callback_query', (callbackQuery) => {
      this.handleCallbackQuery(callbackQuery);
    });

    // Handle any text message
    this.bot.on('message', (msg) => {
      if (!msg.text?.startsWith('/')) {
        // Handle non-command messages
        this.handleTextMessage(msg);
      }
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
    const videoText = `
📱 Видео - генерация и обработка видео

Выберите действие:
• Создание видео из текста
• Обработка существующего видео
• Конвертация формата

Отправьте мне описание видео или загрузите файл для обработки.
    `;

    const keyboard = {
      inline_keyboard: [[{ text: '🏠 Главное меню', callback_data: 'main' }]],
    };

    this.bot.sendMessage(chatId, videoText, { reply_markup: keyboard });
  }

  private handleImageCommand(chatId: number) {
    const imageText = `
🖼 Изображения - создание и редактирование фото

Доступные функции:
• Генерация изображений по описанию
• Редактирование существующих фото
• Улучшение качества изображений

Отправьте мне описание изображения или загрузите фото для редактирования.
    `;

    const keyboard = {
      inline_keyboard: [[{ text: '🏠 Главное меню', callback_data: 'main' }]],
    };

    this.bot.sendMessage(chatId, imageText, { reply_markup: keyboard });
  }

  private handleBalanceCommand(chatId: number) {
    const balanceText = `
💳 Баланс - управление счетом и подпиской

Ваш текущий статус:
• Баланс: 0 токенов
• Подписка: Не активна
• Лимиты: 5 запросов в день (бесплатно)

Для пополнения баланса или оформления подписки обратитесь к администратору.
    `;

    const keyboard = {
      inline_keyboard: [[{ text: '🏠 Главное меню', callback_data: 'main' }]],
    };

    this.bot.sendMessage(chatId, balanceText, { reply_markup: keyboard });
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

Для получения дополнительной поддержки свяжитесь с администратором.
    `;

    const keyboard = {
      inline_keyboard: [[{ text: '🏠 Главное меню', callback_data: 'main' }]],
    };

    this.bot.sendMessage(chatId, helpText, { reply_markup: keyboard });
  }

  private handleCallbackQuery(callbackQuery: TelegramBot.CallbackQuery) {
    const chatId = callbackQuery.message?.chat.id;
    const data = callbackQuery.data;

    if (!chatId) return;

    // Answer the callback query to remove loading state
    this.bot.answerCallbackQuery(callbackQuery.id);

    switch (data) {
      case 'main':
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
      default:
        this.bot.sendMessage(chatId, 'Неизвестная команда');
    }
  }

  private handleTextMessage(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) return;

    // Here you can add logic to handle different types of text messages
    // For now, just acknowledge the message
    this.bot.sendMessage(
      chatId,
      `Получено сообщение: "${text}"\nИспользуйте /main для перехода в главное меню.`,
    );
  }

  // Public method to send custom messages
  async sendMessage(chatId: number, text: string, options?: any) {
    try {
      return await this.bot.sendMessage(chatId, text, options);
    } catch (error) {
      this.logger.error('Error sending message:', error);
      throw error;
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
      return await this.bot.sendVideo(chatId, video, options);
    } catch (error) {
      this.logger.error('Error sending video:', error);
      throw error;
    }
  }
}
