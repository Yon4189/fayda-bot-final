require('dotenv').config();
const logger = require('../utils/logger');

const requiredEnvVars = [
  'BOT_TOKEN',
  'CAPTCHA_KEY',
  'MONGODB_URI',
  'SESSION_SECRET',
  'REDIS_URL',
  'WEBHOOK_DOMAIN'
];

function validateEnv() {
  const missing = [];
  
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      missing.push(envVar);
    }
  }

  if (missing.length > 0) {
    const msg = [
      `❌ Missing required environment variables: ${missing.join(', ')}.`,
      'Please check your Railway dashboard or .env file.',
      'See ENV_SETUP.md for instructions.'
    ].join('\n');
    throw new Error(msg);
  }

  // Validate formats
  if (process.env.MONGODB_URI && !process.env.MONGODB_URI.startsWith('mongodb')) {
    throw new Error('❌ MONGODB_URI must start with "mongodb://" or "mongodb+srv://"');
  }

  if (process.env.REDIS_URL && !(process.env.REDIS_URL.startsWith('redis') || process.env.REDIS_URL.startsWith('rediss'))) {
    throw new Error('❌ REDIS_URL must start with "redis://" or "rediss://"');
  }

  logger.info('✅ Environment variables validated');
}

module.exports = { validateEnv };
