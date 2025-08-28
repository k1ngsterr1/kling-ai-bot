const crypto = require('crypto-js');

class TestRobokassaService {
  constructor() {
    this.merchantLogin = 'kling_tgbot';
    this.password1 = 'ge2szRg0qJnrl81E0SEe';
    this.password2 = 'EJ8rKq4mtHbr65eP4LWV';
    this.baseUrl = 'https://auth.robokassa.ru/Merchant/Index.aspx';
    this.testMode = false;
  }

  generatePaymentSignature(amount, invoiceId) {
    // Простая формула как в PHP примере: MerchantLogin:OutSum:InvoiceID:Password1
    const signatureString = `${this.merchantLogin}:${amount}:${invoiceId}:${this.password1}`;

    console.log(
      'Payment signature string:',
      signatureString.replace(this.password1, '***'),
    );

    const signature = crypto.MD5(signatureString).toString().toUpperCase();

    console.log('Payment signature:', signature);

    return signature;
  }

  createPaymentUrl(amount, userId) {
    const invoiceId = Date.now(); // Уникальный ID платежа
    const signature = this.generatePaymentSignature(
      amount.toString(),
      invoiceId.toString(),
    );

    const params = new URLSearchParams({
      MerchantLogin: this.merchantLogin,
      OutSum: amount.toString(),
      InvoiceID: invoiceId.toString(),
      Description: `Покупка ${amount} токенов`,
      Signature: signature,
    });

    const paymentUrl = `${this.baseUrl}?${params.toString()}`;

    console.log('\nGenerated payment URL:');
    console.log(paymentUrl);

    console.log('\nURL parameters:');
    params.forEach((value, key) => {
      console.log(`${key}: ${value}`);
    });

    return {
      paymentUrl,
      invoiceId,
      signature,
    };
  }
}

// Тестируем
const service = new TestRobokassaService();
const result = service.createPaymentUrl(100, 123);

console.log('\nТест завершен. Попробуйте открыть URL в браузере:');
console.log(result.paymentUrl);
