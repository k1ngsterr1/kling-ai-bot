import { Injectable, Logger } from '@nestjs/common';
import TelegramBot = require('node-telegram-bot-api');
import { PrismaService } from './prisma.service';

@Injectable()
export class AdminBotService {
  private readonly logger = new Logger(AdminBotService.name);
  private bot: TelegramBot;
  private readonly adminIds: number[] = [205204465, 839885529]; // Admin IDs

  constructor(private prisma: PrismaService) {
    // Hardcoded admin bot token
    const adminToken = '8317001460:AAFShbKgvjZsch0hBM4YXe-edfmg-0OduS4';

    this.bot = new TelegramBot(adminToken, { polling: true });
    this.setupAdminBot();

    this.logger.log('🔧 Admin Bot initialized successfully');
  }

  private setupAdminBot() {
    // Start command for admins
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;

      if (!this.isAdmin(chatId)) {
        this.bot.sendMessage(
          chatId,
          '❌ Access denied. This is an admin-only bot.',
        );
        return;
      }

      const welcomeText = `
🔧 **Admin Bot Dashboard**

Доступные команды:
/stats - Статистика пользователей
/broadcast - Рассылка сообщений
/users - Список пользователей
/tokens - Управление токенами
/logs - Просмотр логов
/help - Помощь
      `;

      this.bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown' });
    });

    // Stats command
    this.bot.onText(/\/stats/, async (msg) => {
      const chatId = msg.chat.id;

      if (!this.isAdmin(chatId)) {
        this.bot.sendMessage(chatId, '❌ Access denied.');
        return;
      }

      try {
        const userStats = await this.getUserStats();
        this.bot.sendMessage(chatId, userStats, { parse_mode: 'Markdown' });
      } catch (error) {
        this.logger.error('Error getting stats:', error);
        this.bot.sendMessage(chatId, '❌ Ошибка получения статистики');
      }
    });

    // Users command
    this.bot.onText(/\/users/, async (msg) => {
      const chatId = msg.chat.id;

      if (!this.isAdmin(chatId)) {
        this.bot.sendMessage(chatId, '❌ Access denied.');
        return;
      }

      try {
        const users = await this.getRecentUsers();
        this.bot.sendMessage(chatId, users, { parse_mode: 'Markdown' });
      } catch (error) {
        this.logger.error('Error getting users:', error);
        this.bot.sendMessage(chatId, '❌ Ошибка получения пользователей');
      }
    });

    // Help command
    this.bot.onText(/\/help/, async (msg) => {
      const chatId = msg.chat.id;

      if (!this.isAdmin(chatId)) {
        this.bot.sendMessage(chatId, '❌ Access denied.');
        return;
      }

      const helpText = `
🔧 **Admin Bot Commands**

*📊 Статистика:*
/stats - Общая статистика
/users - Последние пользователи

*🔧 Управление:*
/broadcast - Создать рассылку
/tokens - Управление токенами

*📝 Мониторинг:*
/logs - Просмотр логов
/errors - Последние ошибки

*ℹ️ Информация:*
/help - Эта справка
/status - Статус системы
      `;

      this.bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
    });

    // Error handling
    this.bot.on('polling_error', (error) => {
      this.logger.error('Admin Bot polling error:', error);
    });

    this.logger.log('🔧 Admin Bot commands set up successfully');
  }

  private isAdmin(chatId: number): boolean {
    return this.adminIds.includes(chatId);
  }

  private async getUserStats(): Promise<string> {
    const totalUsers = await this.prisma.user.count();
    const activeUsers = await this.prisma.user.count({
      where: {
        updatedAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
        },
      },
    });

    const totalVideoTokens = await this.prisma.user.aggregate({
      _sum: {
        videoTokens: true,
      },
    });

    const totalImageTokens = await this.prisma.user.aggregate({
      _sum: {
        imageTokens: true,
      },
    });

    const totalPayments = await this.prisma.payment.count({
      where: {
        status: 'completed',
      },
    });

    const totalRevenue = await this.prisma.payment.aggregate({
      where: {
        status: 'completed',
      },
      _sum: {
        amount: true,
      },
    });

    return `
📊 **Статистика системы**

👥 **Пользователи:**
• Всего: ${totalUsers}
• Активные (24ч): ${activeUsers}

🎬 **Токены:**
• Видео: ${totalVideoTokens._sum.videoTokens || 0}
• Изображения: ${totalImageTokens._sum.imageTokens || 0}

💰 **Платежи:**
• Всего: ${totalPayments}
• Выручка: ${totalRevenue._sum.amount || 0} ₽

🕐 Обновлено: ${new Date().toLocaleString('ru-RU')}
    `;
  }

  private async getRecentUsers(): Promise<string> {
    const recentUsers = await this.prisma.user.findMany({
      take: 10,
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        telegramId: true,
        username: true,
        firstName: true,
        videoTokens: true,
        imageTokens: true,
        createdAt: true,
      },
    });

    let usersList = '👥 **Последние пользователи:**\n\n';

    for (const user of recentUsers) {
      const name = user.firstName || user.username || 'Unknown';
      const tokens = `${user.videoTokens}🎬 ${user.imageTokens}🖼️`;
      const date = user.createdAt.toLocaleDateString('ru-RU');

      usersList += `• ${name} (${user.telegramId})\n`;
      usersList += `  Токены: ${tokens}\n`;
      usersList += `  Регистрация: ${date}\n\n`;
    }

    return usersList;
  }

  // Method to send admin notifications
  async sendAdminNotification(message: string) {
    for (const adminId of this.adminIds) {
      try {
        await this.bot.sendMessage(
          adminId,
          `🔔 **Admin Notification**\n\n${message}`,
          {
            parse_mode: 'Markdown',
          },
        );
      } catch (error) {
        this.logger.error(
          `Failed to send notification to admin ${adminId}:`,
          error,
        );
      }
    }
  }

  // Method to send alerts about errors
  async sendErrorAlert(error: string, context?: string) {
    const alertMessage = `
🚨 **System Error Alert**

❌ Error: ${error}
${context ? `📍 Context: ${context}` : ''}
🕐 Time: ${new Date().toLocaleString('ru-RU')}
    `;

    await this.sendAdminNotification(alertMessage);
  }
}
