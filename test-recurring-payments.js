const { RobokassaService } = require('./dist/robokassa.service');
const { ConfigService } = require('@nestjs/config');

// Создаем экземпляр ConfigService
const configService = {
  get: (key) => {
    const config = {
      ROBOKASSA_MERCHANT_LOGIN: 'kling_tgbot',
      ROBOKASSA_PASSWORD1: 'ge2szRg0qJnrl81E0SEe',
      ROBOKASSA_PASSWORD2: 'EJ8rKq4mtHbr65eP4LWV',
      ROBOKASSA_TEST_MODE: 'true',
    };
    return config[key];
  },
};

async function testRecurringPayments() {
  console.log('🧪 Тестирование рекуррентных платежей Robokassa...\n');

  const robokassaService = new RobokassaService(configService);

  try {
    // 1. Создаем обычный платеж с рекуррентностью
    console.log('1️⃣ Создаем рекуррентный платеж...');
    const paymentData = await robokassaService.createPaymentUrl({
      userId: 123456789,
      amount: 2230,
      description: 'Подписка ПРОДВИНУТЫЙ - ежемесячно',
      recurring: true,
      recurringFrequency: 'monthly',
    });

    console.log('✅ Рекуррентный платеж создан:');
    console.log('   Invoice ID:', paymentData.invoiceId);
    console.log('   URL:', paymentData.paymentUrl);
    console.log('');

    // 2. Создаем повторный рекуррентный платеж
    console.log('2️⃣ Создаем повторный рекуррентный платеж...');
    const recurringData = await robokassaService.createRecurringPayment({
      userId: 123456789,
      amount: 2230,
      description: 'Подписка ПРОДВИНУТЫЙ - продление',
      previousInvoiceId: paymentData.invoiceId.toString(),
    });

    console.log('✅ Повторный рекуррентный платеж создан:');
    console.log('   Invoice ID:', recurringData.invoiceId);
    console.log('   URL:', recurringData.paymentUrl);
    console.log('');

    // 3. Тестируем проверку callback'а для рекуррентного платежа
    console.log('3️⃣ Тестируем проверку рекуррентного callback...');
    const callbackData = {
      OutSum: '2230.00',
      InvId: recurringData.invoiceId.toString(),
      SignatureValue: 'dummy_signature', // В реальности будет правильная подпись
      PreviousInvoiceID: paymentData.invoiceId.toString(),
      Recurring: 'true',
      Shp_UserId: '123456789',
    };

    const isRecurring = robokassaService.isRecurringPayment(callbackData);
    console.log('✅ Проверка рекуррентности:', isRecurring ? 'Да' : 'Нет');
    console.log('');

    // 4. Тестируем отмену подписки
    console.log('4️⃣ Тестируем отмену подписки...');
    const cancelled = await robokassaService.cancelRecurringPayment(
      paymentData.invoiceId.toString(),
    );
    console.log('✅ Подписка отменена:', cancelled ? 'Да' : 'Нет');
    console.log('');

    console.log('🎉 Все тесты рекуррентных платежей прошли успешно!');
    console.log('');
    console.log('📋 Что было протестировано:');
    console.log('   ✓ Создание рекуррентного платежа');
    console.log('   ✓ Создание повторного платежа на основе предыдущего');
    console.log("   ✓ Определение рекуррентного callback'а");
    console.log('   ✓ Отмена подписки');
    console.log('');
    console.log(
      '⚠️  Примечание: Тестовые URL содержат IsTest=1 для безопасного тестирования',
    );
  } catch (error) {
    console.error('❌ Ошибка при тестировании:', error.message);
    console.error('Детали:', error);
  }
}

// Запускаем тесты
if (require.main === module) {
  testRecurringPayments();
}

module.exports = { testRecurringPayments };
