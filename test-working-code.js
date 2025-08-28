const crypto = require('crypto'); // Используем нативный crypto

// Пароли из аккаунта Robokassa
const merchantLogin = 'kling_tgbot';
const password1 = 'ge2szRg0qJnrl81E0SEe';
const password2 = 'EJ8rKq4mtHbr65eP4LWV';

console.log('=== Тест с логикой как в рабочем коде ===');
console.log(`Merchant: ${merchantLogin}`);
console.log('');

// Тестовые данные
const outSum = '100.00';
const invoiceId = Date.now().toString();
const userId = 123;

console.log(`OutSum: ${outSum}`);
console.log(`InvoiceID: ${invoiceId}`);
console.log(`UserId: ${userId}`);
console.log('');

// Генерируем подпись как в рабочем коде с Shp_userId
const signatureString = `${merchantLogin}:${outSum}:${invoiceId}:${password1}:Shp_userId=${userId}`;
console.log('Signature string:', signatureString.replace(password1, '***'));

const signature = crypto
  .createHash('md5')
  .update(signatureString)
  .digest('hex')
  .toUpperCase();

console.log('Payment signature:', signature);
console.log('');

// Создаем URL как в рабочем коде
const baseUrl = 'https://auth.robokassa.ru/Merchant/Index.aspx';
const params = new URLSearchParams({
  MerchantLogin: merchantLogin,
  OutSum: outSum,
  InvoiceID: invoiceId,
  Description: 'Покупка 100 токенов',
  SignatureValue: signature, // SignatureValue вместо Signature
  Shp_userId: userId.toString(),
  Culture: 'ru',
});

const paymentUrl = `${baseUrl}?${params.toString()}`;

console.log('=== Финальный Payment URL (как в рабочем коде) ===');
console.log(paymentUrl);
console.log('');

console.log('=== Параметры URL ===');
params.forEach((value, key) => {
  console.log(`${key}: ${value}`);
});

console.log('');
console.log('🎯 Попробуйте открыть этот URL в браузере:');
console.log(paymentUrl);
