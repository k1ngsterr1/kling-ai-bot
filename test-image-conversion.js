const axios = require('axios');

// Test function to verify image conversion
async function testImageConversion() {
  try {
    // Test with a small sample image URL (replace with actual Telegram file URL)
    const testUrl = 'https://via.placeholder.com/150/0000FF/FFFFFF?text=Test';

    console.log('Testing image conversion...');

    const response = await axios.get(testUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    const base64 = Buffer.from(response.data, 'binary').toString('base64');
    const contentType = response.headers['content-type'] || 'image/png';
    const dataUrl = `data:${contentType};base64,${base64}`;

    console.log('✅ Image conversion successful');
    console.log('Content type:', contentType);
    console.log('Base64 length:', base64.length);
    console.log('Data URL preview:', dataUrl.substring(0, 100) + '...');

    return true;
  } catch (error) {
    console.error('❌ Image conversion failed:', error.message);
    return false;
  }
}

// Run the test
testImageConversion().then((success) => {
  console.log(success ? '✅ Test passed' : '❌ Test failed');
  process.exit(success ? 0 : 1);
});
