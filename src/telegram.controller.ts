import { Controller, Post, Body, Logger } from '@nestjs/common';
import { TelegramBotService } from './telegram-bot.service';

@Controller('telegram')
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);

  constructor(private readonly telegramBotService: TelegramBotService) {}

  @Post('webhook')
  async handleWebhook(@Body() update: any) {
    this.logger.log(
      'Received webhook update:',
      JSON.stringify(update, null, 2),
    );

    // The webhook handling logic would go here
    // For now, we're using polling mode, so this endpoint is not actively used

    return { ok: true };
  }
}
