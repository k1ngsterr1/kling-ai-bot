const crypto = require('crypto');

// Тестируем простую подпись без дополнительных параметров
const merchantLogin = 'kling_tgbot';
const password1 = 'ge2szRg0qJnrl81E0SEe';
const outSum = '100.00';
const invoiceId = Date.now().toString();

console.log('=== Тест простой подписи (без Shp_userId) ===');
console.log(`Merchant: ${merchantLogin}`);
console.log(`OutSum: ${outSum}`);
console.log(`InvoiceID: ${invoiceId}`);
console.log('');

// Простая формула: MerchantLogin:OutSum:InvoiceID:Password1
const signatureString = `${merchantLogin}:${outSum}:${invoiceId}:${password1}`;
console.log('Signature string:', signatureString.replace(password1, '***'));

const signature = crypto
  .createHash('md5')
  .update(signatureString)
  .digest('hex')
  .toUpperCase();

console.log('Signature:', signature);
console.log('');

// Создаем URL без дополнительных параметров
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

console.log('=== Простой Payment URL ===');
console.log(paymentUrl);
console.log('');

console.log('=== Параметры URL ===');
params.forEach((value, key) => {
  console.log(`${key}: ${value}`);
});

console.log('');
console.log('🎯 Попробуйте этот URL (без Shp_userId):');
console.log(paymentUrl);

console.log('');
console.log('=== Альтернативный вариант с параметром Signature ===');
const paramsAlt = new URLSearchParams({
  MerchantLogin: merchantLogin,
  OutSum: outSum,
  InvoiceID: invoiceId,
  Description: 'Покупка 100 токенов',
  Signature: signature, // Signature вместо SignatureValue
  Culture: 'ru',
});

const paymentUrlAlt = `${baseUrl}?${paramsAlt.toString()}`;
console.log(paymentUrlAlt);
