const crypto = require('crypto-js');

// Настройки Robokassa
const merchantLogin = 'kling_tgbot';
const password1 = 'ge2szRg0qJnrl81E0SEe';
const password2 = 'EJ8rKq4mtHbr65eP4LWV';

// Параметры платежа
const amount = '100.00';
const invoiceId = '1724593473000';
const userId = 123456789;

console.log('🔐 Тестирование подписи Robokassa\n');

// Генерация подписи для создания платежа (с Shp_ параметрами)
console.log('1️⃣ Подпись для создания платежа:');
const paymentSignatureString = `${merchantLogin}:${amount}:${invoiceId}:${password1}:Shp_UserId=${userId}`;
console.log(
  'Строка для подписи:',
  paymentSignatureString.replace(password1, '***'),
);

const paymentSignature = crypto
  .MD5(paymentSignatureString)
  .toString()
  .toUpperCase();
console.log('Подпись:', paymentSignature);

// URL для оплаты
const params = new URLSearchParams({
  MerchantLogin: merchantLogin,
  OutSum: amount,
  InvoiceID: invoiceId,
  Description: 'Тестовый платеж',
  SignatureValue: paymentSignature,
  Culture: 'ru',
  Encoding: 'utf-8',
  Shp_UserId: userId.toString(),
});

const paymentUrl = `https://auth.robokassa.ru/Merchant/Index.aspx?${params.toString()}`;
console.log('\nURL для оплаты:');
console.log(paymentUrl);

console.log('\n2️⃣ Подпись для проверки callback:');
// Генерация подписи для callback (с Shp_ параметрами)
const callbackSignatureString = `${amount}:${invoiceId}:Shp_UserId=${userId}:${password2}`;
console.log(
  'Строка для подписи:',
  callbackSignatureString.replace(password2, '***'),
);

const callbackSignature = crypto
  .MD5(callbackSignatureString)
  .toString()
  .toUpperCase();
console.log('Подпись:', callbackSignature);

console.log('\n✅ Проверьте, что:');
console.log('1. MerchantLogin корректный:', merchantLogin);
console.log('2. Пароль 1 актуальный');
console.log('3. Shp_UserId добавлен и в URL и в подпись');
console.log('4. Порядок параметров в подписи соответствует алфавитному');
