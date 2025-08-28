const https = require('https');
const http = require('http');
const { URL } = require('url');

// Простой HTTP клиент
function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = client.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }

    req.end();
  });
}

// Тест полного цикла покупки тарифа
async function testFullPaymentFlow() {
  console.log('=== Тест полного цикла покупки и использования ===');

  const userId = 123456; // Тестовый пользователь
  const baseUrl = 'http://localhost:3000';

  try {
    console.log('1. Создаем платеж за тариф БАЗОВЫЙ...');

    const result = await makeRequest(`${baseUrl}/payment/create-tariff`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: {
        userId: userId,
        tariffType: 'basic',
        recurring: false,
      },
    });

    if (result.success) {
      console.log('✅ Платеж создан успешно!');
      console.log(`💰 Сумма: ${result.amount}₽`);
      console.log(`📦 Видео токенов: ${result.tariff.videoTokens}`);
      console.log(`🖼 Изображений токенов: ${result.tariff.imageTokens}`);
      console.log(`🔗 URL для оплаты:`);
      console.log(result.paymentUrl);

      console.log('\n=== Инструкции ===');
      console.log('1. Откройте URL выше в браузере');
      console.log('2. Проведите тестовый платеж');
      console.log('3. После успешной оплаты токены будут зачислены');
      console.log('4. Проверьте работу генерации изображений в боте');

      console.log('\n=== URL для callback (для настройки в Robokassa) ===');
      console.log(`${baseUrl}/payment/robokassa-callback`);
      console.log(`${baseUrl}/payment/success - URL успешной оплаты`);
      console.log(`${baseUrl}/payment/fail - URL неуспешной оплаты`);
    } else {
      console.log('❌ Ошибка создания платежа:', result.error);
    }
  } catch (error) {
    console.error('❌ Ошибка теста:', error.message);
  }
}

const axios = require('axios');
const jwt = require('jsonwebtoken');

// Настройки
const ACCESS_KEY = 'AgYCCpYCmYhhyANmh3mtrf8bQaAe3pTH';
const SECRET_KEY = 'bdJEagGGEfNpbCpCCfELmyTape9AJ9Kr';

function generateJwtToken() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: ACCESS_KEY,
    exp: now + 1800,
    nbf: now,
  };

  return jwt.sign(payload, SECRET_KEY, {
    algorithm: 'HS256',
    header: { alg: 'HS256', typ: 'JWT' },
    noTimestamp: true,
  });
}

async function testImageGeneration() {
  const token = generateJwtToken();

  // Промпты, которые должны пройти модерацию
  const prompts = [
    'красивый цветок на поляне',
    'горный пейзаж с озером',
    'лесная тропинка в солнечный день',
  ];

  console.log('🎨 Тестируем полный цикл генерации изображений\n');

  for (const prompt of prompts) {
    try {
      console.log(`📝 Генерируем: "${prompt}"`);

      // 1. Отправляем запрос на генерацию
      const response = await axios.post(
        'https://api-singapore.klingai.com/v1/images/generations',
        {
          model: 'kling-v-1',
          prompt: prompt,
          aspect_ratio: '1:1',
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        },
      );

      if (response.data.code === 0) {
        const taskId = response.data.data.task_id;
        console.log(`✅ Задача создана: ${taskId}`);

        // 2. Ждём и проверяем статус каждые 10 секунд
        let attempts = 0;
        const maxAttempts = 12; // Максимум 2 минуты ожидания

        while (attempts < maxAttempts) {
          attempts++;
          console.log(`⏳ Проверка ${attempts}/${maxAttempts}...`);

          try {
            const statusResponse = await axios.get(
              'https://api-singapore.klingai.com/v1/images/generations',
              {
                headers: { Authorization: `Bearer ${token}` },
              },
            );

            const task = statusResponse.data.data.find(
              (t) => t.task_id === taskId,
            );

            if (task) {
              console.log(`📊 Статус: ${task.task_status}`);

              if (task.task_status === 'succeed') {
                console.log(`🎉 УСПЕХ! Изображение готово:`);
                if (task.task_result && task.task_result.images) {
                  task.task_result.images.forEach((img, index) => {
                    console.log(`   🖼️  Изображение ${index + 1}: ${img.url}`);
                  });
                }
                break;
              } else if (task.task_status === 'failed') {
                console.log(
                  `❌ ПРОВАЛ: ${task.task_status_msg || 'Unknown error'}`,
                );
                break;
              } else if (
                task.task_status === 'submitted' ||
                task.task_status === 'processing'
              ) {
                console.log(`⏳ Ещё обрабатывается...`);
              }
            } else {
              console.log(`❓ Задача не найдена в списке`);
            }
          } catch (statusError) {
            console.log(`❌ Ошибка проверки статуса: ${statusError.message}`);
          }

          // Ждём 10 секунд перед следующей проверкой
          if (attempts < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 10000));
          }
        }

        if (attempts >= maxAttempts) {
          console.log(`⏰ Превышено время ожидания для "${prompt}"`);
        }
      } else {
        console.log(`❌ Ошибка создания задачи: ${response.data.message}`);
      }
    } catch (error) {
      console.log(
        `❌ Общая ошибка для "${prompt}": ${error.response?.data?.message || error.message}`,
      );
    }

    console.log('\n' + '='.repeat(80) + '\n');
  }
}

// Запускаем тест платежной системы
console.log('🚀 Запуск теста платежной системы...');
testFullPaymentFlow()
  .then(() => {
    console.log('✅ Тест завершён');
  })
  .catch((error) => {
    console.error('❌ Критическая ошибка:', error);
  });

// Также оставляем тест изображений
console.log('🚀 Запуск теста полной генерации изображений...');
testImageGeneration()
  .then(() => {
    console.log('✅ Тест завершён');
  })
  .catch((error) => {
    console.error('❌ Критическая ошибка:', error);
  });
