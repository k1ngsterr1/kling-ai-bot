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

async function checkSuccessfulImage() {
  const token = generateJwtToken();

  console.log('🔍 Проверяем успешно сгенерированное изображение...\n');

  try {
    const response = await axios.get(
      'https://api-singapore.klingai.com/v1/images/generations',
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (response.data.code === 0) {
      // Ищем успешные задачи
      const successfulTasks = response.data.data.filter(
        (task) => task.task_status === 'succeed',
      );

      console.log(
        `✅ Найдено ${successfulTasks.length} успешных изображений:\n`,
      );

      successfulTasks.forEach((task, index) => {
        console.log(`🎯 Изображение ${index + 1}:`);
        console.log(`   📋 Task ID: ${task.task_id}`);
        console.log(
          `   📅 Создано: ${new Date(task.created_at).toLocaleString()}`,
        );

        if (task.task_result && task.task_result.images) {
          task.task_result.images.forEach((img, imgIndex) => {
            console.log(`   🖼️  URL ${imgIndex + 1}: ${img.url}`);
          });
        }
        console.log('');
      });

      if (successfulTasks.length === 0) {
        console.log('😰 Нет ни одного успешно сгенерированного изображения...');

        // Покажем статистику всех задач
        const stats = response.data.data.reduce((acc, task) => {
          acc[task.task_status] = (acc[task.task_status] || 0) + 1;
          return acc;
        }, {});

        console.log('\n📊 Статистика всех задач:');
        Object.entries(stats).forEach(([status, count]) => {
          console.log(`   ${status}: ${count}`);
        });
      }
    } else {
      console.log(`❌ Ошибка API: ${response.data.message}`);
    }
  } catch (error) {
    console.log(
      `❌ Ошибка запроса: ${error.response?.data?.message || error.message}`,
    );
  }
}

checkSuccessfulImage();
