const mongoose = require('mongoose');
const logger = require('../utils/logger');

const options = {
  maxPoolSize: 50, // Maintain up to 50 socket connections
  minPoolSize: 5, // Maintain at least 5 socket connections
  serverSelectionTimeoutMS: 30000, // Keep trying to send operations for 30 seconds
  socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
  // bufferMaxEntries and bufferCommands are deprecated in Mongoose 8+
  // Mongoose handles buffering automatically now
};

let isConnected = false;

async function connectDB() {
  if (isConnected) {
    return;
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI, options);
    isConnected = true;
    logger.info('✅ MongoDB connected successfully');

    mongoose.connection.on('error', (err) => {
      logger.error('MongoDB connection error:', err);
      isConnected = false;
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected');
      isConnected = false;
    });

    mongoose.connection.on('reconnected', () => {
      logger.info('MongoDB reconnected');
      isConnected = true;
    });

  } catch (error) {
    logger.error('❌ MongoDB connection error:', error);
    isConnected = false;
    throw error;
  }
}

async function disconnectDB() {
  if (!isConnected) return;
  try {
    await mongoose.disconnect();
    isConnected = false;
    logger.info('MongoDB disconnected');
  } catch (error) {
    logger.error('Error disconnecting MongoDB:', error);
  }
}

module.exports = { connectDB, disconnectDB, isConnected: () => isConnected };
