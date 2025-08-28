import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnvironmentVariables } from './config/env.loader';

async function bootstrap() {
  // Load environment variables first
  console.log('🚀 Starting application...');
  loadEnvironmentVariables();

  console.log('🔍 Final environment check:');
  console.log(
    '  TELEGRAM_BOT_TOKEN:',
    process.env.TELEGRAM_BOT_TOKEN ? 'EXISTS' : 'MISSING',
  );
  console.log(
    '  KLING_ACCESS_KEY:',
    process.env.KLING_ACCESS_KEY ? 'EXISTS' : 'MISSING',
  );
  console.log(
    '  DATABASE_URL:',
    process.env.DATABASE_URL ? 'EXISTS' : 'MISSING',
  );

  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
  console.log('✅ Application is running on port', process.env.PORT ?? 3000);
}
bootstrap();
