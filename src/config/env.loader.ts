import { config } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

export function loadEnvironmentVariables() {
  const envPaths = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '.env.local'),
    resolve(process.cwd(), '.env.production'),
    resolve(__dirname, '../../.env'),
    resolve(__dirname, '../../../.env'),
  ];

  console.log('🔍 Looking for .env files in paths:');
  envPaths.forEach((path) => {
    const exists = existsSync(path);
    console.log(`  ${exists ? '✅' : '❌'} ${path}`);
    if (exists) {
      const result = config({ path });
      console.log(
        `  📋 Loaded ${Object.keys(result.parsed || {}).length} variables`,
      );
    }
  });

  // Force load from the most likely location
  const mainEnvPath = resolve(process.cwd(), '.env');
  if (existsSync(mainEnvPath)) {
    console.log(`🔄 Force loading from: ${mainEnvPath}`);
    config({ path: mainEnvPath, override: true });
  }
}
