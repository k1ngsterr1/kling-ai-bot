import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramController } from './telegram.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
  ],
  controllers: [AppController, TelegramController],
  providers: [AppService, TelegramBotService],
})
export class AppModule {}
