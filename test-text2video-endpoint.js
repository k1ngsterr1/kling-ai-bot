const axios = require('axios');
const jwt = require('jsonwebtoken');

const accessKey = 'AgYCCpYCmYhhyANmh3mtrf8bQaAe3pTH';
const secretKey = 'bdJEagGGEfNpbCpCCfELmyTape9AJ9Kr';
const baseURL = 'https://api.klingai.com';

function generateJwtToken(accessKey, secretKey) {
  const payload = {
    iss: accessKey,
    exp: Math.floor(Date.now() / 1000) + 1800, // 30 minutes
    nbf: Math.floor(Date.now() / 1000) - 5, // 5 seconds ago
  };

  const token = jwt.sign(payload, secretKey, {
    algorithm: 'HS256',
    header: {
      alg: 'HS256',
      typ: 'JWT',
    },
    noTimestamp: true, // Убираем автоматическое поле iat
  });

  return token;
}

async function testText2VideoEndpoint() {
  console.log('🚀 Testing /v1/videos/text2video endpoint...\n');

  try {
    // 1. Test POST request to create video
    console.log('📝 Step 1: Creating video...');
    const token = generateJwtToken(accessKey, secretKey);

    const createResponse = await axios.post(
      `${baseURL}/v1/videos/text2video`,
      {
        model: 'kling-v-1',
        prompt: 'A cat playing with a ball of yarn',
        aspect_ratio: '16:9',
        duration: 5,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );

    console.log('✅ CREATE SUCCESS!');
    console.log('Response:', JSON.stringify(createResponse.data, null, 2));

    const taskId = createResponse.data.data.task_id;
    console.log(`\n📋 Task ID: ${taskId}`);

    // 2. Test GET request to the same endpoint with task_id
    console.log('\n🔍 Step 2: Testing GET with same endpoint...');

    const freshToken = generateJwtToken(accessKey, secretKey);

    // Try GET request to /v1/videos/text2video with query parameter
    try {
      const getResponse = await axios.get(`${baseURL}/v1/videos/text2video`, {
        headers: {
          Authorization: `Bearer ${freshToken}`,
          'Content-Type': 'application/json',
        },
        params: {
          task_id: taskId,
        },
      });

      console.log('✅ GET with params SUCCESS!');
      console.log('Response:', JSON.stringify(getResponse.data, null, 2));
    } catch (error) {
      console.log('❌ GET with params failed:', error.response?.status);
      if (error.response?.data) {
        console.log(
          'Error data:',
          JSON.stringify(error.response.data, null, 2),
        );
      }
    }

    // 3. Try GET request to /v1/videos/text2video/{task_id}
    console.log('\n🔍 Step 3: Testing GET with task_id in path...');

    try {
      const getPathResponse = await axios.get(
        `${baseURL}/v1/videos/text2video/${taskId}`,
        {
          headers: {
            Authorization: `Bearer ${freshToken}`,
            'Content-Type': 'application/json',
          },
        },
      );

      console.log('✅ GET with path SUCCESS!');
      console.log('Response:', JSON.stringify(getPathResponse.data, null, 2));
    } catch (error) {
      console.log('❌ GET with path failed:', error.response?.status);
      if (error.response?.data) {
        console.log(
          'Error data:',
          JSON.stringify(error.response.data, null, 2),
        );
      }
    }
  } catch (error) {
    console.error('❌ ERROR:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error(
        'Response data:',
        JSON.stringify(error.response.data, null, 2),
      );
    }
  }
}

testText2VideoEndpoint();
