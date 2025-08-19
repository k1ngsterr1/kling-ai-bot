const jwt = require('jsonwebtoken');

const ak = 'AgYCCpYCmYhhyANmh3mtrf8bQaAe3pTH'; // Access Key
const sk = 'bdJEagGGEfNpbCpCCfELmyTape9AJ9Kr'; // Secret Key

function encodeJwtToken(ak, sk) {
  const headers = {
    alg: 'HS256',
    typ: 'JWT',
  };

  const payload = {
    iss: ak,
    exp: Math.floor(Date.now() / 1000) + 1800, // Current time + 30 minutes
    nbf: Math.floor(Date.now() / 1000) - 5, // Current time - 5 seconds
  };

  const token = jwt.sign(payload, sk, { header: headers });
  return token;
}

const authorization = encodeJwtToken(ak, sk);
console.log('Generated JWT Token:');
console.log(authorization);
console.log('\nAuthorization header:');
console.log(`Bearer ${authorization}`);
