const axios = require('axios');
const jwt = require('jsonwebtoken');

// Use the same keys from your test script
const ACCESS_KEY = 'AgYCCpYCmYhhyANmh3mtrf8bQaAe3pTH';
const SECRET_KEY = 'bdJEagGGEfNpbCpCCfELmyTape9AJ9Kr';

// Get task ID from command line argument
const TARGET_TASK_ID = process.argv[2] || '789627571846647814';

function generateJwtToken() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: ACCESS_KEY,
    exp: now + 1800,
    nbf: now,
  };

  return jwt.sign(payload, SECRET_KEY, {
    algorithm: 'HS256',
    header: { alg: 'HS256', typ: 'JWT' },
    noTimestamp: true,
  });
}

async function fetchTask() {
  const token = generateJwtToken();
  console.log('Using token (first 40 chars):', token.substring(0, 40) + '...');

  try {
    const response = await axios.get(
      'https://api.klingai.com/v1/images/generations',
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { page: 1, size: 50 },
        timeout: 30000,
      },
    );

    if (!response.data || !response.data.data) {
      console.error('Unexpected response shape:', response.data);
      return;
    }

    const tasks = response.data.data;
    const task = tasks.find((t) => t.task_id === TARGET_TASK_ID);

    if (!task) {
      console.log(
        `Task ${TARGET_TASK_ID} not found in the first ${tasks.length} tasks.`,
      );
      // show some nearby task ids for debugging
      console.log(
        'Available task ids (sample):',
        tasks.slice(0, 10).map((t) => t.task_id),
      );
      return;
    }

    console.log('Found task:');
    console.log('  Task ID:', task.task_id);
    console.log('  Status:', task.task_status);
    console.log('  Created At:', new Date(task.created_at).toLocaleString());

    if (
      task.task_result &&
      task.task_result.images &&
      task.task_result.images.length > 0
    ) {
      console.log(`  Images (${task.task_result.images.length}):`);
      task.task_result.images.forEach((img, idx) => {
        console.log(`    [${idx + 1}] ${img.url}`);
      });
    } else {
      console.log('  No result images yet.');
    }
  } catch (err) {
    if (err.response) {
      console.error('API error status:', err.response.status);
      console.error(
        'API response data:',
        JSON.stringify(err.response.data, null, 2),
      );
    } else {
      console.error('Request error:', err.message);
    }
  }
}

fetchTask();
