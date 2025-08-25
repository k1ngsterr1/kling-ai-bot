const jwt = require('jsonwebtoken');
const axios = require('axios');

// Ваши ключи из .env
const accessKey = 'AgYCCpYCmYhhyANmh3mtrf8bQaAe3pTH';
const secretKey = 'bdJEagGGEfNpbCpCCfELmyTape9AJ9Kr';

const now = Math.floor(Date.now() / 1000);

// Создаем header
const header = {
  alg: 'HS256',
  typ: 'JWT',
};

// Создаем payload по документации Kling AI
const expiry = now + 1800; // Истекает через 30 минут
const payload = {
  iss: accessKey,
  exp: expiry,
  nbf: now, // Не раньше текущего времени
};

console.log('🔑 Генерация JWT токена для GET запроса');
console.log('Access Key:', accessKey);
console.log('Secret Key:', secretKey.substring(0, 8) + '...');
console.log('');

console.log('📋 JWT Header:');
console.log(JSON.stringify(header, null, 2));
console.log('');

console.log('📋 JWT Payload:');
console.log(JSON.stringify(payload, null, 2));
console.log('');

// Генерируем JWT токен
const token = jwt.sign(payload, secretKey, {
  algorithm: 'HS256',
  header: header,
  noTimestamp: true, // Убираем автоматическое поле iat
});

console.log('🎫 ПОЛНЫЙ JWT ТОКЕН:');
console.log(token);
console.log('');

// Разбираем токен на части
const [headerB64, payloadB64, signature] = token.split('.');
console.log('🔍 Части JWT токена:');
console.log('Header (Base64):', headerB64);
console.log('Payload (Base64):', payloadB64);
console.log('Signature:', signature);
console.log('');

// Декодируем для проверки
console.log('✅ Декодированный Header:');
console.log(JSON.parse(Buffer.from(headerB64, 'base64').toString()));
console.log('');

console.log('✅ Декодированный Payload:');
console.log(JSON.parse(Buffer.from(payloadB64, 'base64').toString()));
console.log('');

// Тестируем GET запрос
console.log('🌐 Тестируем GET запрос к Kling AI...');
console.log('');

async function testGetRequest() {
  try {
    const response = await axios.get(
      'https://api.klingai.com/v1/images/generations?page=1&size=1',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'KlingAI-Bot/1.0',
        },
        timeout: 10000,
      },
    );

    console.log('✅ GET запрос успешен!');
    console.log('Status:', response.status);
    console.log('Data:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.log('❌ GET запрос неуспешен!');
    console.log('Status:', error.response?.status);
    console.log('Status Text:', error.response?.statusText);
    console.log('Headers:', JSON.stringify(error.response?.headers, null, 2));
    console.log('Error Data:', JSON.stringify(error.response?.data, null, 2));
    console.log('');
    console.log('🔍 Анализ ошибки:');

    if (error.response?.status === 401) {
      console.log('- 401 Unauthorized: Проблема с аутентификацией');
      console.log('- Проверьте правильность JWT токена');
      console.log('- Убедитесь, что Access Key и Secret Key корректные');
    }

    console.log('');
    console.log('🎫 JWT токен, который использовался:');
    console.log(token);
  }
}

testGetRequest();
