const IORedis = require('ioredis');
require('dotenv').config();

async function testRedis() {
    console.log('Testing Redis connection to:', process.env.REDIS_URL);
    const redis = new IORedis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => null
    });

    try {
        await redis.ping();
        console.log('✅ Redis PING successful');
        await redis.set('test_key', 'test_value');
        const val = await redis.get('test_key');
        console.log('✅ Redis GET/SET successful:', val);
        process.exit(0);
    } catch (err) {
        console.error('❌ Redis Connection Failed:', err.message);
        process.exit(1);
    }
}

testRedis();
