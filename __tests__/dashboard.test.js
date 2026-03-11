const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

jest.setTimeout(60000);

// ── Set ALL required env variables BEFORE any require ──
process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = '12345:dummy_token';
process.env.CAPTCHA_KEY = 'test_captcha_key';
process.env.MONGODB_URI = 'mongodb://localhost:27017/test'; // placeholder, replaced in beforeAll
process.env.SESSION_SECRET = 'testsecret';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.WEBHOOK_DOMAIN = 'https://test.example.com';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASS = 'testpassword';

// ── Mock ioredis ──
jest.mock('ioredis', () => {
    return jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        ping: jest.fn().mockResolvedValue('PONG'),
        incr: jest.fn().mockResolvedValue(1),
        expire: jest.fn().mockResolvedValue(1),
        ttl: jest.fn().mockResolvedValue(60),
        quit: jest.fn().mockResolvedValue('OK'),
        defineCommand: jest.fn(),
        decr: jest.fn().mockResolvedValue(0),
        del: jest.fn().mockResolvedValue(1)
    }));
});

// ── Mock bull (PDF queue) ──
jest.mock('bull', () => {
    return jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        process: jest.fn(),
        add: jest.fn().mockResolvedValue({ id: '1' }),
        close: jest.fn().mockResolvedValue(),
        pause: jest.fn().mockResolvedValue(),
        resume: jest.fn().mockResolvedValue()
    }));
});

// ── Mock connect-mongo (session store) ──
jest.mock('connect-mongo', () => ({
    create: jest.fn(() => {
        // Return a minimal in-memory store compatible with express-session
        const session = require('express-session');
        return new session.MemoryStore();
    })
}));

let mongoServer;
let app, bot;
let User, Broadcast, Settings;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongoServer.getUri();

    // Connect mongoose to in-memory DB
    await mongoose.connect(process.env.MONGODB_URI);

    // Require index.js AFTER env setup + mocks
    const index = require('../index.js');
    app = index.app;
    bot = index.bot;

    User = require('../models/User');
    Broadcast = require('../models/Broadcast');
    Settings = require('../models/Settings');

    // Mock Telegram bot methods
    bot.telegram.sendMessage = jest.fn().mockResolvedValue({ message_id: 123 });
    bot.telegram.setWebhook = jest.fn().mockResolvedValue(true);
    bot.telegram.deleteMessage = jest.fn().mockResolvedValue(true);
});

afterAll(async () => {
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
});

afterEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
        await collections[key].deleteMany();
    }
    jest.clearAllMocks();
    // Re-apply mocks since clearAllMocks wipes them
    bot.telegram.sendMessage = jest.fn().mockResolvedValue({ message_id: 123 });
    bot.telegram.deleteMessage = jest.fn().mockResolvedValue(true);
});

// ── Helper: get an authenticated session cookie ──
async function login() {
    const res = await request(app)
        .post('/login')
        .send({ username: 'admin', password: 'testpassword' });
    return res.headers['set-cookie'];
}

// ═══════════════ Tests ═══════════════

