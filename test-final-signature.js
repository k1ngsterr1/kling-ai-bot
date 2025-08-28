const crypto = require('crypto-js');

// Пароли из вашего аккаунта Robokassa
const merchantLogin = 'kling_tgbot';
const password1 = 'ge2szRg0qJnrl81E0SEe'; // Password#1 из настроек
const password2 = 'EJ8rKq4mtHbr65eP4LWV'; // Password#2 из настроек

console.log('=== Тест с финальными паролями ===');
console.log(`Merchant: ${merchantLogin}`);
console.log(`Password1: ${password1}`);
console.log(`Password2: ${password2}`);
console.log('');

// Тестовые данные
const outSum = '100.00';
const invoiceId = Date.now().toString(); // Уникальный ID

console.log(`OutSum: ${outSum}`);
console.log(`InvoiceID: ${invoiceId}`);
console.log('');

// Генерируем подпись для платежа (Password1)
const signatureString = `${merchantLogin}:${outSum}:${invoiceId}:${password1}`;
console.log(
  'Signature string for payment:',
  signatureString.replace(password1, '***'),
);

const signature = crypto.MD5(signatureString).toString().toUpperCase();
console.log('Payment signature:', signature);
console.log('');

// Создаем финальный URL
const baseUrl = 'https://auth.robokassa.ru/Merchant/Index.aspx';
const params = new URLSearchParams({
  MerchantLogin: merchantLogin,
  OutSum: outSum,
  InvoiceID: invoiceId,
  Description: 'Покупка 100 токенов',
  Signature: signature,
});

const paymentUrl = `${baseUrl}?${params.toString()}`;

console.log('=== Финальный Payment URL ===');
console.log(paymentUrl);
console.log('');

console.log('=== Параметры URL ===');
params.forEach((value, key) => {
  console.log(`${key}: ${value}`);
});

console.log('');
console.log('=== ТЕСТ CALLBACK ПОДПИСИ ===');

// Тестируем callback подпись (Password2)
const callbackSignatureString = `${outSum}:${invoiceId}:${password2}`;
console.log(
  'Callback signature string:',
  callbackSignatureString.replace(password2, '***'),
);

const callbackSignature = crypto
  .MD5(callbackSignatureString)
  .toString()
  .toUpperCase();
console.log('Expected callback signature:', callbackSignature);

console.log('');
console.log('🎯 Попробуйте открыть этот URL в браузере для тестирования:');
console.log(paymentUrl);
