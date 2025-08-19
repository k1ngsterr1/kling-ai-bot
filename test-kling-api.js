const jwt = require('jsonwebtoken');
const axios = require('axios');

// Your Kling AI credentials
const ACCESS_KEY = 'AgYCCpYCmYhhyANmh3mtrf8bQaAe3pTH';
const SECRET_KEY = 'bdJEagGGEfNpbCpCCfELmyTape9AJ9Kr';

// Function to generate JWT token
function generateJwtToken(accessKey, secretKey) {
  const payload = {
    iss: accessKey,
    exp: Math.floor(Date.now() / 1000) + 1800, // Current time + 30 minutes
    nbf: Math.floor(Date.now() / 1000) - 5, // Current time - 5 seconds
  };

  const headers = {
    alg: 'HS256',
    typ: 'JWT',
  };

  return jwt.sign(payload, secretKey, { header: headers });
}

// Test function
async function testKlingAI() {
  try {
    console.log('🚀 Testing Kling AI API...\n');

    // Generate JWT token
    const token = generateJwtToken(ACCESS_KEY, SECRET_KEY);
    console.log('✅ JWT Token generated:', token.substring(0, 50) + '...\n');

    // Create axios instance
    const client = axios.create({
      baseURL: 'https://api.klingai.com',
      timeout: 60000,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });

    // Test data
    const testRequest = {
      model: 'kling-v-1',
      prompt:
        'A beautiful sunset over the ocean with waves gently crashing on the shore',
      aspect_ratio: '16:9',
      duration: 5,
    };

    console.log('📝 Test request data:', JSON.stringify(testRequest, null, 2));
    console.log('\n🔄 Sending request to Kling AI...\n');

    // Make request
    const response = await client.post('/v1/videos/text2video', testRequest);

    console.log('🎉 SUCCESS! Response from Kling AI:');
    console.log('Status:', response.status);
    console.log('Response data:', JSON.stringify(response.data, null, 2));

    if (response.data.data && response.data.data.task_id) {
      console.log('\n✅ Video generation task created successfully!');
      console.log('Task ID:', response.data.data.task_id);

      // Test different status endpoints
      console.log('\n🔍 Testing different status check endpoints...');

      const statusEndpoints = [
        `/v1/videos/text2video/${response.data.data.task_id}`,
        `/v1/videos/status/${response.data.data.task_id}`,
        `/v1/tasks/${response.data.data.task_id}`,
        `/v1/videos/query/${response.data.data.task_id}`,
        `/v1/videos/text2video/status/${response.data.data.task_id}`,
      ];

      let statusFound = false;
      for (const endpoint of statusEndpoints) {
        try {
          console.log(`\n🔄 Trying endpoint: ${endpoint}`);
          // Generate fresh token for status check
          const freshToken = generateJwtToken(accessKey, secretKey);
          const statusResponse = await axios.get(`${baseURL}${endpoint}`, {
            headers: {
              Authorization: `Bearer ${freshToken}`,
              'Content-Type': 'application/json',
            },
          });

          console.log('✅ SUCCESS! Status check response:');
          console.log('Status:', statusResponse.status);
          console.log(
            'Response data:',
            JSON.stringify(statusResponse.data, null, 2),
          );
          statusFound = true;
          break;
        } catch (statusError) {
          console.log(
            `❌ ERROR for ${endpoint}:`,
            statusError.response?.status || statusError.message,
          );
          if (statusError.response?.data) {
            console.log(
              'Error data:',
              JSON.stringify(statusError.response.data, null, 2),
            );
          }
        }
      }

      if (!statusFound) {
        console.log(
          '\n⚠️ No working status endpoint found, but video generation was successful!',
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

    if (error.request) {
      console.error('Request config:', {
        url: error.config?.url,
        method: error.config?.method,
        headers: error.config?.headers,
        data: error.config?.data,
      });
    }
  }
}

// Run the test
testKlingAI();
