// Test script to verify mock image ID handling
const axios = require('axios');

async function testMockImageGeneration() {
  try {
    console.log('🧪 Testing mock image ID handling...');

    // This should create a mock ID if API fails
    const response = await axios.post(
      'http://localhost:3000/telegram/generate-image',
      {
        prompt: 'test image',
        aspectRatio: '1:1',
        resolution: '2k',
      },
    );

    console.log('📝 Generated response:', response.data);

    // If we get a mock ID (IG-XXXX), test status checking
    if (response.data.id && response.data.id.startsWith('IG-')) {
      console.log('🎭 Mock ID detected:', response.data.id);

      // Test status checking
      setTimeout(async () => {
        try {
          const statusResponse = await axios.get(
            `http://localhost:3000/telegram/image-status/${response.data.id}`,
          );
          console.log('📊 Status response:', statusResponse.data);
        } catch (error) {
          console.error('❌ Status check failed:', error.message);
        }
      }, 2000);
    }
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testMockImageGeneration();
