const mongoose = require('mongoose');

const Schema = new mongoose.Schema({
    key: {
        type: String,
        required: true,
        unique: true
    },
    enabled: {
        type: Boolean,
        default: false
    },
    value: {
        type: mongoose.Schema.Types.Mixed
    },
    allowedUsers: [{
        type: String
    }],
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Settings', Schema);
