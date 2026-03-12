const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true, index: true },
  telegramUsername: { type: String, sparse: true, index: true },
  phoneNumber: { type: String, sparse: true, index: true },
  firstName: String,
  lastName: String,
  // admin | user | unauthorized | trial
  role: { type: String, enum: ['admin', 'user', 'unauthorized', 'trial'], default: 'unauthorized', index: true },
  language: { type: String, default: 'en' },
  // For users: telegramId of their admin. For admins: optional (set if added via web dashboard).
  parentAdmin: { type: String, index: true },
  // Legacy alias; we keep subUsers on admin for quick list
  addedBy: { type: String, index: true },
  expiryDate: { type: Date, index: true },
  subUsers: [{ type: String }],
  maxSubUsers: { type: Number, default: 9 },
  // isWaitingApproval removed — pending users are identified by role: 'unauthorized'
  createdAt: { type: Date, default: Date.now, index: true },
  lastActive: { type: Date, index: true },
  usageCount: { type: Number, default: 0 },
  downloadCount: { type: Number, default: 0 },
  archivedSubDownloads: { type: Number, default: 0 },
  lastDownload: { type: Date },
  downloadHistory: [{
    date: { type: String }, // Format: YYYY-MM-DD
    count: { type: Number }
  }]
});

userSchema.index({ role: 1, createdAt: -1 });
userSchema.index({ addedBy: 1, role: 1 });
userSchema.index({ parentAdmin: 1, role: 1 });

module.exports = mongoose.model('User', userSchema);
