const jwt = require('jsonwebtoken');
const axios = require('axios');

// Ваши ключи из .env
const accessKey = 'AgYCCpYCmYhhyANmh3mtrf8bQaAe3pTH';
const secretKey = 'bdJEagGGEfNpbCpCCfELmyTape9AJ9Kr';

const now = Math.floor(Date.now() / 1000);

// Создаем payload по документации Kling AI
const expiry = now + 1800; // Истекает через 30 минут
const payload = {
  iss: accessKey,
  exp: expiry,
  nbf: now, // Не раньше текущего времени
};

// Генерируем JWT токен
const token = jwt.sign(payload, secretKey, {
  algorithm: 'HS256',
  header: { alg: 'HS256', typ: 'JWT' },
  noTimestamp: true,
});

console.log('🎫 JWT Token:', token);
console.log('');

// Тестируем разные GET endpoints
const endpoints = [
  '/v1/images/generations?page=1&size=1',
  '/v1/videos/generations?page=1&size=1',
  '/v1/tasks',
  '/v1/tasks?page=1&size=1',
];

async function testEndpoint(endpoint) {
  console.log(`🌐 Тестируем: ${endpoint}`);

  try {
    const response = await axios.get(`https://api.klingai.com${endpoint}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'KlingAI-Bot/1.0',
      },
      timeout: 10000,
    });

    console.log(`✅ Успешно! Status: ${response.status}`);
    console.log('Response:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.log(`❌ Ошибка! Status: ${error.response?.status}`);
    console.log('Message:', error.response?.data?.message || error.message);
  }

  console.log('');
}

async function testAllEndpoints() {
  for (const endpoint of endpoints) {
    await testEndpoint(endpoint);
    await new Promise((resolve) => setTimeout(resolve, 1000)); // Пауза между запросами
  }
}

testAllEndpoints();
