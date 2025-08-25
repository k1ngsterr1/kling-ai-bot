const jwt = require('jsonwebtoken');

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

console.log('🔑 Генерация JWT токена для Kling AI');
console.log('Access Key:', accessKey);
console.log('Secret Key:', secretKey);
console.log('');

console.log('📋 JWT Header:');
console.log(JSON.stringify(header, null, 2));
console.log('');

console.log('📋 JWT Payload:');
console.log(JSON.stringify(payload, null, 2));
console.log('');

console.log('⏰ Время:');
console.log('Current time (unix):', now);
console.log('Token expires (unix):', expiry);
console.log('Current time (readable):', new Date(now * 1000).toISOString());
console.log('Token expires (readable):', new Date(expiry * 1000).toISOString());
console.log('Valid for:', Math.floor((expiry - now) / 60), 'minutes');
console.log('');

// Генерируем JWT токен
const token = jwt.sign(payload, secretKey, {
  algorithm: 'HS256',
  header: header,
  noTimestamp: true, // Убираем автоматическое поле iat
});

console.log('🎫 Сгенерированный JWT токен:');
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

console.log('🧪 Для тестирования в API:');
console.log('Authorization: Bearer ' + token);
console.log('');

console.log('📝 Curl команда для тестирования:');
console.log(`curl -X GET "https://api.klingai.com/v1/images/generations?page=1&size=1" \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json"`);
