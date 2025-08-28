const crypto = require('crypto-js');

// Настройки как в PHP примере
const merchantLogin = 'kling_tgbot';
const password1 = 'ge2szRg0qJnrl81E0SEe';
const outSum = '100.00';
const invoiceId = '12345';

// Простая формула: MerchantLogin:OutSum:InvoiceID:Password1
const signatureString = `${merchantLogin}:${outSum}:${invoiceId}:${password1}`;

console.log('Signature string:', signatureString.replace(password1, '***'));

const signature = crypto.MD5(signatureString).toString().toUpperCase();

console.log('Signature (MD5):', signature);

// Создаем URL как в PHP
const baseUrl = 'https://auth.robokassa.ru/Merchant/Index.aspx';
const params = new URLSearchParams({
  MerchantLogin: merchantLogin,
  OutSum: outSum,
  InvoiceID: invoiceId,
  Description: 'Test payment',
  Signature: signature,
});

const paymentUrl = `${baseUrl}?${params.toString()}`;

console.log('\nPayment URL:');
console.log(paymentUrl);

console.log('\nURL parameters:');
params.forEach((value, key) => {
  console.log(`${key}: ${value}`);
});
