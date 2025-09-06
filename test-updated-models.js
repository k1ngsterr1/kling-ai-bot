const axios = require('axios');
const jwt = require('jsonwebtoken');

// Тестирование обновленных моделей Kling AI
async function testKlingModels() {
  console.log('🧪 Тестирование обновленных моделей Kling AI...');

  // Читаем переменные окружения
  const accessKey = process.env.KLING_ACCESS_KEY;
  const secretKey = process.env.KLING_SECRET_KEY;

  if (!accessKey || !secretKey) {
    console.error(
      '❌ Не найдены KLING_ACCESS_KEY или KLING_SECRET_KEY в переменных окружения',
    );
    process.exit(1);
  }

  // Генерируем JWT токен
  const payload = {
    iss: accessKey,
    exp: Math.floor(Date.now() / 1000) + 1800,
    aud: 'https://api.klingai.com',
  };

  const token = jwt.sign(payload, secretKey, { algorithm: 'HS256' });
  console.log('✅ JWT токен сгенерирован');

  // Настройка HTTP клиента
  const httpClient = axios.create({
    baseURL: 'https://api.klingai.com',
    timeout: 30000,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  // Тест 1: Стандартная модель
  console.log('\n📹 Тестируем стандартную модель (kling-v1, std режим)...');
  try {
    const standardRequest = {
      model_name: 'kling-v1',
      prompt: 'A beautiful sunset over the ocean with waves',
      mode: 'std',
      aspect_ratio: '16:9',
      duration: '5',
    };

    console.log(
      '📤 Отправляем запрос:',
      JSON.stringify(standardRequest, null, 2),
    );

    const standardResponse = await httpClient.post(
      '/v1/videos/text2video',
      standardRequest,
    );
    console.log(
      '✅ Стандартная модель работает! Ответ:',
      standardResponse.data,
    );
  } catch (error) {
    console.error(
      '❌ Ошибка стандартной модели:',
      error.response?.data || error.message,
    );
  }

  // Тест 2: Про модель
  console.log('\n📹 Тестируем про модель (kling-v2-1-master, pro режим)...');
  try {
    const proRequest = {
      model_name: 'kling-v2-1-master',
      prompt: 'A majestic eagle soaring through mountain peaks',
      mode: 'pro',
      aspect_ratio: '16:9',
      duration: '5',
    };

    console.log('📤 Отправляем запрос:', JSON.stringify(proRequest, null, 2));

    const proResponse = await httpClient.post(
      '/v1/videos/text2video',
      proRequest,
    );
    console.log('✅ Про модель работает! Ответ:', proResponse.data);
  } catch (error) {
    console.error(
      '❌ Ошибка про модели:',
      error.response?.data || error.message,
    );
  }

  // Тест 3: Мастер модель
  console.log('\n📹 Тестируем мастер модель (kling-v2-master, pro режим)...');
  try {
    const masterRequest = {
      model_name: 'kling-v2-master',
      prompt: 'A futuristic city at night with neon lights',
      mode: 'pro',
      aspect_ratio: '16:9',
      duration: '5',
    };

    console.log(
      '📤 Отправляем запрос:',
      JSON.stringify(masterRequest, null, 2),
    );

    const masterResponse = await httpClient.post(
      '/v1/videos/text2video',
      masterRequest,
    );
    console.log('✅ Мастер модель работает! Ответ:', masterResponse.data);
  } catch (error) {
    console.error(
      '❌ Ошибка мастер модели:',
      error.response?.data || error.message,
    );
  }

  // Тест 4: Генерация изображений
  console.log('\n🎨 Тестируем генерацию изображений (kling-v1)...');
  try {
    const imageRequest = {
      model_name: 'kling-v1',
      prompt: 'A beautiful landscape with mountains and lake',
      aspect_ratio: '16:9',
    };

    console.log('📤 Отправляем запрос:', JSON.stringify(imageRequest, null, 2));

    const imageResponse = await httpClient.post(
      '/v1/images/generations',
      imageRequest,
    );
    console.log(
      '✅ Генерация изображений работает! Ответ:',
      imageResponse.data,
    );
  } catch (error) {
    console.error(
      '❌ Ошибка генерации изображений:',
      error.response?.data || error.message,
    );
  }

  console.log('\n🏁 Тестирование завершено!');
}

// Запускаем тест
testKlingModels().catch(console.error);
