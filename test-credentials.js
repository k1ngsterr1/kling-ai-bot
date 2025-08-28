// Проверяем разные возможные варианты MerchantLogin
const crypto = require('crypto');

const possibleLogins = [
  'kling_tgbot', // Текущий
  'klingtgbot', // Без подчеркивания
  'kling-tgbot', // С дефисом
  'Kling_tgbot', // С заглавной буквы
];

const possiblePasswords = [
  'ge2szRg0qJnrl81E0SEe', // Текущий Password1
  'EJ8rKq4mtHbr65eP4LWV', // Password2 (если перепутали)
];

const outSum = '100.00';
const invoiceId = '1756360880264';

console.log('=== Проверяем разные комбинации учетных данных ===');

let counter = 1;
for (const login of possibleLogins) {
  for (const password of possiblePasswords) {
    console.log(`--- Вариант ${counter} ---`);
    console.log(`Login: ${login}`);
    console.log(`Password: ${password.substring(0, 10)}...`);

    const signatureString = `${login}:${outSum}:${invoiceId}:${password}`;
    const signature = crypto
      .createHash('md5')
      .update(signatureString)
      .digest('hex')
      .toUpperCase();

    console.log(`Signature: ${signature}`);

    const url = `https://auth.robokassa.ru/Merchant/Index.aspx?MerchantLogin=${login}&OutSum=${outSum}&InvoiceID=${invoiceId}&Description=Test&SignatureValue=${signature}&Culture=ru`;
    console.log('URL:', url);
    console.log('');

    counter++;
  }
}

console.log(
  'Попробуйте каждый из этих URL. Если какой-то работает, значит проблема была в неправильных учетных данных.',
);
