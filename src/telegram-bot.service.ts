import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import TelegramBot = require('node-telegram-bot-api');

@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: TelegramBot;
  private userStates: Map<number, { state: string; data?: any }> = new Map();

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

    // Handle photo messages
    this.bot.on('photo', (msg) => {
      this.handlePhotoMessage(msg);
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
      case 'confirm_generation':
        this.handleGenerationConfirmation(chatId);
        break;
      default:
        this.bot.sendMessage(chatId, 'Неизвестная команда');
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

    const { prompt, images = [] } = userState.data;

    const qualityNames = {
      standard: '⚡ STANDARD',
      pro: '🎓 PRO',
      master: '💎 MASTER',
    };

    const costs = {
      standard: '1 токен за 5s',
      pro: '2 токена за 5s',
      master: '4 токена за 5s',
    };

    // Save the selected quality
    this.userStates.set(chatId, {
      ...userState,
      data: { ...userState.data, quality },
    });

    const confirmationText = `
✅ Настройки генерации:

📝 Промпт: "${prompt}"
📸 Изображений: ${images.length}/2
🎚️ Качество: ${qualityNames[quality]}
💰 Стоимость: ${costs[quality]}

⚠️ После подтверждения токены будут списаны с баланса.

Подтвердить генерацию?
    `;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: '✅ Подтвердить генерацию',
            callback_data: 'confirm_generation',
          },
        ],
        [{ text: '🔙 Изменить настройки', callback_data: 'video_settings' }],
        [{ text: '🏠 Главное меню', callback_data: 'main' }],
      ],
    };

    this.bot.sendMessage(chatId, confirmationText, { reply_markup: keyboard });
  }

  private handleGenerationConfirmation(chatId: number) {
    const userState = this.userStates.get(chatId);

    if (!userState?.data) {
      this.bot.sendMessage(
        chatId,
        'Ошибка: данные не найдены. Начните заново с /video',
      );
      return;
    }

    const { prompt, images = [], quality } = userState.data;

    // Clear user state as generation is starting
    this.userStates.delete(chatId);

    const generationText = `
🎬 Генерация видео запущена!

📝 Промпт: "${prompt}"
📸 Изображений: ${images.length}/2
🎚️ Качество: ${quality}

⏳ Ожидайте... Это может занять несколько минут.
Мы уведомим вас, когда видео будет готово.
    `;

    const keyboard = {
      inline_keyboard: [[{ text: '🏠 Главное меню', callback_data: 'main' }]],
    };

    this.bot.sendMessage(chatId, generationText, { reply_markup: keyboard });

    // Here you would integrate with the actual Kling AI API
    // For now, just simulate the process
    setTimeout(() => {
      this.bot.sendMessage(
        chatId,
        '🎉 Генерация завершена! К сожалению, интеграция с Kling AI API еще в разработке.\n\n' +
          'В реальной версии здесь будет ваше сгенерированное видео.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🎬 Создать еще видео', callback_data: 'video' }],
              [{ text: '🏠 Главное меню', callback_data: 'main' }],
            ],
          },
        },
      );
    }, 3000); // Simulate 3 second delay
  }

  private handleTextMessage(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) return;

    const userState = this.userStates.get(chatId);

    if (userState?.state === 'waiting_video_prompt') {
      // User is in video generation flow
      if (text.length > 300) {
        this.bot.sendMessage(
          chatId,
          '⚠️ Промпт слишком длинный! Максимальная длина: 300 символов. Попробуйте сократить описание.',
        );
        return;
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
