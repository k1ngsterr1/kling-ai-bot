const jwt = require('jsonwebtoken');
const axios = require('axios');

// Ваши ключи из .env
const accessKey = 'AgYCCpYCmYhhyANmh3mtrf8bQaAe3pTH';
const secretKey = 'bdJEagGGEfNpbCpCCfELmyTape9AJ9Kr';

function generateJwtToken() {
  const now = Math.floor(Date.now() / 1000);

  // Create header
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  // Create payload according to Kling AI docs
  const expiry = now + 1800; // Expire in 30 minutes
  const payload = {
    iss: accessKey,
    exp: expiry,
    nbf: now, // Not before now
  };

  console.log('🔑 Генерирую JWT токен для Kling AI');
  console.log('📋 JWT Payload:', payload);

  // Create JWT token
  const token = jwt.sign(payload, secretKey, {
    algorithm: 'HS256',
    header: header,
    noTimestamp: true, // Убираем автоматическое поле iat
  });

  return token;
}

async function generateImage() {
  console.log('🖼️ Тестирование генерации изображения через Kling AI\n');

  try {
    // Генерируем JWT токен
    const token = generateJwtToken();

    console.log('\n🎫 Сгенерированный JWT токен:');
    console.log(token);
    console.log('');

    // Разбираем токен на части для проверки
    const [headerB64, payloadB64, signature] = token.split('.');
    console.log('🔍 Декодированный JWT Header:');
    console.log(JSON.parse(Buffer.from(headerB64, 'base64').toString()));
    console.log('');

    console.log('🔍 Декодированный JWT Payload:');
    console.log(JSON.parse(Buffer.from(payloadB64, 'base64').toString()));
    console.log('');

    // Данные для генерации изображения
    const imageData = {
      model: 'kling-v-1',
      prompt: 'A cute cat sitting on a sunny windowsill, digital art style',
      aspect_ratio: '1:1',
    };

    console.log('📤 Отправляю запрос на генерацию изображения...');
    console.log('📋 Данные запроса:', JSON.stringify(imageData, null, 2));
    console.log('🔐 Authorization: Bearer', token.substring(0, 50) + '...');
    console.log('');

    // Отправляем запрос к Kling AI API
    const response = await axios.post(
      'https://api.klingai.com/v1/images/generations',
      imageData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'KlingAI-Bot/1.0',
        },
        timeout: 30000,
      },
    );

    console.log('✅ Успешный ответ от Kling AI:');
    console.log('📊 Status:', response.status);
    console.log('📋 Response:', JSON.stringify(response.data, null, 2));

    if (response.data && response.data.data && response.data.data.task_id) {
      console.log('');
      console.log('🎉 Изображение поставлено в очередь на генерацию!');
      console.log('🆔 Task ID:', response.data.data.task_id);
    }
  } catch (error) {
    console.error('❌ Ошибка при генерации изображения:');

    if (error.response) {
      console.error('📊 Status:', error.response.status);
      console.error(
        '📋 Response:',
        JSON.stringify(error.response.data, null, 2),
      );
      console.error(
        '🔍 Headers:',
        JSON.stringify(error.response.headers, null, 2),
      );
    } else if (error.request) {
      console.error('📡 Request error:', error.message);
    } else {
      console.error('🚫 Error:', error.message);
    }
  }
}

// Запускаем тест
generateImage();
