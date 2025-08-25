const axios = require('axios');
const jwt = require('jsonwebtoken');

// test

// Настройки API
const accessKey = 'AgYCCpYCmYhhyANmh3mtrf8bQaAe3pTH';
const secretKey = 'bdJEagGGEfNpbCpCCfELmyTape9AJ9Kr';
const baseURL = 'https://api-singapore.klingai.com';

// Генерация JWT токена
function generateJWT() {
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + 1800; // 30 минут

  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  const payload = {
    iss: accessKey,
    exp: expiry,
    nbf: now,
  };

  const token = jwt.sign(payload, secretKey, {
    algorithm: 'HS256',
    header: header,
    noTimestamp: true, // Убираем iat
  });

  return token;
}

async function testGetImages() {
  const token = generateJWT();

  console.log('🔑 JWT Token:');
  console.log(token);
  console.log('');

  // Декодируем токен для проверки
  const [headerB64, payloadB64] = token.split('.');
  const decodedHeader = JSON.parse(Buffer.from(headerB64, 'base64').toString());
  const decodedPayload = JSON.parse(
    Buffer.from(payloadB64, 'base64').toString(),
  );

  console.log('📋 Декодированный Header:');
  console.log(JSON.stringify(decodedHeader, null, 2));
  console.log('');

  console.log('📋 Декодированный Payload (без iat):');
  console.log(JSON.stringify(decodedPayload, null, 2));
  console.log('');

  try {
    console.log(`🌏 Тестируем GET запрос к: ${baseURL}`);
    console.log('Endpoint: /v1/images/generations');
    console.log('');

    const response = await axios.get(`${baseURL}/v1/images/generations`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'KlingAI-Bot/1.0',
      },
      params: {
        page: 1,
        size: 10,
      },
      timeout: 30000,
    });

    console.log('✅ GET запрос успешен!');
    console.log('Status:', response.status);
    console.log('Response:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.log('❌ GET запрос неуспешен:');
    console.log('Status:', error.response?.status);
    console.log('Status Text:', error.response?.statusText);
    console.log('Headers:', JSON.stringify(error.response?.headers, null, 2));
    console.log(
      'Error Response:',
      JSON.stringify(error.response?.data, null, 2),
    );

    if (error.response?.status === 401) {
      console.log('');
      console.log('🔍 Анализ 401 ошибки:');
      console.log('- JWT токен сформирован правильно (без iat)');
      console.log('- Access Key:', accessKey.substring(0, 8) + '...');
      console.log('- Возможные причины:');
      console.log('  1. Неверный Secret Key');
      console.log('  2. API ключи не активны для Singapore региона');
      console.log('  3. Требуются дополнительные права доступа для GET');
    }
  }
}

// Запускаем тест
testGetImages().catch(console.error);
