const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../models/User');

jest.setTimeout(60000);

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

afterEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
        await collections[key].deleteMany();
    }
});

describe('User Model & Sub-user limits', () => {
    it('should create an admin with default maxSubUsers equal to 9', async () => {
        const admin = new User({
            telegramId: '123456789',
            role: 'admin'
        });
        await admin.save();

        expect(admin.maxSubUsers).toBe(9);
    });

    it('should allow modifying maxSubUsers', async () => {
        const admin = new User({
            telegramId: '987654321',
            role: 'admin',
            maxSubUsers: 19
        });
        await admin.save();

        expect(admin.maxSubUsers).toBe(19);

        admin.subUsers = ['sub1', 'sub2', 'sub3'];
        await admin.save();

        // Test limit check logic
        expect(admin.subUsers.length).toBeLessThan(admin.maxSubUsers);
    });

    it('should correctly handle unlimited maxSubUsers', async () => {
        const admin = new User({
            telegramId: '111111111',
            role: 'admin',
            maxSubUsers: -1
        });
        await admin.save();

        // Limit check logic: if maxSubUsers === -1, it passes
        const isUnderLimit = admin.maxSubUsers === -1 || admin.subUsers.length < admin.maxSubUsers;
        expect(isUnderLimit).toBe(true);
    });
});
