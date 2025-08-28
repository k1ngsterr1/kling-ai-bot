const crypto = require('crypto');

// Проверяем разные варианты подписи
const merchantLogin = 'kling_tgbot';
const password1 = 'ge2szRg0qJnrl81E0SEe';
const outSum = '100.00';
const invoiceId = '1756360616431'; // Тот же ID что в URL

console.log('=== Проверяем разные варианты подписи ===');
console.log(`Merchant: ${merchantLogin}`);
console.log(`Password1: ${password1}`);
console.log(`OutSum: ${outSum}`);
console.log(`InvoiceID: ${invoiceId}`);
console.log('');

// Вариант 1: Без дополнительных параметров (как в документации)
console.log('--- Вариант 1: Простая подпись ---');
const signature1String = `${merchantLogin}:${outSum}:${invoiceId}:${password1}`;
const signature1 = crypto
  .createHash('md5')
  .update(signature1String)
  .digest('hex')
  .toUpperCase();

console.log('Signature string:', signature1String.replace(password1, '***'));
console.log('Signature:', signature1);

const url1 = `https://auth.robokassa.ru/Merchant/Index.aspx?MerchantLogin=${merchantLogin}&OutSum=${outSum}&InvoiceID=${invoiceId}&Description=Test&SignatureValue=${signature1}`;
console.log('URL:', url1);
console.log('');

// Вариант 2: С Shp_userId как в рабочем коде
console.log('--- Вариант 2: С Shp_userId ---');
const userId = 123;
const signature2String = `${merchantLogin}:${outSum}:${invoiceId}:${password1}:Shp_userId=${userId}`;
const signature2 = crypto
  .createHash('md5')
  .update(signature2String)
  .digest('hex')
  .toUpperCase();

console.log('Signature string:', signature2String.replace(password1, '***'));
console.log('Signature:', signature2);
console.log('Signature из URL:', 'CE90D34A8DBDBF6238117A589479A1E5');
console.log('Совпадают:', signature2 === 'CE90D34A8DBDBF6238117A589479A1E5');
console.log('');

// Вариант 3: С параметром Signature вместо SignatureValue
console.log('--- Вариант 3: С параметром Signature ---');
const url3 = `https://auth.robokassa.ru/Merchant/Index.aspx?MerchantLogin=${merchantLogin}&OutSum=${outSum}&InvoiceID=${invoiceId}&Description=Test&Signature=${signature1}`;
console.log('URL с Signature:', url3);
console.log('');

console.log('=== Попробуйте эти варианты: ===');
console.log('1. Простой без Shp_userId:');
console.log(url1);
console.log('');
console.log('2. С параметром Signature:');
console.log(url3);