describe('Web Dashboard & Maintenance Modes', () => {
    let sessionCookie;

    beforeEach(async () => {
        sessionCookie = await login();
    });

    it('should update maxSubUsers limit via POST /buyer/:id/update-max-subs', async () => {
        const admin = new User({ telegramId: '999', role: 'admin', maxSubUsers: 9 });
        await admin.save();

        const res = await request(app)
            .post('/buyer/999/update-max-subs')
            .set('Cookie', sessionCookie)
            .send({ maxSubUsers: 25 });

        // Should redirect on success
        expect(res.status).toBe(302);

        const updatedAdmin = await User.findOne({ telegramId: '999' });
        expect(updatedAdmin.maxSubUsers).toBe(25);
        expect(bot.telegram.sendMessage).toHaveBeenCalled();
    });

    it('should toggle maintenance mode via POST /maintenance/toggle', async () => {
        // Initial state: not created
        let setting = await Settings.findOne({ key: 'maintenance' });
        expect(setting).toBeNull();

        // Toggle on
        await request(app)
            .post('/maintenance/toggle')
            .set('Cookie', sessionCookie);

        setting = await Settings.findOne({ key: 'maintenance' });
        expect(setting.enabled).toBe(true);

        // Toggle off — re-login since redirect may invalidate session
        sessionCookie = await login();
        await request(app)
            .post('/maintenance/toggle')
            .set('Cookie', sessionCookie);

        setting = await Settings.findOne({ key: 'maintenance' });
        expect(setting.enabled).toBe(false);
    });

    it('should add a bypass user via POST /maintenance/add-bypass', async () => {
        // First create a maintenance setting
        await Settings.create({ key: 'maintenance', enabled: true, allowedUsers: [] });

        await request(app)
            .post('/maintenance/add-bypass')
            .set('Cookie', sessionCookie)
            .send({ telegramId: '12345' });

        const setting = await Settings.findOne({ key: 'maintenance' });
        expect(setting.allowedUsers).toContain('12345');
    });
});

describe('Broadcasting System', () => {
    let sessionCookie;

    beforeEach(async () => {
        sessionCookie = await login();
    });

    it('should create a broadcast record via POST /broadcast/send', async () => {
        // Create active users
        await User.insertMany([
            { telegramId: '101', role: 'admin' },
            { telegramId: '102', role: 'user' },
            { telegramId: '103', role: 'unauthorized' } // Should not receive
        ]);

        const res = await request(app)
            .post('/broadcast/send')
            .set('Cookie', sessionCookie)
            .send({ message: 'Hello test!' });

        expect(res.status).toBe(302);

        const broadcasts = await Broadcast.find({});
        expect(broadcasts.length).toBe(1);
        expect(broadcasts[0].message).toBe('Hello test!');
        expect(broadcasts[0].totalRecipients).toBe(2); // Only 101 and 102

        // Wait for async send loop
        await new Promise(r => setTimeout(r, 500));

        expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(2);
    });

    it('should clear a broadcast via POST /broadcast/:id/clear', async () => {
        const bc = await Broadcast.create({
            message: 'test',
            sentBy: 'Admin',
            totalRecipients: 1,
            status: 'completed'
        });

        await request(app)
            .post(`/broadcast/${bc._id}/clear`)
            .set('Cookie', sessionCookie);

        const count = await Broadcast.countDocuments();
        expect(count).toBe(0);
    });
});

describe('Sub-user limit enforcement on web dashboard', () => {
    let sessionCookie;

    beforeEach(async () => {
        sessionCookie = await login();
    });

    it('should reject adding sub-user when limit reached', async () => {
        // Create admin at max capacity (2 subs, limit 2)
        await User.create({ telegramId: '500', role: 'admin', maxSubUsers: 2, subUsers: ['501', '502'] });
        await User.create({ telegramId: '503', role: 'unauthorized' }); // new candidate

        const res = await request(app)
            .post('/buyer/500/add-sub')
            .set('Cookie', sessionCookie)
            .send({ identifier: '503' });

        // Should redirect with error=full
        expect(res.headers.location).toContain('error=full');
    });

    it('should allow adding sub-user when unlimited (-1)', async () => {
        await User.create({ telegramId: '600', role: 'admin', maxSubUsers: -1, subUsers: ['601', '602', '603'] });
        await User.create({ telegramId: '604', role: 'unauthorized' });

        const res = await request(app)
            .post('/buyer/600/add-sub')
            .set('Cookie', sessionCookie)
            .send({ identifier: '604' });

        // Should succeed (redirect without error=full)
        expect(res.headers.location).not.toContain('error=full');

        const admin = await User.findOne({ telegramId: '600' });
        expect(admin.subUsers).toContain('604');
    });
});
