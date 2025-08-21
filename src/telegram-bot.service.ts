import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import TelegramBot = require('node-telegram-bot-api');
import { KlingAiService, KlingVideoRequest } from './kling-ai.service';

@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: TelegramBot;
  private userStates: Map<number, { state: string; data?: any }> = new Map();

  constructor(
    private configService: ConfigService,
    private klingAiService: KlingAiService,
  ) {
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

📋 Документы:
    `;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🔒 Политика конфиденциальности', url: 'https://teletype.in/@help_24/privacy_kling' }
        ],
        [
          { text: '📜 Пользовательское соглашение', url: 'https://teletype.in/@help_24/agree_kling' }
        ],
        [
          { text: '💎 Оферта', url: 'https://teletype.in/@help_24/oferta_kling' }
        ],
        [
          { text: '📖 Подробные условия', url: 'https://teletype.in/@help_24/podrobno_kling' }
        ],
        [
          { text: '🏠 Главное меню', callback_data: 'main' }
        ]
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

🔔 Мы пришлем результат сразу как он будет готов
      `;

      const keyboard = {
        inline_keyboard: [[{ text: '🏠 Главное меню', callback_data: 'main' }]],
      };

      await this.bot.sendMessage(chatId, generationText, {
        reply_markup: keyboard,
      });

      // Clear user state as generation is started
      this.userStates.delete(chatId);

      // Start polling for video status
      this.pollVideoStatus(chatId, generationResult.id, totalCost);
    } catch (error) {
      this.logger.error('Error starting video generation:', error);
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

  private async pollVideoStatus(chatId: number, videoId: string, cost: number) {
    const maxAttempts = 30; // Poll for up to 15 minutes (30 * 30 seconds)
    let attempts = 0;

    const poll = async () => {
      attempts++;

      try {
        const status = await this.klingAiService.getVideoStatus(videoId);

        if (status.status === 'completed' && status.videoUrl) {
          // Video is ready
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

          // Try to send the video directly if it's accessible
          try {
            await this.bot.sendVideo(chatId, status.videoUrl, {
              caption: `Видео #${videoId} | Стоимость: ${cost} токенов`,
            });
          } catch (videoError) {
            this.logger.warn('Could not send video directly:', videoError);
          }

          return;
        } else if (status.status === 'failed') {
          // Generation failed
          await this.bot.sendMessage(
            chatId,
            `
❌ Генерация видео не удалась

ID: #${videoId}
Возможные причины:
• Некорректный промпт
• Технические проблемы
• Превышен лимит времени

💰 Токены возвращены на ваш баланс.
          `,
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

        // Continue polling
        setTimeout(poll, 30000); // Poll every 30 seconds
      } catch (error) {
        this.logger.error(`Error polling video status for ${videoId}:`, error);

        if (attempts < maxAttempts) {
          setTimeout(poll, 30000);
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

    // Start polling after initial delay
    setTimeout(poll, 30000);
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
