const IORedis = require('ioredis');
const redis = new IORedis('redis://127.0.0.1:6379');

console.log('Testing LOCAL Redis connection...');

redis.ping().then(res => {
  console.log('✅ Local Redis PING successful:', res);
  process.exit(0);
}).catch(err => {
  console.error('❌ Local Redis Connection Failed:', err.message);
  process.exit(1);
});
