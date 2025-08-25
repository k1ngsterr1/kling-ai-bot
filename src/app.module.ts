import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramController } from './telegram.controller';
import { KlingAiService } from './kling-ai.service';
import { PrismaService } from './prisma.service';
import { RobokassaService } from './robokassa.service';
import { PaymentController } from './payment.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
  ],
  controllers: [AppController, TelegramController, PaymentController],
  providers: [
    AppService,
    TelegramBotService,
    KlingAiService,
    PrismaService,
    RobokassaService,
  ],
})
export class AppModule {}
