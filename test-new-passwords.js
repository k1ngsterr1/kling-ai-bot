const crypto = require('crypto');

// Новые пароли из .env файла
const merchantLogin = 'kling_tgbot';
const password1 = 'D1s2hzGBvRjrDHh83b0z'; // Новый Password1
const password2 = 'D4SK8a9gnIjMdZ4qqZ1K'; // Новый Password2

console.log('=== Тест с новыми паролями ===');
console.log(`Merchant: ${merchantLogin}`);
console.log(`Password1: ${password1}`);
console.log(`Password2: ${password2}`);
console.log('');

// Тестовые данные
const outSum = '100.00';
const invoiceId = Date.now().toString();

console.log(`OutSum: ${outSum}`);
console.log(`InvoiceID: ${invoiceId}`);
console.log('');

// Генерируем подпись для платежа (Password1) - простая формула
const signatureString = `${merchantLogin}:${outSum}:${invoiceId}:${password1}`;
console.log('Signature string:', signatureString.replace(password1, '***'));

const signature = crypto
  .createHash('md5')
  .update(signatureString)
  .digest('hex')
  .toUpperCase();

console.log('Payment signature:', signature);
console.log('');

// Создаем URL
const baseUrl = 'https://auth.robokassa.ru/Merchant/Index.aspx';
const params = new URLSearchParams({
  MerchantLogin: merchantLogin,
  OutSum: outSum,
  InvoiceID: invoiceId,
  Description: 'Покупка 100 токенов',
  SignatureValue: signature,
  Culture: 'ru',
});

const paymentUrl = `${baseUrl}?${params.toString()}`;

console.log('=== Payment URL с новыми паролями ===');
console.log(paymentUrl);
console.log('');

console.log('=== Параметры URL ===');
params.forEach((value, key) => {
  console.log(`${key}: ${value}`);
});

console.log('');
console.log('🎯 Попробуйте этот URL с новыми паролями:');
console.log(paymentUrl);

console.log('');
console.log('=== Тест callback подписи (Password2) ===');
const callbackSignatureString = `${outSum}:${invoiceId}:${password2}`;
console.log(
  'Callback signature string:',
  callbackSignatureString.replace(password2, '***'),
);

const callbackSignature = crypto
  .createHash('md5')
  .update(callbackSignatureString)
  .digest('hex')
  .toUpperCase();

console.log('Expected callback signature:', callbackSignature);
