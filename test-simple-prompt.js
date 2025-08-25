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

async function testSimplePrompts() {
  const prompts = [
    'красивый цветок',
    'горный пейзаж',
    'океан на закате',
    'лесная тропинка',
    'космический корабль приближается к неизвестной планете, звёзды',
  ];

  const token = generateJwtToken();
  console.log('🧪 Тестируем разные промпты на прохождение модерации\n');

  for (const prompt of prompts) {
    try {
      console.log(`📝 Тестируем: "${prompt}"`);

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
        console.log(`✅ Принят! Task ID: ${taskId}`);

        // Проверяем статус через 5 секунд
        setTimeout(async () => {
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
              console.log(`📊 Статус "${prompt}": ${task.task_status}`);
              if (task.task_status_msg) {
                console.log(`💬 Сообщение: ${task.task_status_msg}`);
              }
            }
          } catch (err) {
            console.log(`❌ Ошибка проверки статуса для "${prompt}"`);
          }
        }, 5000);
      } else {
        console.log(`❌ Отклонен: ${response.data.message}`);
      }
    } catch (error) {
      console.log(
        `❌ Ошибка для "${prompt}": ${error.response?.data?.message || error.message}`,
      );
    }

    console.log('');
    await new Promise((resolve) => setTimeout(resolve, 2000)); // Пауза между запросами
  }
}

testSimplePrompts();
