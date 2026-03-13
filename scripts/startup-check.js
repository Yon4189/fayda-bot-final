const mongoose = require('mongoose');
const Redis = require('ioredis');
const { validateEnv } = require('../config/env');
const logger = require('../utils/logger');

async function runCheck() {
  console.log('--- Fayda Bot Startup Diagnostic ---\n');

  // 1. Check Environment
  console.log('Step 1: Validating Environment Variables...');
  try {
    validateEnv();
    console.log('✅ Environment variables OK\n');
  } catch (err) {
    console.error('❌ Environment validation failed:');
    console.error(err.message);
    console.log('\nPlease fix your environment variables before continuing.\n');
    process.exit(1);
  }

  // 2. Check MongoDB
  console.log('Step 2: Testing MongoDB Connection...');
  try {
    const mongoUri = process.env.MONGODB_URI;
    console.log(`Connecting to: ${mongoUri.split('@')[1] || 'localDB'}`);
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
    console.log('✅ MongoDB connection successful\n');
    await mongoose.disconnect();
  } catch (err) {
    console.error('❌ MongoDB connection failed:');
    console.error(err.message);
    console.log('\nTIP: Ensure your MongoDB cluster is active and IP whitelisting (0.0.0.0/0) is enabled.\n');
  }

  // 3. Check Redis
  console.log('Step 3: Testing Redis Connection...');
  try {
    const redisUrl = process.env.REDIS_URL;
    const redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      retryStrategy: () => null // Don't retry
    });

    await new Promise((resolve, reject) => {
      redis.on('ready', resolve);
      redis.on('error', reject);
      setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });

    console.log('✅ Redis connection successful\n');
    await redis.quit();
  } catch (err) {
    console.error('❌ Redis connection failed:');
    console.error(err.message);
    console.log('\nTIP: Use Upstash or Railway Redis and ensure the URL includes the password.\n');
  }

  // 4. Check Bot Token
  console.log('Step 4: Testing Telegram Bot Token...');
  const { Telegraf } = require('telegraf');
  const bot = new Telegraf(process.env.BOT_TOKEN);
  try {
    const me = await bot.telegram.getMe();
    console.log(`✅ Bot Token OK: @${me.username}\n`);
  } catch (err) {
    console.error('❌ Telegram Bot Token failed:');
    console.error(err.message);
  }

  console.log('--- Diagnostic Complete ---');
  process.exit(0);
}

runCheck().catch(err => {
  console.error('Diagnostic crashed:', err);
  process.exit(1);
});
