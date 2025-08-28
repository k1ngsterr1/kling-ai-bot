const { RobokassaService } = require('./dist/robokassa.service');
const { ConfigService } = require('@nestjs/config');

// Создаем экземпляр ConfigService
const configService = {
  get: (key) => {
    const config = {
      ROBOKASSA_MERCHANT_LOGIN: 'kling_tgbot',
      ROBOKASSA_PASSWORD1: 'ge2szRg0qJnrl81E0SEe',
      ROBOKASSA_PASSWORD2: 'EJ8rKq4mtHbr65eP4LWV',
      ROBOKASSA_TEST_MODE: 'false', // Отключаем тестовый режим
    };
    return config[key];
  },
};

async function testSignature() {
  console.log('🧪 Тестирование подписи Robokassa...\n');

  const robokassaService = new RobokassaService(configService);

  try {
    // Тестируем простой платеж
    console.log('1️⃣ Создаем простой платеж...');
    const paymentData = await robokassaService.createPaymentUrl({
      userId: 123456789,
      amount: 2230,
      description: 'Тестовый платеж',
      recurring: false, // Отключаем рекуррентность
    });

    console.log('✅ Платеж создан:');
    console.log('   Invoice ID:', paymentData.invoiceId);
    console.log('   URL:', paymentData.paymentUrl);
    console.log('');

    // Проверим URL на наличие ошибки 29
    if (paymentData.paymentUrl.includes('MerchantLogin=kling_tgbot')) {
      console.log('✅ MerchantLogin корректен');
    } else {
      console.log('❌ Проблема с MerchantLogin');
    }

    if (paymentData.paymentUrl.includes('OutSum=2230.00')) {
      console.log('✅ Сумма корректна');
    } else {
      console.log('❌ Проблема с суммой');
    }

    if (paymentData.paymentUrl.includes('Shp_UserId=123456789')) {
      console.log('✅ User ID передан');
    } else {
      console.log('❌ User ID отсутствует');
    }

    if (paymentData.paymentUrl.includes('IsTest=1')) {
      console.log('⚠️  Тестовый режим включен (может вызвать ошибку 29)');
    } else {
      console.log('✅ Боевой режим (тестовый режим отключен)');
    }

    // Извлекаем подпись из URL для проверки
    const urlParams = new URLSearchParams(paymentData.paymentUrl.split('?')[1]);
    const signature = urlParams.get('SignatureValue');
    console.log('📝 Подпись:', signature);

    console.log('\n🎉 Тест завершен! Попробуйте перейти по ссылке.');
    console.log('Если получите ошибку 29, проверьте:');
    console.log('- MerchantLogin в личном кабинете Robokassa');
    console.log('- Password1 в настройках магазина');
    console.log('- Соответствие тестового/боевого режима');
  } catch (error) {
    console.error('❌ Ошибка при тестировании:', error.message);
    console.error('Детали:', error);
  }
}

// Запускаем тесты
if (require.main === module) {
  testSignature();
}

module.exports = { testSignature };
