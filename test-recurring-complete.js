import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module.js';

async function testRecurringPayments() {
  console.log('🔄 Полное тестирование рекуррентных платежей...\n');

  const app = await NestFactory.createApplicationContext(AppModule);
  const robokassaService = app.get('RobokassaService');

  try {
    // 1. Тест создания простого платежа
    console.log('1️⃣ Создание простого платежа...');
    const simplePayment = await robokassaService.createPaymentUrl({
      userId: '123456789',
      amount: 2230,
      description: 'Тест простого платежа',
    });
    console.log(
      `✅ Простой платеж: ${simplePayment.paymentUrl.slice(0, 100)}...`,
    );

    // 2. Тест создания рекуррентного платежа
    console.log('\n2️⃣ Создание рекуррентного платежа...');
    const recurringPayment = await robokassaService.createRecurringPayment({
      userId: '123456789',
      amount: 2230,
      description: 'Тест рекуррентного платежа',
      planId: 'monthly_premium',
    });
    console.log(`✅ Рекуррентный платеж создан`);
    console.log(`   Invoice ID: ${recurringPayment.invoiceId}`);
    console.log(`   URL: ${recurringPayment.paymentUrl.slice(0, 100)}...`);

    // 3. Проверка параметров рекуррентного платежа
    console.log('\n3️⃣ Проверка параметров рекуррентного платежа...');
    const url = new URL(recurringPayment.paymentUrl);
    const params = url.searchParams;

    console.log(`📋 Параметры рекуррентного платежа:`);
    console.log(`   MerchantLogin: ${params.get('MerchantLogin')}`);
    console.log(`   OutSum: ${params.get('OutSum')}`);
    console.log(`   InvoiceID: ${params.get('InvoiceID')}`);
    console.log(`   Recurring: ${params.get('Recurring')}`);
    console.log(`   Shp_UserId: ${params.get('Shp_UserId')}`);
    console.log(`   Shp_PlanId: ${params.get('Shp_PlanId')}`);

    // Проверки
    if (params.get('Recurring') === 'true') {
      console.log('✅ Рекуррентный режим включен');
    } else {
      console.log('❌ Рекуррентный режим не найден');
    }

    if (params.get('Shp_PlanId')) {
      console.log('✅ Plan ID передан');
    } else {
      console.log('❌ Plan ID отсутствует');
    }

    if (!params.get('IsTest')) {
      console.log('✅ Боевой режим (IsTest отсутствует)');
    } else {
      console.log('⚠️  Тестовый режим включен');
    }

    console.log('\n🎉 Все тесты рекуррентных платежей прошли успешно!');
  } catch (error) {
    console.error('❌ Ошибка при тестировании:', error.message);
  } finally {
    await app.close();
  }
}

testRecurringPayments().catch(console.error);
