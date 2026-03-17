require('dotenv').config();
// ---------- Keep process alive on unhandled errors (log and continue) ----------
const logger = require('./utils/logger');
process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Unhandled Rejection at', reason);
  logger.error('Unhandled Rejection at', { reason, stack: reason?.stack });
});
process.on('uncaughtException', (err) => {
  console.error('CRITICAL: Uncaught Exception', err.message);
  logger.error('Uncaught Exception', { message: err.message, stack: err.stack });
  
  // If we haven't even started listening yet, we MUST exit
  if (err.code === 'EADDRINUSE' || !isInitialized) {
    logger.error('Fatal startup error, exiting.');
    process.exit(1);
  }
});

// Environment validation and configuration
const { validateEnv } = require('./config/env');
try {
  logger.info('🔍 Validating environment variables...');
  validateEnv();
} catch (err) {
  logger.error('❌ Environment validation failed:', err.message);
  console.error('\n' + '='.repeat(50));
  console.error('ERROR: Missing or invalid environment variables');
  console.error(err.message);
  console.error('='.repeat(50) + '\n');
  process.exit(1);
}

const express = require('express');
const crypto = require('crypto');
const helmet = require('helmet');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const FaydaAppClient = require('./utils/faydaAppClient');
const faydaApp = process.env.FAYDA_APP_API_KEY ? new FaydaAppClient(process.env.FAYDA_APP_API_KEY) : null;
const SIMULATION_MODE = process.env.SIMULATION_MODE === 'true';

if (SIMULATION_MODE) {
  logger.info('🚀 SIMULATION_MODE is ENABLED. All Fayda API calls will be mocked.');
} else if (!faydaApp) {
  logger.warn('⚠️ FAYDA_APP_API_KEY is missing. Using CAPTCHA Fallback flow.');
}

const { buildFaydaPdf } = require('./utils/pdfBuilder');
const fayda = require('./utils/faydaClient'); // Kept for legacy routes if any
const { Markup } = require('telegraf');

const bot = require('./bot');
const User = require('./models/User');
const Broadcast = require('./models/Broadcast');
const Settings = require('./models/Settings');
// auth middleware removed — authorization is handled inline in bot.use()
const { connectDB, disconnectDB } = require('./config/database');
const { apiLimiter, checkUserRateLimit } = require('./utils/rateLimiter');
const { validateFaydaId, validateOTP, escMd, displayName } = require('./utils/validators');
const { parsePdfResponse } = require('./utils/pdfHelper');
const SolveCaptcha = require('./utils/solveCaptcha');
const { t } = require('./utils/i18n');
const { getReplyKeyboard, getPanelTitle, paginate, getMainMenu } = require('./utils/menu');
const { migrateRoles } = require('./utils/migrateRoles');
const pdfQueue = require('./queue');
const { safeResponseForLog } = require('./utils/logger');
const { DownloadTimer } = require('./utils/timer');

async function incrementUserDownload(telegramId) {
  const userDoc = await User.findOne({ telegramId });
  if (userDoc) {
    userDoc.downloadCount = (userDoc.downloadCount || 0) + 1;
    userDoc.lastDownload = new Date();
    const today = new Date().toISOString().split('T')[0];
    const history = userDoc.downloadHistory || [];
    const todayIndex = history.findIndex(h => h.date === today);
    if (todayIndex >= 0) {
      history[todayIndex].count += 1;
    } else {
      history.push({ date: today, count: 1 });
    }
    userDoc.downloadHistory = history;
    await userDoc.save();
  }
}

const fs = require('fs');
const PDF_SYNC_ATTEMPTS = 2;
const PDF_SYNC_RETRY_DELAY_MS = 2000;
const VERIFICATION_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between verification attempts

// Per-user download lock — prevents concurrent downloads and webhook replay storms
const activeDownloads = new Map(); // telegramId → true
// Per-user verification cooldown — prevents OTP flood on Fayda API
const verificationCooldown = new Map(); // telegramId → timestamp of last failure
// Lazy pre-solve: captcha solve starts when user taps Download
const pendingCaptchas = new Map(); // telegramId → Promise<string>
// Deferred verification: captcha+verify runs in background
const pendingVerifications = new Map(); // telegramId → Promise<{success, token, error, timer}>
// Global lock for OTP processing
const processingOTPs = new Set(); // Prevent duplicate OTP processing

// ---------- Express App ----------
const app = express();
app.set('trust proxy', 1); // Trust first proxy (Railway / reverse proxy)

// Security headers
app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled for EJS inline styles
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    ttl: 24 * 60 * 60 // 24 hours
  }),
  cookie: {
    maxAge: 1000 * 60 * 60 * 24,
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true
  }
}));
app.set('view engine', 'ejs');

// Simple session-based CSRF protection (no third-party library needed)
function csrfToken(req) {
  if (!req.session._csrf) {
    req.session._csrf = crypto.randomBytes(32).toString('hex');
  }
  return req.session._csrf;
}
function csrfProtection(req, res, next) {
  if (req.path === '/webhook') return next(); // Telegram webhook excluded
  if (req.method === 'POST') {
    const token = req.body._csrf || req.headers['x-csrf-token'];
    if (!token || token !== req.session._csrf) {
      return res.status(403).send('Invalid or missing CSRF token. Please refresh the page and try again.');
    }
  }
  next();
}
if (process.env.NODE_ENV !== 'test') {
  app.use(csrfProtection);
}
// Make CSRF token available to all EJS views
app.use((req, res, next) => {
  res.locals.csrfToken = csrfToken(req);
  next();
});

// Health check endpoint (simple – for load balancers)
app.get('/health', (req, res) => {
  res.json({
    status: isInitialized ? 'ok' : 'initializing',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    initialized: isInitialized
  });
});

// Deep health (MongoDB + Redis) – for monitoring / zero-failure setups
const { redisClient } = require('./utils/rateLimiter');
app.get('/health/ready', async (req, res) => {
  const mongodb = await (async () => {
    try {
      const mongoose = require('mongoose');
      return mongoose.connection.readyState === 1 ? 'ok' : 'disconnected';
    } catch (e) {
      return 'error';
    }
  })();
  let redis = 'ok';
  try {
    await redisClient.ping();
  } catch (e) {
    redis = 'error';
  }
  const ok = mongodb === 'ok' && redis === 'ok';
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb,
    redis
  });
});

// Apply rate limiting to API routes
if (process.env.NODE_ENV !== 'test') {
  app.use('/api', apiLimiter);
}

// Login brute-force protection (5 attempts per 15 min per IP)
const loginLimiter = require('express-rate-limit')({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many login attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// ---------- Web Dashboard (Admin Management) ----------
// Wrap async route handlers so thrown errors reach the Express error handler
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const requireWebAuth = (req, res, next) => {
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) return res.status(503).send('Admin dashboard not configured. Set ADMIN_USER and ADMIN_PASS.');
  if (req.session && req.session.admin) return next();
  res.redirect('/login');
};
app.get('/login', (req, res) => {
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) {
    return res.status(503).send('Admin dashboard not configured. Set ADMIN_USER and ADMIN_PASS in environment.');
  }
  const errorMap = { invalid: 'Invalid credentials' };
  res.render('login', { error: errorMap[req.query.error] });
});
app.post('/login', process.env.NODE_ENV === 'test' ? (req, res, next) => next() : loginLimiter, (req, res) => {
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) {
    return res.status(503).send('Admin dashboard not configured.');
  }
  const { username, password } = req.body;
  // Timing-safe comparison to prevent timing attacks
  const userBuf = Buffer.from(String(username || ''));
  const passBuf = Buffer.from(String(password || ''));
  const expectedUserBuf = Buffer.from(process.env.ADMIN_USER);
  const expectedPassBuf = Buffer.from(process.env.ADMIN_PASS);
  const userMatch = userBuf.length === expectedUserBuf.length && crypto.timingSafeEqual(userBuf, expectedUserBuf);
  const passMatch = passBuf.length === expectedPassBuf.length && crypto.timingSafeEqual(passBuf, expectedPassBuf);
  if (userMatch && passMatch) {
    // Regenerate session to prevent session fixation
    req.session.regenerate((err) => {
      if (err) {
        logger.error('Session regeneration failed:', err);
        return res.render('login', { error: 'Server error. Try again.' });
      }
      req.session.admin = true;
      res.redirect('/dashboard');
    });
  } else {
    res.render('login', { error: 'Invalid credentials' });
  }
});
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});
app.get('/dashboard', requireWebAuth, asyncHandler(async (req, res) => {
  const admins = await User.find({ role: 'admin' }).sort({ createdAt: -1 }).lean();
  const allSubIds = admins.flatMap(b => b.subUsers || []);
  const subs = await User.find({ telegramId: { $in: allSubIds } }).select('telegramId downloadCount').lean();
  const subMap = new Map(subs.map(s => [s.telegramId, s.downloadCount || 0]));
  const revokedCount = await User.countDocuments({ role: 'admin', expiryDate: { $lt: new Date() } });
  const stats = {
    totalUsers: await User.countDocuments(),
    admins: admins.length,
    subUsers: allSubIds.length,
    expiringSoon: await User.countDocuments({ expiryDate: { $lt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), $gt: new Date() }, role: { $in: ['admin', 'user'] } }),
    totalDownloads: admins.reduce((s, b) => s + (b.downloadCount || 0) + (b.archivedSubDownloads || 0), 0) + subs.reduce((s, u) => s + (u.downloadCount || 0), 0),
    revokedCount
  };
  const enriched = admins.map(b => {
    const subIds = b.subUsers || [];
    const subDownloads = subIds.reduce((sum, id) => sum + (subMap.get(id) || 0), 0);
    const archived = b.archivedSubDownloads || 0;
    return { ...b, subDownloads, archived, totalDownloads: (b.downloadCount || 0) + subDownloads + archived };
  });

  // Get maintenance setting
  let maintenance = await Settings.findOne({ key: 'maintenance' }).lean();
  if (!maintenance) {
    maintenance = { enabled: false, allowedUsers: [] };
  }

  // Get public mode setting
  let publicMode = await Settings.findOne({ key: 'publicMode' }).lean();
  if (!publicMode) {
    publicMode = { enabled: false, value: 5 };
  }

  res.render('dashboard', { stats, admins: enriched, maintenance, publicMode, error: req.query.error });
}));

// ---------- Public Mode ----------
app.get('/public', requireWebAuth, asyncHandler(async (req, res) => {
  const trialUsers = await User.find({ role: 'trial' }).sort({ createdAt: -1 }).lean();
  let publicMode = await Settings.findOne({ key: 'publicMode' }).lean();
  if (!publicMode) {
    publicMode = { enabled: false, value: 5 };
  }
  res.render('public', { trialUsers, publicMode });
}));

app.post('/public-mode/toggle', requireWebAuth, asyncHandler(async (req, res) => {
  const { downloadLimit, action } = req.body;
  let setting = await Settings.findOne({ key: 'publicMode' });
  if (!setting) {
    setting = new Settings({ key: 'publicMode', value: 5, enabled: false });
  }

  if (action === 'toggle') {
    setting.enabled = !setting.enabled;
  } else if (action === 'update_limit') {
    setting.value = parseInt(downloadLimit) || 5;
  }
  
  await setting.save();
  res.redirect('/dashboard');
}));

app.get('/pending', requireWebAuth, asyncHandler(async (req, res) => {
  const pending = await User.find({ role: 'unauthorized' }).sort({ lastActive: -1 }).limit(50).lean();
  res.render('pending', { pending });
}));

// ---------- Maintenance Mode ----------
app.post('/maintenance/toggle', requireWebAuth, asyncHandler(async (req, res) => {
  let setting = await Settings.findOne({ key: 'maintenance' });
  if (!setting) {
    setting = new Settings({ key: 'maintenance' });
  }
  setting.enabled = !setting.enabled;
  await setting.save();

  // Notify all active users of the mode switch
  const activeUsers = await User.find({ role: { $ne: 'unauthorized' } }).select('telegramId language role').lean();
  for (const u of activeUsers) {
    try {
      const uLang = u.language || 'en';
      if (!setting.enabled) {
        // Turned OFF: Notify and restore the user's role-based menu keyboard
        await bot.telegram.sendMessage(u.telegramId, t('maintenance_off_msg', uLang), { 
          parse_mode: 'Markdown',
          ...getReplyKeyboard(u.role, uLang)
        });
      } else {
        // Turned ON: Notify users that maintenance is now active
        await bot.telegram.sendMessage(u.telegramId, t('maintenance_mode_msg', uLang), { 
          parse_mode: 'Markdown',
          ...Markup.removeKeyboard() 
        });
      }
    } catch (err) { }
  }

  res.redirect('/dashboard');
}));

app.post('/maintenance/add-bypass', requireWebAuth, asyncHandler(async (req, res) => {
  const { telegramId } = req.body;
  if (!telegramId || !/^\d+$/.test(String(telegramId).trim())) {
    return res.redirect('/dashboard?error=invalid_id');
  }
  await Settings.updateOne(
    { key: 'maintenance' },
    { $addToSet: { allowedUsers: telegramId.trim() } },
    { upsert: true }
  );
  res.redirect('/dashboard');
}));

app.post('/maintenance/remove-bypass/:id', requireWebAuth, asyncHandler(async (req, res) => {
  await Settings.updateOne(
    { key: 'maintenance' },
    { $pull: { allowedUsers: req.params.id } }
  );
  res.redirect('/dashboard');
}));

app.post('/pending/remove/:id', requireWebAuth, asyncHandler(async (req, res) => {
  await User.deleteOne({ telegramId: req.params.id, role: 'unauthorized' });
  res.redirect('/pending');
}));
app.post('/add-buyer', requireWebAuth, asyncHandler(async (req, res) => {
  const { telegramId, expiryDays = 30, maxSubUsers = 9 } = req.body;
  if (!telegramId || !/^\d+$/.test(String(telegramId).trim())) {
    return res.redirect('/dashboard?error=invalid_id');
  }
  const tid = String(telegramId).trim();
  let user = await User.findOne({ telegramId: tid });
  if (!user) {
    return res.redirect('/dashboard?error=user_must_start');
  }
  if (user.role === 'admin') {
    return res.redirect('/dashboard?error=already_added');
  }
  if (user.addedBy) await User.updateOne({ telegramId: user.addedBy }, { $pull: { subUsers: tid } });
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + (parseInt(expiryDays) || 30));
  user.role = 'admin';
  user.addedBy = undefined;
  user.expiryDate = expiry;
  user.subUsers = [];
  user.maxSubUsers = parseInt(maxSubUsers) || 9;
  await user.save();
  try {
    const uLang = user.language || 'en';
    await bot.telegram.sendMessage(tid, t('activated', uLang), { parse_mode: 'Markdown' });
    await bot.telegram.sendMessage(tid, getPanelTitle(user.role, uLang), { parse_mode: 'Markdown', ...getReplyKeyboard(user.role, uLang) });
  } catch (e) { logger.warn('Could not notify new admin:', e.message); }
  res.redirect('/dashboard');
}));
app.get('/buyer/:id', requireWebAuth, asyncHandler(async (req, res) => {
  const buyer = await User.findOne({ telegramId: req.params.id });
  if (!buyer) return res.status(404).send('Not found');
  const subs = await User.find({ telegramId: { $in: buyer.subUsers || [] } }).lean();
  const subUsersTotal = subs.reduce((s, u) => s + (u.downloadCount || 0), 0);
  const archived = buyer.archivedSubDownloads || 0;
  const totalDownloads = (buyer.downloadCount || 0) + subUsersTotal + archived;
  res.render('buyer-detail', { buyer, subs, buyerOwn: buyer.downloadCount || 0, subUsersTotal, archived, totalDownloads, error: req.query.error });
}));
app.post('/buyer/:id/add-sub', requireWebAuth, asyncHandler(async (req, res) => {
  const { identifier, expiryDays } = req.body;
  const tid = String(identifier).trim().replace(/\s/g, '');
  if (!/^\d+$/.test(tid)) return res.redirect(`/buyer/${req.params.id}?error=invalid_id`);
  const buyer = await User.findOne({ telegramId: req.params.id });
  if (!buyer) return res.redirect('/dashboard');
  let subUser = await User.findOne({ telegramId: tid });
  if (!subUser) return res.redirect(`/buyer/${req.params.id}?error=must_start`);
  if (subUser.role === 'admin') return res.redirect(`/buyer/${req.params.id}?error=already_admin`);

  const currentSubsCount = (buyer.subUsers || []).length;
  const maxSubs = typeof buyer.maxSubUsers === 'number' ? buyer.maxSubUsers : 9;
  if (maxSubs !== -1 && currentSubsCount >= maxSubs) {
    return res.redirect(`/buyer/${req.params.id}?error=full`);
  }

  if ((buyer.subUsers || []).includes(tid)) return res.redirect(`/buyer/${req.params.id}?error=already`);
  buyer.subUsers = buyer.subUsers || [];
  buyer.subUsers.push(tid);
  await buyer.save();
  subUser.role = 'user';
  subUser.addedBy = buyer.telegramId;
  subUser.parentAdmin = buyer.telegramId;
  const days = parseInt(expiryDays) || 30;
  const subExpiry = new Date();
  subExpiry.setDate(subExpiry.getDate() + days);
  subUser.expiryDate = subExpiry;

  await subUser.save();
  try {
    const uLang = subUser.language || 'en';
    await bot.telegram.sendMessage(tid, t('activated', uLang), { parse_mode: 'Markdown' });
    await bot.telegram.sendMessage(tid, getPanelTitle('user', uLang), { parse_mode: 'Markdown', ...getReplyKeyboard('user', uLang) });
  } catch (e) { logger.warn('Could not notify new sub-user:', e.message); }
  res.redirect(`/buyer/${req.params.id}`);
}));
app.post('/buyer/:id/update-max-subs', requireWebAuth, asyncHandler(async (req, res) => {
  const buyerId = req.params.id;
  const { maxSubUsers } = req.body;
  const limit = parseInt(maxSubUsers);

  if (isNaN(limit) || limit < -1) {
    return res.redirect(`/buyer/${buyerId}?error=invalid_limit`);
  }

  const buyer = await User.findOne({ telegramId: buyerId });
  if (!buyer) return res.redirect('/dashboard');

  buyer.maxSubUsers = limit;
  await buyer.save();

  try {
    const limitText = limit === -1 ? 'Unlimited' : limit;
    const msg = `ℹ️ Your maximum sub-users limit has been updated to: *${limitText}*`;
    await bot.telegram.sendMessage(buyerId, msg, { parse_mode: 'Markdown' });
  } catch (e) {
    logger.warn('Could not notify admin of sub-user limit change:', e.message);
  }

  res.redirect(`/buyer/${buyerId}`);
}));

app.post('/buyer/:buyerId/remove-sub/:subId', requireWebAuth, asyncHandler(async (req, res) => {
  // Archive sub-user downloads before deletion so billing total is preserved
  const sub = await User.findOne({ telegramId: req.params.subId }).select('downloadCount').lean();
  const dlCount = sub?.downloadCount || 0;
  await User.updateOne({ telegramId: req.params.buyerId }, {
    $pull: { subUsers: req.params.subId },
    $inc: { archivedSubDownloads: dlCount }
  });
  await User.deleteOne({ telegramId: req.params.subId });
  res.redirect(`/buyer/${req.params.buyerId}`);
}));
app.post('/buyer/:id/remove', requireWebAuth, asyncHandler(async (req, res) => {
  const buyer = await User.findOne({ telegramId: req.params.id });
  if (!buyer) return res.redirect('/dashboard');

  // Archive sub-user downloads before demoting admin
  if (buyer.subUsers && buyer.subUsers.length > 0) {
    const subs = await User.find({ telegramId: { $in: buyer.subUsers } }).select('downloadCount').lean();
    const totalSubDl = subs.reduce((sum, s) => sum + (s.downloadCount || 0), 0);
    buyer.archivedSubDownloads = (buyer.archivedSubDownloads || 0) + totalSubDl;
  }

  buyer.role = 'unauthorized';
  buyer.addedBy = undefined;
  buyer.expiryDate = undefined;

  // Apply cascading deletion for the sub-users
  const subUserIds = buyer.subUsers || [];
  buyer.subUsers = [];
  await buyer.save();

  if (subUserIds.length > 0) {
    await User.deleteMany({ telegramId: { $in: subUserIds } });
  }

  res.redirect('/dashboard');
}));

// ---------- Clear Download Summary ----------
app.post('/buyer/:id/clear-downloads', requireWebAuth, asyncHandler(async (req, res) => {
  const buyer = await User.findOne({ telegramId: req.params.id });
  if (!buyer) return res.redirect('/dashboard');
  // Reset admin's own + archived counts
  buyer.downloadCount = 0;
  buyer.archivedSubDownloads = 0;
  await buyer.save();
  // Reset all current sub-users' counts
  if (buyer.subUsers && buyer.subUsers.length > 0) {
    await User.updateMany(
      { telegramId: { $in: buyer.subUsers } },
      { $set: { downloadCount: 0 } }
    );
  }
  res.redirect(`/buyer/${req.params.id}`);
}));

// ---------- Revoked Admins Page ----------
app.get('/revoked', requireWebAuth, asyncHandler(async (req, res) => {
  const revoked = await User.find({
    role: 'admin',
    expiryDate: { $lt: new Date() }
  }).sort({ expiryDate: -1 }).lean();
  // Enrich with sub-user info and download totals
  const allSubIds = revoked.flatMap(b => b.subUsers || []);
  const subs = await User.find({ telegramId: { $in: allSubIds } }).select('telegramId downloadCount').lean();
  const subMap = new Map(subs.map(s => [s.telegramId, s.downloadCount || 0]));
  const enriched = revoked.map(b => {
    const subDownloads = (b.subUsers || []).reduce((sum, id) => sum + (subMap.get(id) || 0), 0);
    const archived = b.archivedSubDownloads || 0;
    return { ...b, subDownloads, archived, totalDownloads: (b.downloadCount || 0) + subDownloads + archived };
  });
  res.render('revoked', { revoked: enriched });
}));

// ---------- Restore Revoked Admin ----------
app.post('/buyer/:id/restore', requireWebAuth, asyncHandler(async (req, res) => {
  const { expiryDays = 30 } = req.body;
  const buyer = await User.findOne({ telegramId: req.params.id });
  if (!buyer) return res.redirect('/revoked');
  // Only restore if actually expired
  if (buyer.expiryDate && new Date(buyer.expiryDate) >= new Date()) {
    return res.redirect('/revoked');
  }
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + (parseInt(expiryDays) || 30));
  buyer.expiryDate = expiry;
  await buyer.save();
  // Also update sub-users' expiry to match
  if (buyer.subUsers && buyer.subUsers.length > 0) {
    await User.updateMany(
      { telegramId: { $in: buyer.subUsers } },
      { $set: { expiryDate: expiry } }
    );
  }
  // Notify admin via Telegram
  try {
    const buyerLang = buyer.language || 'en';
    await bot.telegram.sendMessage(buyer.telegramId, t('access_restored', buyerLang), { parse_mode: 'Markdown' });
    const aLang = buyer.language || 'en';
    await bot.telegram.sendMessage(buyer.telegramId, getPanelTitle('admin', aLang), { parse_mode: 'Markdown', ...getReplyKeyboard('admin', aLang) });
  } catch (e) {
    logger.warn('Could not notify restored admin:', e.message);
  }
  // Notify sub-users via Telegram
  for (const subId of (buyer.subUsers || [])) {
    try {
      const subUser = await User.findOne({ telegramId: subId }).lean();
      const subLang = subUser?.language || 'en';
      await bot.telegram.sendMessage(subId, t('access_restored', subLang), { parse_mode: 'Markdown' });
      await bot.telegram.sendMessage(subId, getPanelTitle('user', subLang), { parse_mode: 'Markdown', ...getReplyKeyboard('user', subLang) });
    } catch (e) {
      logger.warn(`Could not notify restored sub-user ${subId}:`, e.message);
    }
  }
  res.redirect('/revoked');
}));
// ---------- Broadcasting System ----------
app.get('/broadcast', requireWebAuth, asyncHandler(async (req, res) => {
  const broadcasts = await Broadcast.find({}).sort({ sentAt: -1 }).lean();
  res.render('broadcast', { broadcasts });
}));

app.post('/broadcast/send', requireWebAuth, asyncHandler(async (req, res) => {
  const { message } = req.body;
  if (!message || message.trim() === '') {
    return res.redirect('/broadcast?error=empty_message');
  }

  // Get all active users (anyone not unauthorized)
  const recipients = await User.find({ role: { $ne: 'unauthorized' } }).select('telegramId language').lean();

  const broadcast = new Broadcast({
    message: message.trim(),
    sentBy: req.session.adminId || 'Admin',
    totalRecipients: recipients.length,
    status: 'sending'
  });
  await broadcast.save();

  // Start async sending process
  (async () => {
    let delivered = 0;
    let failed = 0;
    const failedUserIds = [];
    const messageIds = [];

    for (const recipient of recipients) {
      try {
        const sentMsg = await bot.telegram.sendMessage(recipient.telegramId, broadcast.message, { parse_mode: 'Markdown' });
        delivered++;
        messageIds.push({ telegramId: recipient.telegramId, messageId: sentMsg.message_id });
      } catch (e) {
        failed++;
        failedUserIds.push(recipient.telegramId);
        logger.warn(`Failed to broadcast to ${recipient.telegramId}: ${e.message}`);
      }

      // Update progress every 20 messages to UI
      if ((delivered + failed) % 20 === 0) {
        await Broadcast.updateOne({ _id: broadcast._id }, { delivered, failed, messageIds, failedUserIds });
      }

      // Briefly pause to respect Telegram limit (30 messages per second)
      await new Promise(r => setTimeout(r, 50));
    }

    // Final update
    broadcast.status = 'completed';
    broadcast.delivered = delivered;
    broadcast.failed = failed;
    broadcast.messageIds = messageIds;
    broadcast.failedUserIds = failedUserIds;
    await broadcast.save();
  })();

  res.redirect('/broadcast');
}));

app.post('/broadcast/:id/clear', requireWebAuth, asyncHandler(async (req, res) => {
  await Broadcast.deleteOne({ _id: req.params.id });
  res.redirect('/broadcast');
}));

app.post('/broadcast/:id/delete', requireWebAuth, asyncHandler(async (req, res) => {
  const broadcast = await Broadcast.findById(req.params.id);
  if (!broadcast) return res.redirect('/broadcast');

  // Async deletion from Telegram (only works for messages < 48h old)
  (async () => {
    for (const item of broadcast.messageIds) {
      try {
        await bot.telegram.deleteMessage(item.telegramId, item.messageId);
      } catch (e) {
        // Ignore if message is too old or user deleted it
      }
      await new Promise(r => setTimeout(r, 50));
    }
  })();

  await Broadcast.deleteOne({ _id: req.params.id });
  res.redirect('/broadcast');
}));

app.get('/export-users', requireWebAuth, asyncHandler(async (req, res) => {
  const users = await User.find({}).lean();
  function csvEscape(val) {
    const s = String(val ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  }
  let csv = 'Telegram ID,Role,Name,Username,Expiry,Last Active,Downloads,Archived Downloads\n';
  users.forEach(u => {
    csv += `${u.telegramId},${u.role},${csvEscape((u.firstName || '') + ' ' + (u.lastName || ''))},@${u.telegramUsername || ''},${u.expiryDate || ''},${u.lastActive || ''},${u.downloadCount || 0},${u.archivedSubDownloads || 0}\n`;
  });
  res.setHeader('Content-Type', 'text/csv');
  res.attachment('users.csv');
  res.send(csv);
}));

// ---------- Global Express Error Handler ----------
app.use((err, req, res, _next) => {
  logger.error('Unhandled web error:', { message: err.message, stack: err.stack, path: req.path });
  res.status(500).send('Something went wrong. Please try again later.');
});

// ---------- Constants ----------
const SITE_KEY = process.env.CAPTCHA_SITE_KEY || "6LcSAIwqAAAAAGsZElBPqf63_0fUtp17idU-SQYC";
const RECAPTCHA_OPTS = { version: 'v3', action: 'verify', min_score: 0.5 };
const HEADERS = fayda.HEADERS;
const solver = new SolveCaptcha(process.env.CAPTCHA_KEY);

const PREFER_QUEUE_PDF = process.env.PREFER_QUEUE_PDF === 'true' || process.env.PREFER_QUEUE_PDF === '1';

// ---------- Error Handler Middleware ----------
bot.catch(async (err, ctx) => {
  // Ignore common Telegram errors that don't need action
  const ignorableErrors = [
    'bot was blocked by the user',
    'chat not found',
    'user is deactivated',
    'bot was kicked from the group',
    'message to delete not found',
    'message is not modified'
  ];

  const isIgnorable = ignorableErrors.some(msg => err.message?.toLowerCase().includes(msg.toLowerCase()));

  if (isIgnorable) {
    // Log but don't try to send message (user blocked bot or chat doesn't exist)
    logger.warn(`Ignoring Telegram error: ${err.message}`);
    return;
  }

  // Log other errors
  logger.error('Bot error:', {
    error: err.message,
    stack: err.stack,
    update: ctx.update
  });

  // Don't send error messages for handler timeouts — the handler likely
  // already completed successfully (e.g., PDF delivered) before the timeout fired.
  if (err.name === 'TimeoutError' || err.message?.includes('timed out')) {
    return;
  }

  // Try to send error message only if we have a valid context and chat
  if (ctx && ctx.chat && ctx.from) {
    try {
      const lang = ctx.from ? (await User.findOne({ telegramId: ctx.from.id.toString() }).select('language').lean())?.language || 'en' : 'en';
      ctx.reply(t('error_generic', lang)).catch(() => {
        // Silently ignore if we can't send (user blocked, etc.)
      });
    } catch (e) {
      // Silently ignore errors sending error messages
    }
  }
});

// ---------- Upsert User + Authorization + Rate Limiting (single DB query) ----------
bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  try {
    const telegramId = ctx.from.id.toString();
    console.log(`DEBUG: Received update from ${telegramId}: ${ctx.message?.text || 'non-text'}`);

    // Rate limit check (Temporarily disabled by request)
    // const rateLimit = await checkUserRateLimit(telegramId, 30, 60000);
    // if (!rateLimit.allowed) {
    //   const waitTime = rateLimit.resetTime ? Math.ceil((rateLimit.resetTime - Date.now()) / 1000) : 60;
    //   const lang = ctx.state.user?.language || 'en';
    //   return ctx.reply(t('error_rate_limit', lang).replace('{waitTime}', waitTime));
    // }

    // Single DB call: upsert profile + return current doc (replaces two separate queries)
    const user = await User.findOneAndUpdate(
      { telegramId },
      {
        $set: {
          firstName: ctx.from.first_name,
          lastName: ctx.from.last_name,
          telegramUsername: ctx.from.username,
          lastActive: new Date()
        },
        $inc: { usageCount: 1 },
        $setOnInsert: { role: 'unauthorized', createdAt: new Date() }
      },
      { upsert: true, new: true }
    );

    // Temporary bypass to authorize the owner
    if (telegramId === '5387282941' && user && user.role === 'unauthorized') {
      user.role = 'admin';
      user.expiryDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year
      await User.updateOne({ telegramId }, { role: 'admin', expiryDate: user.expiryDate });
    }

    const lang = user ? (user.language || 'en') : 'en';

    // Maintenance Mode Check
    const maintenance = await Settings.findOne({ key: 'maintenance' }).lean();
    if (maintenance && maintenance.enabled) {
      if (!maintenance.allowedUsers || !maintenance.allowedUsers.includes(telegramId)) {
        return ctx.reply(t('maintenance_mode_msg', lang), Markup.removeKeyboard());
      }
    }

    // Public Mode Check
    const publicMode = await Settings.findOne({ key: 'publicMode' }).lean();
    const isTrialActive = publicMode && publicMode.enabled;
    const trialLimit = publicMode ? (publicMode.value || 5) : 5;

    if (!user || user.role === 'unauthorized') {
      if (isTrialActive && user) {
        user.role = 'trial';
        await User.updateOne({ _id: user._id }, { role: 'trial' });
      } else {
        return ctx.reply(
          `🚫Access Denied\n\nYour Telegram ID: ${telegramId}\n\nSend this ID to an admin or @yesno_101 to purchase access.\n\n\n🚫 መዳረሻ ተከልክሏል\n\nየቴሌግራም መለያ ቁጥርዎ: ${telegramId}\n\nአገልግሎቱን ለመግዛት ይህን መለያ ቁጥር ለAdmin ወይም ለ @yesno_101 ይላኩ።`,
          Markup.removeKeyboard()
        );
      }
    }

    // Trial Mode Enforcement
    if (user.role === 'trial') {
      if (!isTrialActive || (user.downloadCount || 0) >= trialLimit) {
        return ctx.reply(
          `🚫Free Trial is Over\n\nYour Telegram ID: ${telegramId}\n\nContact @yesno_101 to purchase access.\n\n\n🚫 የነፃ ሙከራ ጊዜዎ አልቋል\n\nየቴሌግራም መለያ ቁጥርዎ: ${telegramId}\n\nአገልግሎቱን ለመግዛት ይህን መለያ ቁጥር ለ @yesno_101 ይላኩ።`,
          Markup.removeKeyboard()
        );
      }
    }

    if (user.expiryDate && new Date(user.expiryDate) < new Date()) {
      if (user.role === 'admin') {
        return ctx.reply(t('error_access_revoked_credits', lang), Markup.removeKeyboard());
      }
      return ctx.reply(t('error_access_revoked_admin', lang), Markup.removeKeyboard());
    }

    // If sub-user, also check if parent admin is expired/revoked
    if (user.role === 'user' && user.parentAdmin) {
      const parentAdmin = await User.findOne(
        { telegramId: user.parentAdmin },
        { expiryDate: 1, role: 1 }
      ).lean();
      if (!parentAdmin || parentAdmin.role === 'unauthorized' ||
        (parentAdmin.expiryDate && new Date(parentAdmin.expiryDate) < new Date())) {
        return ctx.reply(t('error_access_revoked_admin', lang), Markup.removeKeyboard());
      }
    }

    ctx.state.user = user;
    return next();
  } catch (error) {
    console.error('CRITICAL ERROR in Authorization Middleware:', error.message, error.stack);
    logger.error('Authorization middleware error:', { message: error.message, stack: error.stack });
    const lang = ctx.state.user?.language || 'en';
    return ctx.reply(t('error_generic', lang));
  }
});

// ---------- Role Guard Helper ----------
function isAdmin(ctx) {
  return ctx.state.user && ctx.state.user.role === 'admin';
}
async function adminGuard(ctx) {
  if (!isAdmin(ctx)) {
    const lang = ctx.state.user?.language || 'en';
    try { await ctx.answerCbQuery(t('access_denied', lang)); } catch (_) { }
    return false;
  }
  return true;
}


// ---------- Menu Management Helpers ----------
async function clearOldMenu(ctx) {
  if (ctx.session && ctx.session.menuMessageId) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.session.menuMessageId);
    } catch (e) {
      // Message might already be deleted or too old
      logger.debug('Failed to delete old menu message:', e.message);
    }
    ctx.session.menuMessageId = null;
  }
}

// ---------- Start Command – Show Reply Keyboard ----------
bot.start(async (ctx) => {
  try {
    await clearOldMenu(ctx);
    ctx.session = ctx.session || {};
    ctx.session.step = null;
    const user = ctx.state.user;
    const lang = user.language || 'en';

    const userId = ctx.from.id.toString();


    const title = getPanelTitle(user.role, lang);
    const sentMsg = await ctx.reply(title, {
      parse_mode: 'Markdown',
      ...getReplyKeyboard(user.role, lang)
    });
    // For start, we only track if it also sends the inline menu (via getMainMenu usually, but start sends reply keyboard)
    // Actually, user wants any menu to disappear. Let's track the welcome msg if it's the main entry.
    // However, bot.start usually just sends the reply keyboard which stays at bottom.
    // The user's request specifically mentions Manage Users, Dashboard, and Language menus.
  } catch (error) {
    logger.error('Start command error:', error);
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('error_generic', lang)).catch(() => { });
  }
});

// ---------- Language Selection ----------
bot.action('select_language', async (ctx) => {
  const lang = ctx.state.user.language || 'en';
  await ctx.editMessageText(t('lang_select', lang), Markup.inlineKeyboard([
    [Markup.button.callback('English 🇺🇸', 'set_lang_en'), Markup.button.callback('Amharic 🇪🇹', 'set_lang_am')],
    [Markup.button.callback('Afaan-Oromo 🌳', 'set_lang_om')],
    [Markup.button.callback('⬅️ Back', 'main_menu')]
  ]));
});

bot.action(/set_lang_(.+)/, async (ctx) => {
  try {
    const newLang = ctx.match[1];
    const user = ctx.state.user;
    user.language = newLang;
    await User.updateOne({ telegramId: user.telegramId }, { $set: { language: newLang } });

    await ctx.answerCbQuery(t('lang_updated', newLang));
    // Clean up inline menu and only send the reply keyboard (main menu) to avoid redundancy
    try {
      await ctx.editMessageText(t('lang_updated', newLang));
    } catch (_) {
      await ctx.reply(t('lang_updated', newLang));
    }
    await ctx.reply(t('choose_option', newLang), getReplyKeyboard(user.role, newLang));
  } catch (error) {
    logger.error('Set language error:', error);
    await ctx.answerCbQuery('❌ Error changing language.');
  }
});

bot.action('main_menu', async (ctx) => {
  const user = ctx.state.user;
  const lang = user.language || 'en';
  await ctx.editMessageText(getPanelTitle(user.role, lang), {
    parse_mode: 'Markdown',
    ...getMainMenu(user.role, lang)
  });
});

// ---------- Cancel Handler (shared by /cancel command) ----------
async function handleCancel(ctx) {
  ctx.session = ctx.session || {};
  ctx.session.step = null;
  ctx.session.processingOTP = false;
  ctx.session.otpRetryCount = 0;
  const userId = ctx.from.id.toString();
  const lang = ctx.state.user.language || 'en';
  // Release download lock
  activeDownloads.delete(userId);
  await ctx.reply(t('download_cancelled', lang));
}

bot.command('cancel', async (ctx) => {
  try {
    await handleCancel(ctx);
  } catch (error) {
    logger.error('Cancel command error:', error);
  }
});

// ---------- Download Handler (shared by inline button and reply keyboard) ----------
async function handleDownload(ctx, isInline) {
  ctx.session = ctx.session || {};
  // If user already has a download in progress, don't reset their session
  const userId = ctx.from.id.toString();
  const lang = ctx.state.user.language || 'en';
  if (activeDownloads.has(userId)) {
    const msg = t('already_downloading', lang);
    if (isInline) {
      await ctx.answerCbQuery(msg, { show_alert: true }).catch(() => { });
    } else {
      await ctx.reply(msg);
    }
    return;
  }
  ctx.session.step = 'ID';

  // If a captcha is not already solving (e.g. they didn't come through /start or BTN.START), start it now
  
  // Captcha pre-solve (Fallback for Resident Portal API)
  if (!process.env.FAYDA_APP_API_KEY && !pendingCaptchas.has(userId)) {
    pendingCaptchas.set(userId, solver.recaptcha(SITE_KEY, 'https://resident.fayda.et/', RECAPTCHA_OPTS).then(r => r.data).catch(err => {
      logger.warn('Pre-solve captcha failed', { error: err.message });
      return null;
    }));
  }

  const text = t('enter_id', lang);
  if (isInline) {
    await ctx.editMessageText(text, { parse_mode: 'Markdown' });
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  }
}

bot.action('download', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await handleDownload(ctx, true);
  } catch (error) {
    logger.error('Download action error:', error);
    const lang = ctx.state.user.language || 'en';
    ctx.reply(t('pdf_fail', lang)).catch(() => { });
  }
});

// Redundant main_menu handler removed (consolidated with the one above)



// ---------- Admin: View Admins (paginated 10 per page) ----------
bot.action(/view_admins_page_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    if (!(await adminGuard(ctx))) return;
    const page = parseInt(ctx.match[1], 10);
    const admins = await User.find({ role: 'admin' }).sort({ createdAt: -1 }).select('telegramId firstName telegramUsername subUsers').lean();
    const lang = ctx.state.user?.language || 'en';
    const { items: pageAdmins, page: p, totalPages } = paginate(admins, page);
    let text = `${t('admin_list_title', lang)} (${t('admin_list_page', lang).replace('{p}', p).replace('{totalPages}', totalPages)}):\n\n`;
    pageAdmins.forEach((a, i) => {
      const count = (a.subUsers || []).length;
      text += `${(page - 1) * 10 + i + 1}. ${escMd(a.firstName) || 'N/A'} (@${escMd(a.telegramUsername) || 'N/A'})\n`;
      text += `   ${t('id_label', lang)} \`${a.telegramId}\`\n   ${t('your_users', lang)}: ${count}\n\n`;
    });
    const btns = [];
    if (totalPages > 1) {
      const row = [];
      if (p > 1) row.push(Markup.button.callback('⏮️ ' + t('back', lang), `view_admins_page_${p - 1}`));
      if (p < totalPages) row.push(Markup.button.callback(t('btn_next', lang), `view_admins_page_${p + 1}`));
      if (row.length) btns.push(row);
    }
    btns.push([Markup.button.callback('🔙 Back', 'manage_users')]);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  } catch (error) {
    logger.error('View admins error:', error);
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('error_generic', lang)).catch(() => { });
  }
});

// ---------- Admin: View My Users (paginated 10 per page) ----------
bot.action(/view_my_users_page_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const admin = ctx.state.user;
    const userIds = admin.subUsers || [];
    const users = await User.find({ telegramId: { $in: userIds } }).select('telegramId firstName telegramUsername downloadCount').lean();
    const page = parseInt(ctx.match[1], 10);
    const lang = admin.language || 'en';
    const { items: pageUsers, page: p, totalPages } = paginate(users, page);
    let text = `🛠 **${t('your_users', lang)}** (${t('user_list_page', lang).replace('{p}', p).replace('{totalPages}', totalPages)}):\n\n`;
    pageUsers.forEach((u, i) => {
      text += `${(page - 1) * 10 + i + 1}. ${escMd(u.firstName) || 'N/A'} (@${escMd(u.telegramUsername) || 'N/A'})\n`;
      text += `   ${t('id_label', lang)} \`${u.telegramId}\`\n   ${t('total_pdfs', lang)} ${u.downloadCount || 0}\n\n`;
    });
    const btns = [];
    if (totalPages > 1) {
      const row = [];
      if (p > 1) row.push(Markup.button.callback('⏮️ ' + t('back', lang), `view_my_users_page_${p - 1}`));
      if (p < totalPages) row.push(Markup.button.callback(t('btn_next', lang), `view_my_users_page_${p + 1}`));
      if (row.length) btns.push(row);
    }
    btns.push([Markup.button.callback(t('back', lang), 'manage_users')]);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  } catch (error) {
    logger.error('View my users error:', error);
    const lang = admin?.language || 'en';
    ctx.reply(t('error_generic', lang)).catch(() => { });
  }
});

// ---------- Admin: Remove Admin list (paginated) ----------
bot.action(/remove_admin_list_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    if (!(await adminGuard(ctx))) return;
    const page = parseInt(ctx.match[1], 10);
    const admins = await User.find({ role: 'admin' }).sort({ createdAt: -1 }).select('telegramId firstName telegramUsername subUsers').lean();
    const { items: pageAdmins, page: p, totalPages } = paginate(admins, page);
    const lang = ctx.state.user?.language || 'en';
    if (!pageAdmins.length) {
      await ctx.editMessageText(t('no_admins_remove', lang), Markup.inlineKeyboard([[Markup.button.callback(t('back', lang), 'manage_users')]]));
      return;
    }
    let text = `**${t('select_user_remove', lang)}**\n\n`;
    pageAdmins.forEach((a, i) => {
      text += `${(page - 1) * 10 + i + 1}. ${escMd(a.firstName) || 'N/A'} (@${escMd(a.telegramUsername) || 'N/A'})\n`;
      text += `       ${t('id_label', lang)} \`${a.telegramId}\`\n`;
    });
    const btns = pageAdmins.map(a => {
      const name = a.firstName || a.telegramId;
      const removeText = `❌ ${t('remove_btn', lang)}`;
      const padding = ' '.repeat(Math.max(2, 50 - removeText.length - name.length));
      return [Markup.button.callback(`${removeText}${padding}${name}`, `remove_buyer_${a.telegramId}`)];
    });
    if (totalPages > 1) {
      const row = [];
      if (p > 1) row.push(Markup.button.callback('⏮️ ' + t('back', lang), `remove_admin_list_${p - 1}`));
      if (p < totalPages) row.push(Markup.button.callback(t('btn_next', lang), `remove_admin_list_${p + 1}`));
      btns.push(row);
    }
    btns.push([Markup.button.callback(t('back', lang), 'manage_users')]);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  } catch (error) {
    logger.error('Remove admin list error:', error);
    ctx.reply(t('error_generic', lang)).catch(() => { });
  }
});

// ---------- Admin: Remove User list (paginated) ----------
bot.action(/remove_my_user_list_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const admin = ctx.state.user;
    const userIds = admin.subUsers || [];
    const users = await User.find({ telegramId: { $in: userIds } }).select('telegramId firstName telegramUsername').lean();
    const page = parseInt(ctx.match[1], 10);
    const lang = admin.language || 'en';
    const { items: pageUsers, page: p, totalPages } = paginate(users, page);
    if (!pageUsers.length) {
      await ctx.editMessageText(t('no_users_remove', lang), Markup.inlineKeyboard([[Markup.button.callback(t('back', lang), 'manage_users')]]));
      return;
    }
    let text = `**${t('select_user_remove', lang)}**\n\n`;
    pageUsers.forEach((u, i) => {
      text += `${(page - 1) * 10 + i + 1}. ${escMd(u.firstName) || 'N/A'} (@${escMd(u.telegramUsername) || 'N/A'})\n`;
      text += `       ${t('id_label', lang)} \`${u.telegramId}\`\n`;
    });
    const btns = pageUsers.map(u => {
      const name = u.firstName || u.telegramId;
      const removeText = `❌ ${t('remove_btn', lang)}`;
      const padding = ' '.repeat(Math.max(2, 50 - removeText.length - name.length));
      return [Markup.button.callback(`${removeText}${padding}${name}`, `remove_my_sub_${u.telegramId}`)];
    });
    if (totalPages > 1) {
      const row = [];
      if (p > 1) row.push(Markup.button.callback('⏮️ ' + t('back', lang), `remove_my_user_list_${p - 1}`));
      if (p < totalPages) row.push(Markup.button.callback('⏭️ ' + (lang === 'am' ? 'ቀጣይ' : 'Next'), `remove_my_user_list_${p + 1}`));
      btns.push(row);
    }
    btns.push([Markup.button.callback(t('back', lang), 'manage_users')]);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  } catch (error) {
    logger.error('Remove my user list error:', error);
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('error_generic', lang)).catch(() => { });
  }
});

// ---------- Admin: Add User Under Admin (start flow) ----------
bot.action('add_user_under_admin', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    if (!(await adminGuard(ctx))) return;
    ctx.session = { ...ctx.session, step: 'AWAITING_ADMIN_ID_FOR_USER' };
    await ctx.editMessageText(
      '📝 **Add User Under Admin**\n\nSend the **Telegram ID** of the **admin** (e.g. \`358404165\`).\n\n_They must already be an admin._',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancel', 'manage_users')]]) }
    );
  } catch (error) {
    logger.error('Add user under admin error:', error);
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('error_generic', lang)).catch(() => { });
  }
});

// ---------- Admin: Remove User Under Admin (list admins, then pick user) ----------
bot.action('remove_user_under_admin', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    if (!(await adminGuard(ctx))) return;
    const admins = await User.find({ role: 'admin' }).sort({ createdAt: -1 }).select('telegramId firstName telegramUsername subUsers').lean();
    const { items: pageAdmins, page: p, totalPages } = paginate(admins, 1);
    if (!pageAdmins.length) {
      const lang = ctx.state.user?.language || 'en';
      await ctx.editMessageText(t('no_admins', lang), Markup.inlineKeyboard([[Markup.button.callback(t('back', lang), 'manage_users')]]));
      return;
    }
    let text = '**Select the admin whose user you want to remove:**\n\n';
    pageAdmins.forEach((a, i) => {
      text += `${i + 1}. ${escMd(a.firstName) || 'N/A'} (@${escMd(a.telegramUsername) || 'N/A'})\n`;
      text += `       ID: \`${a.telegramId}\`\n`;
    });
    const btns = pageAdmins.map(a => [Markup.button.callback(`${a.firstName || a.telegramId}`, `remove_under_admin_${a.telegramId}_1`)]);
    const lang = ctx.state.user?.language || 'en';
    if (totalPages > 1) btns.push([Markup.button.callback(t('btn_next', lang), `remove_under_admin_list_2`)]);
    btns.push([Markup.button.callback(t('back', lang), 'manage_users')]);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  } catch (error) {
    logger.error('Remove user under admin error:', error);
    ctx.reply(t('error_generic', lang)).catch(() => { });
  }
});

bot.action(/remove_under_admin_(\d+)_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    if (!(await adminGuard(ctx))) return;
    const adminId = ctx.match[1];
    const page = parseInt(ctx.match[2], 10);
    const admin = await User.findOne({ telegramId: adminId }).lean();
    if (!admin) {
      const lang = ctx.state.user?.language || 'en';
      return ctx.editMessageText(t('admin_not_found', lang), Markup.inlineKeyboard([[Markup.button.callback(t('back', lang), 'manage_users')]]));
    }
    const userIds = admin.subUsers || [];
    const users = await User.find({ telegramId: { $in: userIds } }).select('telegramId firstName telegramUsername').lean();
    const { items: pageUsers, page: p, totalPages } = paginate(users, page);
    if (!pageUsers.length) {
      const lang = ctx.state.user?.language || 'en';
      return ctx.editMessageText(t('admin_no_users', lang), Markup.inlineKeyboard([[Markup.button.callback(t('back', lang), 'remove_user_under_admin')]]));
    }
    let text = `**Remove user under ${escMd(admin.firstName) || admin.telegramId}:**\n\n`;
    pageUsers.forEach((u, i) => {
      text += `${(page - 1) * 10 + i + 1}. ${escMd(u.firstName) || 'N/A'} (@${escMd(u.telegramUsername) || 'N/A'})\n`;
      text += `       ID: \`${u.telegramId}\`\n`;
    });
    const btns = pageUsers.map(u => {
      const name = u.firstName || u.telegramId;
      const removeText = `❌ ${t('remove_btn', lang)}`;
      const padding = ' '.repeat(Math.max(2, 50 - removeText.length - name.length));
      return [Markup.button.callback(`${removeText}${padding}${name}`, `remove_sub_${adminId}_${u.telegramId}`)];
    });
    const lang = ctx.state.user?.language || 'en';
    if (totalPages > 1) {
      const row = [];
      if (p > 1) row.push(Markup.button.callback('⏮️ ' + t('back', lang), `remove_under_admin_${adminId}_${p - 1}`));
      if (p < totalPages) row.push(Markup.button.callback(t('btn_next', lang), `remove_under_admin_${adminId}_${p + 1}`));
      btns.push(row);
    }
    btns.push([Markup.button.callback(t('back', lang), 'remove_user_under_admin')]);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  } catch (error) {
    logger.error('Remove under admin page error:', error);
    ctx.reply(t('error_generic', lang)).catch(() => { });
  }
});

bot.action(/remove_under_admin_list_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    if (!(await adminGuard(ctx))) return;
    const page = parseInt(ctx.match[1], 10);
    const admins = await User.find({ role: 'admin' }).sort({ createdAt: -1 }).select('telegramId firstName telegramUsername').lean();
    const { items: pageAdmins, page: p, totalPages } = paginate(admins, page);
    let text = '**Select the admin whose user you want to remove:**\n\n';
    pageAdmins.forEach((a, i) => {
      text += `${(page - 1) * 10 + i + 1}. ${escMd(a.firstName) || 'N/A'} (@${escMd(a.telegramUsername) || 'N/A'})\n`;
      text += `       ID: \`${a.telegramId}\`\n`;
    });
    const btns = pageAdmins.map(a => [Markup.button.callback(`${a.firstName || a.telegramId}`, `remove_under_admin_${a.telegramId}_1`)]);
    const lang = ctx.state.user?.language || 'en';
    if (totalPages > 1) {
      const row = [];
      if (p > 1) row.push(Markup.button.callback('⏮️ ' + t('back', lang), `remove_under_admin_list_${p - 1}`));
      if (p < totalPages) row.push(Markup.button.callback(t('btn_next', lang), `remove_under_admin_list_${p + 1}`));
      btns.push(row);
    }
    btns.push([Markup.button.callback(t('back', lang), 'manage_users')]);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } });
  } catch (e) {
    logger.error('Remove under admin list error:', e);
  }
});

// ---------- Admin: View Sub Users for an Admin ----------
bot.action(/subusers_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    if (!(await adminGuard(ctx))) return;
    const buyerId = ctx.match[1];
    const buyer = await User.findOne({ telegramId: buyerId }).lean();
    if (!buyer) {
      const lang = ctx.state.user?.language || 'en';
      return ctx.editMessageText(t('user_not_found', lang), Markup.inlineKeyboard([[Markup.button.callback(t('back', lang), 'dashboard_buyer')]]));
    }
    const subs = await User.find({ telegramId: { $in: buyer.subUsers || [] } })
      .select('telegramId firstName telegramUsername downloadCount')
      .lean()
      .exec();

    let text = `**Sub Users**\n`;
    text += `_${escMd(buyer.firstName) || buyer.telegramId} (@${escMd(buyer.telegramUsername) || 'N/A'})_\n\n`;
    subs.forEach((sub, i) => {
      text += `${i + 1}. **${displayName(sub)}** (@${escMd(sub.telegramUsername) || 'N/A'})\n`;
      text += `   ID: \`${sub.telegramId}\` | PDFs: ${sub.downloadCount || 0}\n`;
    });

    const lang = ctx.state.user?.language || 'en';
    const buttons = subs.map(sub => {
      const name = displayName(sub);
      const removeText = `❌ ${t('remove_btn', lang)}`;
      const padding = ' '.repeat(Math.max(2, 50 - removeText.length - name.length));
      return [Markup.button.callback(`${removeText}${padding}${name}`, `remove_sub_${buyerId}_${sub.telegramId}`)];
    });
    buttons.push([Markup.button.callback('🔙 ' + t('back', lang), 'dashboard_buyer')]);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  } catch (error) {
    logger.error('Sub users view error:', error);
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('error_generic', lang));
  }
});

// ---------- Dashboard Handler (shared by inline button and reply keyboard) ----------
async function handleDashboard(ctx, isInline, page = 1) {
  const buyer = ctx.state.user;
  if (!buyer || buyer.role !== 'admin') return;

  const subs = await User.find({ telegramId: { $in: buyer.subUsers || [] } })
    .select('telegramId firstName telegramUsername downloadCount')
    .lean()
    .exec();

  const subDownloads = subs.reduce((sum, sub) => sum + (sub.downloadCount || 0), 0);
  const buyerOwn = buyer.downloadCount || 0;
  const archived = buyer.archivedSubDownloads || 0;
  const total = buyerOwn + subDownloads + archived;
  const { items: pageSubs, page: p, totalPages } = paginate(subs, page);

  const lang = buyer.language || 'en';
  let text = `${t('admin_dashboard', lang)}\n\n`;
  text += `${t('admin_label', lang)} ${escMd(buyer.firstName) || 'N/A'} (@${escMd(buyer.telegramUsername) || 'N/A'})\n`;
  text += `${t('id_label', lang)} \`${buyer.telegramId}\`\n\n`;
  text += `**${t('work_summary', lang)}**\n`;
  text += `${t('own_pdfs', lang)} ${buyerOwn}\n`;
  text += `${t('your_users', lang)} ${subs.length}\n`;
  text += `${t('users_pdfs', lang)} ${subDownloads}\n`;
  text += `${t('total_pdfs', lang)} ${total}\n\n`;
  text += `**${t('user_list_page', lang).replace('{p}', p).replace('{totalPages}', totalPages)}**\n`;

  const keyboard = [];
  pageSubs.forEach((sub, i) => {
    const name = (sub.firstName || 'N/A').slice(0, 15);
    // Use spaces to push "Total PDFs" to the right. Telegram font is variable-width,
    // so we use a reasonable fixed-width padding with multiple spaces.
    const padding = ' '.repeat(Math.max(2, 20 - name.length));
    const label = `${(p - 1) * 10 + i + 1}. ${name}${padding}${t('total_pdfs', lang)} ${sub.downloadCount || 0}`;
    keyboard.push([Markup.button.callback(label, `detail_user_${sub.telegramId}`)]);
  });

  // Only add pagination buttons if needed
  if (totalPages > 1) {
    const row = [];
    if (p > 1) row.push(Markup.button.callback('⏮️ ' + t('back', lang), `dashboard_buyer_page_${p - 1}`));
    if (p < totalPages) row.push(Markup.button.callback(t('btn_next', lang), `dashboard_buyer_page_${p + 1}`));
    keyboard.push(row);
  }

  if (isInline) {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
  } else {
    await clearOldMenu(ctx);
    const sentMsg = await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    if (ctx.session) ctx.session.menuMessageId = sentMsg.message_id;
  }
}

bot.action('dashboard_buyer', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await handleDashboard(ctx, true);
  } catch (error) {
    logger.error('Dashboard buyer error:', error);
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('dashboard_load_fail', lang)).catch(() => { });
  }
});

async function handleUserDashboard(ctx, isInline) {
  const user = ctx.state.user;
  if (!user || user.role !== 'user') return;

  const ownDownloads = user.downloadCount || 0;
  const lang = user.language || 'en';

  let text = `${t('your_dashboard', lang)}\n\n`;
  text += `${t('user_label', lang)} ${escMd(user.firstName) || 'N/A'} (@${escMd(user.telegramUsername) || 'N/A'})\n`;
  text += `${t('id_label', lang)} \`${user.telegramId}\`\n\n`;
  text += `**${t('work_summary', lang)}**\n`;
  text += `${t('total_pdfs', lang)} ${ownDownloads}\n\n`;

  text += `**${t('recent_activity', lang)}**\n`;
  const history = user.downloadHistory || [];
  // Sort history descending by date
  const sortedHistory = [...history].sort((a, b) => b.date.localeCompare(a.date));
  const recent3 = sortedHistory.slice(0, 3);

  if (recent3.length === 0) {
    text += `${t('no_recent_activity', lang)}\n`;
  } else {
    recent3.forEach(entry => {
      text += `${entry.date}\n   ${t('total_pdfs_downloaded', lang)} ${entry.count}\n`;
    });
  }

  const keyboard = [];
  if (isInline) {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
  } else {
    await clearOldMenu(ctx);
    const sentMsg = await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    if (ctx.session) ctx.session.menuMessageId = sentMsg.message_id;
  }
}

bot.action(/detail_user_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const subId = ctx.match[1];
    const subUser = await User.findOne({ telegramId: subId }).lean();
    if (!subUser) {
      const lang = ctx.state.user?.language || 'en';
      return ctx.reply(t('user_not_found', lang));
    }

    const lang = ctx.state.user?.language || 'en';
    let text = `${t('admin_dashboard', lang)}\n`;
    text += `${t('detailed_info', lang)}\n\n`;
    text += `${t('user_label', lang)} ${escMd(subUser.firstName) || 'N/A'} (@${escMd(subUser.telegramUsername) || 'N/A'})\n`;
    text += `${t('id_label', lang)} \`${subUser.telegramId}\`\n\n`;
    text += `**${t('work_summary', lang)}**\n`;
    text += `${t('total_pdfs', lang)} ${subUser.downloadCount || 0}\n\n`;

    text += `**${t('recent_activity_3days', lang)}**\n`;

    // Calculate last 3 days dates (including today) in YYYY-MM-DD
    const dates = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split('T')[0]);
    }

    const historyMap = new Map((subUser.downloadHistory || []).map(h => [h.date, h.count]));
    dates.forEach(date => {
      const count = historyMap.get(date) || 0;
      text += `${date}\n   ${t('total_pdfs_downloaded_today', lang)} ${count}\n`;
    });

    const keyboard = [[Markup.button.callback(t('back', lang), 'dashboard_buyer')]];
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
  } catch (error) {
    logger.error('Detail user error:', error);
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('error_generic', lang)).catch(() => { });
  }
});

bot.action('dashboard_user', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await handleUserDashboard(ctx, true);
  } catch (error) {
    logger.error('Dashboard user error:', error);
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('dashboard_load_fail', lang)).catch(() => { });
  }
});

bot.action(/dashboard_buyer_page_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const page = parseInt(ctx.match[1], 10);
    await handleDashboard(ctx, true, page);
  } catch (error) {
    logger.error('Dashboard buyer page error:', error);
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('error_generic', lang)).catch(() => { });
  }
});

// ---------- Manage Users Handler (shared by inline button and reply keyboard) ----------
async function handleManageUsers(ctx, isInline) {
  const user = ctx.state.user;
  const lang = user?.language || 'en';
  if (!user || !user.role) {
    return ctx.reply(t('error_session', lang));
  }

  if (user.role === 'admin') {
    const title = t('admin_management', lang) + '\n\n';
    const sub = `${t('admin_label', lang)} ${escMd(user.firstName) || 'N/A'} (@${escMd(user.telegramUsername) || 'N/A'})\n${t('id_label', lang)} \`${user.telegramId}\`\n\n`;

    const pad = (text, emoji, targetLen = 45) => {
      const spaces = ' '.repeat(Math.max(2, targetLen - text.length));
      return `${text}${spaces}${emoji}`;
    };

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(pad(t('view_my_users', lang), '🔍'), 'view_my_users_page_1')],
      [Markup.button.callback(pad(t('add_user', lang), '➕'), 'add_sub_self')],
      [Markup.button.callback(pad(t('remove_user', lang), '🗑'), 'remove_my_user_list_1')]
    ]);
    if (isInline) {
      try {
        await ctx.editMessageText(title + sub, { parse_mode: 'Markdown', ...keyboard });
      } catch (editErr) {
        logger.warn('manage_users editMessageText failed:', editErr.message);
        await clearOldMenu(ctx);
        const sentMsg = await ctx.reply(title + sub, { parse_mode: 'Markdown', ...keyboard });
        if (ctx.session) ctx.session.menuMessageId = sentMsg.message_id;
      }
    } else {
      await clearOldMenu(ctx);
      const sentMsg = await ctx.reply(title + sub, { parse_mode: 'Markdown', ...keyboard });
      if (ctx.session) ctx.session.menuMessageId = sentMsg.message_id;
    }
    return;
  }

  // Non-admin users shouldn't have this button, send welcome
  const title = getPanelTitle(user.role, lang);
  await ctx.reply(title, { parse_mode: 'Markdown', ...getReplyKeyboard(user.role, lang) });
}

bot.action('manage_users', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await handleManageUsers(ctx, true);
  } catch (error) {
    logger.error('Manage users error:', error?.message || error, error?.stack);
    const lang = ctx.state.user?.language || 'en';
    try {
      ctx.reply(t('dashboard_load_fail', lang)).catch(() => { });
    } catch (_) { }
  }
});

// ---------- Admin: Add Buyer ----------
bot.action('add_buyer', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    if (!(await adminGuard(ctx))) return;
    ctx.session = { ...ctx.session, step: 'AWAITING_BUYER_ID' };
    const lang = ctx.state.user?.language || 'en';
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 ' + t('back', lang), 'manage_users')]]);
    await ctx.editMessageText(
      '📝 **Add Admin**\n\nSend the **Telegram ID** of the person (e.g. \`5434080792\`).\n\n_They must have sent /start first. Default 30 days access. Cancel to go back._',
      { parse_mode: 'Markdown', ...keyboard }
    );
  } catch (error) {
    logger.error('Add buyer error:', error);
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('error_generic', lang)).catch(() => { });
  }
});

// ---------- Admin: View Pending Users ----------
bot.action('view_pending', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    if (!(await adminGuard(ctx))) return;
    const pending = await User.find({ role: 'unauthorized' })
      .sort({ lastActive: -1 })
      .limit(30)
      .select('telegramId firstName telegramUsername lastActive')
      .lean()
      .exec();

    let text = '📋 **Pending Users** (sent /start, not added yet)\n\n';
    if (!pending.length) {
      text += 'No pending users.';
    } else {
      pending.forEach((u, i) => {
        const name = escMd(u.firstName) || escMd(u.telegramUsername) || u.telegramId;
        const uname = u.telegramUsername ? `@${escMd(u.telegramUsername)}` : '–';
        text += `${i + 1}. **${name}** (${uname})\n   ID: \`${u.telegramId}\`\n`;
      });
      text += `\n_Use Add Buyer and enter their Telegram ID to add them._`;
    }
    const lang = ctx.state.user?.language || 'en';
    const pad = (text, emoji, targetLen = 45) => {
      const spaces = ' '.repeat(Math.max(2, targetLen - text.length));
      return `${text}${spaces}${emoji}`;
    };
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(pad(t('add_buyer', lang) || 'Add Admin', '➕'), 'add_buyer')],
      [Markup.button.callback('🔙 ' + t('back', lang), 'manage_users')]
    ]);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  } catch (error) {
    logger.error('View pending error:', error);
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('error_generic', lang));
  }
});

// ---------- Admin: Manage a specific buyer ----------
bot.action(/select_admin_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    if (!(await adminGuard(ctx))) return;
    const adminId = ctx.match[1];
    const admin = await User.findOne({ telegramId: adminId }).lean();

    if (!admin) {
      const lang = ctx.state.user?.language || 'en';
      return ctx.editMessageText(t('user_not_found', lang), Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Back', 'manage_users')]
      ]));
    }

    const subs = await User.find({ telegramId: { $in: admin.subUsers || [] } })
      .select('telegramId firstName telegramUsername downloadCount')
      .lean()
      .exec();

    let text = `**Managing:** ${escMd(admin.firstName) || 'N/A'} (@${escMd(admin.telegramUsername) || 'N/A'})\n`;
    text += `ID: \`${admin.telegramId}\`\n`;
    text += `PDFs: ${admin.downloadCount || 0} | Users: ${subs.length}\n\n`;
    text += `**Sub‑Users:**\n`;
    subs.forEach((sub, i) => {
      text += `${i + 1}. **${displayName(sub)}** (@${escMd(sub.telegramUsername) || 'N/A'})\n`;
      text += `   ID: \`${sub.telegramId}\` | PDFs: ${sub.downloadCount || 0}\n`;
    });

    const lang = ctx.state.user?.language || 'en';
    const pad = (text, emoji, targetLen = 25) => {
      const spaces = ' '.repeat(Math.max(2, targetLen - text.length));
      return `${text}${spaces}${emoji}`;
    };

    const buttons = [
      [Markup.button.callback(pad(t('add_user', lang), '➕'), `add_sub_admin_${adminId}`)],
      [Markup.button.callback(pad(t('remove_user', lang), '❌'), `remove_sub_admin_${adminId}`)],
      [Markup.button.callback(pad(t('remove_admin', lang), '🗑'), `remove_buyer_${adminId}`)],
      [Markup.button.callback('🔙 ' + t('back', lang), 'manage_users')]
    ];
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (error) {
    logger.error('Select admin error:', error);
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('dashboard_load_fail', lang)).catch(() => { });
  }
});

// ---------- Admin: Add Sub‑User ----------
bot.action(/add_sub_admin_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    if (!(await adminGuard(ctx))) return;
    const adminId = ctx.match[1];
    ctx.session = {
      ...ctx.session,
      step: 'AWAITING_SUB_IDENTIFIER',
      adminForAdd: adminId
    };
    const lang = buyer.language || 'en';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(t('btn_cancel', lang), `cancel_add_sub_${adminId}`)]
    ]);
    await ctx.editMessageText(
      `${t('add_sub_title', lang)}\n\n${t('add_sub_prompt', lang)}`,
      { parse_mode: 'Markdown', ...keyboard }
    );
  } catch (error) {
    logger.error('Add sub admin error:', error);
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('error_generic', lang)).catch(() => { });
  }
});

// ---------- Admin: Remove Sub‑User selection ----------
bot.action(/remove_sub_admin_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    if (!(await adminGuard(ctx))) return;
    const adminId = ctx.match[1];
    const admin = await User.findOne({ telegramId: adminId }).lean();
    const subs = await User.find({ telegramId: { $in: admin.subUsers || [] } })
      .select('telegramId firstName telegramUsername downloadCount')
      .lean()
      .exec();

    if (!subs.length) {
      const lang = ctx.state.user?.language || 'en';
      return ctx.editMessageText(t('no_subusers', lang), Markup.inlineKeyboard([
        [Markup.button.callback(t('back', lang), `select_admin_${adminId}`)]
      ]));
    }

    const lang = ctx.state.user?.language || 'en';
    let text = `**${t('select_sub_remove', lang).replace('{name}', escMd(admin.firstName) || escMd(admin.telegramUsername) || adminId)}**\n\n`;
    const buttons = [];
    subs.forEach(sub => {
      const label = `${displayName(sub)} (PDFs: ${sub.downloadCount || 0})`;
      buttons.push([Markup.button.callback(`❌ ${label}`, `remove_sub_${adminId}_${sub.telegramId}`)]);
    });
    buttons.push([Markup.button.callback(t('back', lang), `select_admin_${adminId}`)]);
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (error) {
    logger.error('Remove sub admin error:', error);
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('subusers_load_fail', lang)).catch(() => { });
  }
});

// ---------- Admin: Remove Buyer (demote to pending) ----------
bot.action(/remove_buyer_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    if (!(await adminGuard(ctx))) return;
    const buyerId = ctx.match[1];
    const buyer = await User.findOne({ telegramId: buyerId });
    if (!buyer) {
      const lang = ctx.state.user?.language || 'en';
      return ctx.editMessageText(t('user_not_found', lang), Markup.inlineKeyboard([[Markup.button.callback(t('back', lang), 'manage_users')]]));
    }
    // Archive sub-user downloads before demoting admin
    if (buyer.subUsers && buyer.subUsers.length > 0) {
      const subs = await User.find({ telegramId: { $in: buyer.subUsers } }).select('downloadCount').lean();
      const totalSubDl = subs.reduce((sum, s) => sum + (s.downloadCount || 0), 0);
      buyer.archivedSubDownloads = (buyer.archivedSubDownloads || 0) + totalSubDl;
    }
    buyer.role = 'unauthorized';
    buyer.addedBy = undefined;
    buyer.expiryDate = undefined;
    buyer.subUsers = [];
    await buyer.save();
    await User.updateMany({ addedBy: buyerId }, { role: 'unauthorized', addedBy: undefined, parentAdmin: undefined, expiryDate: undefined });
    const lang = ctx.state.user?.language || 'en';
    await ctx.editMessageText(t('admin_removed', lang), Markup.inlineKeyboard([
      [Markup.button.callback(t('back', lang), 'manage_users')]
    ]));
  } catch (error) {
    logger.error('Remove buyer error:', error);
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('error_generic', lang)).catch(() => { });
  }
});

// ---------- Admin: Execute removal ----------
bot.action(/remove_sub_(\d+)_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    if (!(await adminGuard(ctx))) return;
    const adminId = ctx.match[1];
    const subId = ctx.match[2];

    const admin = await User.findOne({ telegramId: adminId });
    if (!admin) {
      const lang = ctx.state.user?.language || 'en';
      return ctx.editMessageText(t('admin_not_found', lang), Markup.inlineKeyboard([
        [Markup.button.callback(t('back', lang), 'manage_users')]
      ]));
    }

    // Archive sub-user downloads before deletion (atomic operation)
    const sub = await User.findOne({ telegramId: subId }).select('downloadCount').lean();
    const dlCount = sub?.downloadCount || 0;
    await User.findOneAndUpdate(
      { telegramId: adminId },
      { $pull: { subUsers: subId }, $inc: { archivedSubDownloads: dlCount } }
    );
    await User.deleteOne({ telegramId: subId });

    const lang = ctx.state.user?.language || 'en';
    await ctx.editMessageText(t('subuser_removed', lang), Markup.inlineKeyboard([
      [Markup.button.callback(t('back', lang), `select_admin_${adminId}`)]
    ]));
  } catch (error) {
    logger.error('Remove sub error:', error);
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('subuser_remove_fail', lang)).catch(() => { });
  }
});

// ---------- Buyer: Manage Own Sub‑Users ----------
bot.action('manage_subs', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const buyer = ctx.state.user;
    const subs = await User.find({ telegramId: { $in: buyer.subUsers || [] } })
      .select('telegramId firstName telegramUsername downloadCount')
      .lean()
      .exec();

    const lang = ctx.state.user?.language || 'en';
    let text = `👥 **${t('your_users', lang)}**\n\n`;
    if (!subs.length) {
      text += t('no_users_remove', lang);
    } else {
      subs.forEach((sub, i) => {
        text += `${i + 1}. **${displayName(sub)}** (@${escMd(sub.telegramUsername) || 'N/A'})\n`;
        text += `   ${t('id_label', lang)} \`${sub.telegramId}\` | ${t('total_pdfs', lang)} ${sub.downloadCount || 0}\n`;
      });
    }

    const buttons = [
      [Markup.button.callback(t('add_user', lang), 'add_sub_self')]
    ];
    if (subs.length) {
      subs.forEach(sub => {
        buttons.push([Markup.button.callback(t('remove_btn', lang).replace('{name}', displayName(sub)), `remove_my_sub_${sub.telegramId}`)]);
      });
    }
    buttons.push([Markup.button.callback(t('back', lang), 'manage_users')]);

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (error) {
    logger.error('Manage subs error:', error);
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('subusers_load_fail', lang)).catch(() => { });
  }
});

// ---------- Buyer: Add Sub‑User (self) ----------
bot.action('add_sub_self', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    ctx.session = { ...ctx.session, step: 'AWAITING_SUB_IDENTIFIER' };
    const lang = ctx.state.user?.language || 'en';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(t('btn_cancel', lang), 'cancel_add_sub')]
    ]);
    await ctx.editMessageText(
      `${t('add_sub_title', lang)}\n\n${t('add_sub_prompt', lang)}`,
      { parse_mode: 'Markdown', ...keyboard }
    );
  } catch (error) {
    logger.error('Add sub self error:', error);
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('error_generic', lang)).catch(() => { });
  }
});

// ---------- Cancel Add Sub (go back to Manage Users screen) ----------
bot.action('cancel_add_sub', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    ctx.session = ctx.session || {}; ctx.session.step = null;
    await handleManageUsers(ctx, true);
  } catch (error) {
    logger.error('Cancel add sub error:', error);
  }
});

bot.action(/cancel_add_sub_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const adminId = ctx.match[1];
    ctx.session = ctx.session || {}; ctx.session.step = null;
    const admin = await User.findOne({ telegramId: adminId }).lean();
    if (!admin) {
      const lang = ctx.state.user?.language || 'en';
      return ctx.editMessageText(t('cancel_admin_not_found', lang));
    }
    const subs = await User.find({ telegramId: { $in: admin.subUsers || [] } })
      .select('telegramId firstName telegramUsername downloadCount')
      .lean()
      .exec();
    let text = `** Managing:** ${escMd(admin.firstName) || 'N/A'} (@${escMd(admin.telegramUsername) || 'N/A'}) \n`;
    text += `ID: \`${admin.telegramId}\`\n`;
    text += `PDFs: ${admin.downloadCount || 0} | Users: ${subs.length}\n\n`;
    text += `**Sub‑Users:**\n`;
    subs.forEach((sub, i) => {
      text += `${i + 1}. **${displayName(sub)}** (@${escMd(sub.telegramUsername) || 'N/A'})\n`;
      text += `   ID: \`${sub.telegramId}\` | PDFs: ${sub.downloadCount || 0}\n`;
    });
    const buttons = [
      [Markup.button.callback('➕ Add Sub‑User', `add_sub_admin_${adminId}`)],
      [Markup.button.callback('❌ Remove Sub‑User', `remove_sub_admin_${adminId}`)],
      [Markup.button.callback('🔙 Back to Users', 'manage_users')]
    ];
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    logger.error('Cancel add sub admin error:', e);
  }
});

// ---------- Buyer: Remove Own Sub‑User ----------
bot.action(/remove_my_sub_(\d+)/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const subId = ctx.match[1];
    const buyer = ctx.state.user;

    // Archive sub-user downloads before deletion (atomic operation)
    const sub = await User.findOne({ telegramId: subId }).select('downloadCount').lean();
    const dlCount = sub?.downloadCount || 0;
    await User.findOneAndUpdate(
      { telegramId: buyer.telegramId },
      { $pull: { subUsers: subId }, $inc: { archivedSubDownloads: dlCount } }
    );
    await User.deleteOne({ telegramId: subId });

    await ctx.editMessageText(`✅ Sub‑user removed.`, Markup.inlineKeyboard([
      [Markup.button.callback('👥 Manage Sub‑Users', 'manage_subs')]
    ]));
  } catch (error) {
    logger.error('Remove my sub error:', error);
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('subuser_remove_fail', lang)).catch(() => { });
  }
});

// ---------- Text Handler – Reply Keyboard Routing & Download Flow & Add Sub‑User ----------
bot.on('text', async (ctx) => {
  try {
    const text = ctx.message.text.trim();
    const state = ctx.session;
    const user = ctx.state.user;
    const lang = user.language || 'en';

    // --- Reply Keyboard button routing (context-aware download lock) ---
    const userId = ctx.from.id.toString();
    const hasActiveDownload = activeDownloads.has(userId);

    const isManage = text === t('btn_manage', 'en') || text === t('btn_manage', 'am') || text === t('btn_manage', 'om');
    const isDashboard = text === t('btn_dashboard', 'en') || text === t('btn_dashboard', 'am') || text === t('btn_dashboard', 'om');
    const isLanguage = text === t('btn_language', 'en') || text === t('btn_language', 'am') || text === t('btn_language', 'om');

    if (isManage || isDashboard || isLanguage) {
      // Non-download menus: auto-cancel any active download, then show menu
      if (hasActiveDownload) {
        activeDownloads.delete(userId);
        ctx.session = ctx.session || {};
        ctx.session.step = null;
        ctx.session.processingOTP = false;
        ctx.session.otpRetryCount = 0;
        await ctx.reply(t('download_cancelled', lang));
      }
      ctx.session = ctx.session || {};
      ctx.session.step = null;

      if (isLanguage) {
        await clearOldMenu(ctx);
        const titleSelection = t('lang_select', lang);
        const sentMsg = await ctx.reply(titleSelection, Markup.inlineKeyboard([
          [Markup.button.callback('English 🇺🇸', 'set_lang_en'), Markup.button.callback('Amharic 🇪🇹', 'set_lang_am')],
          [Markup.button.callback('Afaan-Oromo 🌳', 'set_lang_om')]
        ]));
        if (ctx.session) ctx.session.menuMessageId = sentMsg.message_id;
        return;
      }

      if (isManage) {
        return handleManageUsers(ctx, false);
      } else {
        try {
          if (user.role === 'admin') {
            return await handleDashboard(ctx, false);
          } else if (user.role === 'user') {
            return await handleUserDashboard(ctx, false);
          }
        } catch (e) {
          logger.error('Dashboard from keyboard error:', e);
          return ctx.reply(t('dashboard_load_fail', lang));
        }
      }
    }

    const isStart = text === t('btn_start', 'en') || text === t('btn_start', 'am') || text === t('btn_start', 'om');
    if (isStart) {
      // Silently cancel any active download and start fresh (no "Download Cancelled" message)
      if (hasActiveDownload) {
        activeDownloads.delete(userId);
      }
      ctx.session = ctx.session || {};
      ctx.session.step = null;
      ctx.session.processingOTP = false;
      ctx.session.otpRetryCount = 0;


      return handleDownload(ctx, false);
    }

    // --- Flow step processing ---
    if (!state || !state.step) {
      return;
    }

    // ----- Add Buyer Flow (Admin) -----
    if (state.step === 'AWAITING_BUYER_ID') {
      const lang = ctx.state.user?.language || 'en';
      const telegramId = text.trim().replace(/\s/g, '');
      if (!/^\d+$/.test(telegramId)) {
        return ctx.reply(t('enter_numeric_id', lang));
      }
      const statusMsg = await ctx.reply(t('looking_up', lang));
      try {
        let user = await User.findOne({ telegramId });
        if (!user) {
          ctx.session = ctx.session || {}; ctx.session.step = null;
          return ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
            t('user_not_started_start', lang)
          );
        }
        if (user.role === 'admin') {
          ctx.session = ctx.session || {}; ctx.session.step = null;
          return ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
            t('already_admin', lang)
          );
        }
        if (user.addedBy) {
          await User.updateOne({ telegramId: user.addedBy }, { $pull: { subUsers: user.telegramId } });
        }
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 30);
        user.role = 'admin';
        user.addedBy = undefined;
        user.expiryDate = expiryDate;
        user.subUsers = [];
        await user.save();
        ctx.session = ctx.session || {}; ctx.session.step = null;
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
          t('added_as_admin', lang).replace('{name}', displayName(user)),
          { parse_mode: 'Markdown' }
        );
        try {
          const uLang = user.language || 'en';
          await bot.telegram.sendMessage(user.telegramId, t('activated', uLang), { parse_mode: 'Markdown' });
          await bot.telegram.sendMessage(user.telegramId, getPanelTitle(user.role, uLang), { parse_mode: 'Markdown', ...getReplyKeyboard(user.role, uLang) });
        } catch (e) {
          logger.warn('Could not send menu to new admin:', e.message);
        }
      } catch (error) {
        logger.error('Add buyer error:', error);
        ctx.session = ctx.session || {}; ctx.session.step = null;
        ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
          t('error_generic', lang)
        ).catch(() => {
          ctx.reply(t('error_generic', lang));
        });
      }
      return;
    }

    // ----- Add User Under Admin: step 1 – admin ID -----
    if (state.step === 'AWAITING_ADMIN_ID_FOR_USER') {
      const lang = ctx.state.user?.language || 'en';
      const adminId = text.trim().replace(/\s/g, '');
      if (!/^\d+$/.test(adminId)) {
        return ctx.reply(t('enter_admin_id', lang));
      }
      const admin = await User.findOne({ telegramId: adminId, role: 'admin' });
      if (!admin) {
        return ctx.reply(t('no_admin_found_id', lang));
      }
      ctx.session.step = 'AWAITING_USER_ID_UNDER_ADMIN';
      ctx.session.adminIdForUser = adminId;
      await ctx.reply(
        t('admin_found', lang).replace('{name}', escMd(admin.firstName) || escMd(admin.telegramUsername) || adminId),
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(t('btn_cancel', lang), 'manage_users')]]) }
      );
      return;
    }

    // ----- Add User Under Admin: step 2 – user ID, then confirm and save -----
    if (state.step === 'AWAITING_USER_ID_UNDER_ADMIN') {
      const userId = text.trim().replace(/\s/g, '');
      if (!/^\d+$/.test(userId)) {
        return ctx.reply(t('enter_numeric_id', lang));
      }
      const adminId = state.adminIdForUser;
      const statusMsg = await ctx.reply(t('looking_up', lang));
      try {
        const admin = await User.findOne({ telegramId: adminId });
        if (!admin) {
          ctx.session = ctx.session || {}; ctx.session.step = null;
          return ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
            '❌ Admin no longer found. Cancelled.'
          );
        }
        const targetUser = await User.findOne({ telegramId: userId });
        if (!targetUser) {
          return ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
            '❌ That user has not started the bot yet. Ask them to send /start first.'
          );
        }
        if (targetUser.role === 'admin') {
          return ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
            '❌ That ID belongs to an admin. Choose a regular user.'
          );
        }
        if ((admin.subUsers || []).includes(userId)) {
          ctx.session = ctx.session || {}; ctx.session.step = null;
          return ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
            '❌ This user is already under this admin.'
          );
        }
        const maxSubs = typeof admin.maxSubUsers === 'number' ? admin.maxSubUsers : 9;
        if (maxSubs !== -1 && (admin.subUsers || []).length >= maxSubs) {
          return ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
            t('admin_limit_reached', lang).replace('{max}', maxSubs)
          );
        }
        if (targetUser.addedBy) {
          await User.updateOne({ telegramId: targetUser.addedBy }, { $pull: { subUsers: userId } });
        }
        admin.subUsers = admin.subUsers || [];
        admin.subUsers.push(userId);
        await admin.save();
        targetUser.role = 'user';
        targetUser.addedBy = adminId;
        targetUser.parentAdmin = adminId;
        targetUser.expiryDate = admin.expiryDate;
        await targetUser.save();
        ctx.session = ctx.session || {}; ctx.session.step = null;
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
          `✅ **${escMd(targetUser.firstName) || targetUser.telegramId}** added under admin **${escMd(admin.firstName) || adminId}**.`,
          { parse_mode: 'Markdown' }
        );
        try {
          const subUser = await User.findOne({ telegramId: userId });
          const subLang = subUser?.language || 'en';
          await bot.telegram.sendMessage(userId, t('activated', subLang), { parse_mode: 'Markdown' });
          await bot.telegram.sendMessage(userId, getPanelTitle('user', subLang), { parse_mode: 'Markdown', ...getReplyKeyboard('user', subLang) });
        } catch (e) {
          logger.warn('Could not send activation to user:', e.message);
        }
      } catch (error) {
        logger.error('Add user under admin error:', error);
        ctx.session = ctx.session || {}; ctx.session.step = null;
        ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
          '❌ Failed to add user. Please try again.'
        ).catch(() => {
          ctx.reply(t('error_generic', lang));
        });
      }
      return;
    }

    // ----- Add Sub‑User Flow -----
    if (state.step === 'AWAITING_SUB_IDENTIFIER') {
      const buyerId = state.adminForAdd || ctx.from.id.toString();
      const buyer = await User.findOne({ telegramId: buyerId });

      if (!buyer) {
        ctx.session = ctx.session || {}; ctx.session.step = null;
        return ctx.reply(t('buyer_not_found', lang));
      }

      const telegramId = text.trim().replace(/\s/g, '');
      if (!/^\d+$/.test(telegramId)) {
        return ctx.reply(t('enter_numeric_id', lang));
      }

      const statusMsg = await ctx.reply(t('looking_up', lang));

      try {
        let subUser = await User.findOne({ telegramId });
        if (!subUser) {
          ctx.session = ctx.session || {}; ctx.session.step = null;
          return ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
            t('user_not_started_start', lang)
          );
        }

        const maxSubs = typeof buyer.maxSubUsers === 'number' ? buyer.maxSubUsers : 9;
        if (maxSubs !== -1 && (buyer.subUsers || []).length >= maxSubs) {
          ctx.session = ctx.session || {}; ctx.session.step = null;
          return ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
            t('buyer_limit_reached', lang).replace('{max}', maxSubs)
          );
        }
        if ((buyer.subUsers || []).includes(subUser.telegramId)) {
          ctx.session = ctx.session || {}; ctx.session.step = null;
          return ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
            t('user_already_employee', lang)
          );
        }

        buyer.subUsers = buyer.subUsers || [];
        buyer.subUsers.push(subUser.telegramId);
        await buyer.save();

        subUser.role = 'user';
        subUser.addedBy = buyer.telegramId;
        subUser.parentAdmin = buyer.telegramId;
        subUser.expiryDate = buyer.expiryDate;
        await subUser.save();

        ctx.session = ctx.session || {}; ctx.session.step = null;
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
          t('user_added_success', lang)
        );
        try {
          const uLang = subUser.language || 'en';
          await bot.telegram.sendMessage(subUser.telegramId, t('activated', uLang), { parse_mode: 'Markdown' });
          await bot.telegram.sendMessage(subUser.telegramId, getPanelTitle('user', uLang), { parse_mode: 'Markdown', ...getReplyKeyboard('user', uLang) });
        } catch (e) {
          logger.warn('Could not send menu to new user:', e.message);
        }
      } catch (error) {
        logger.error('Add sub error:', error);
        ctx.session = ctx.session || {}; ctx.session.step = null;
        ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
          t('fail_add_employee', lang)
        ).catch(() => {
          ctx.reply(t('fail_add_employee', lang));
        });
      }
      return;
    }

    // ----- Download Flow: ID Step -----
    if (state.step === 'ID') {
      const validation = validateFaydaId(text, lang);
      if (!validation.valid) {
        return ctx.reply(`❌ ${validation.error}`, { parse_mode: 'Markdown' });
      }

      const userId = ctx.from.id.toString();

      // Per-user download lock — reject if already downloading
      if (activeDownloads.has(userId)) {
        return ctx.reply(t('already_downloading', lang));
      }

      // Verification cooldown — prevent OTP flood on Fayda API
      const lastFail = verificationCooldown.get(userId);
      if (lastFail && (Date.now() - lastFail) < VERIFICATION_COOLDOWN_MS) {
        const waitSec = Math.ceil((VERIFICATION_COOLDOWN_MS - (Date.now() - lastFail)) / 1000);
        return ctx.reply(t('error_rate_limit', lang).replace('{waitTime}', waitSec));
      }

      activeDownloads.set(userId, true);
      ctx.session.id = validation.value;
      ctx.session.verificationMethod = validation.type || 'FCN';
      ctx.session.step = 'OTP';
      ctx.session._verifyStartTime = Date.now();

      // Removed early OTP prompt to avoid confusion
      const timer = new DownloadTimer(userId);

      // --- SIMULATION MODE Branch ---
      if (SIMULATION_MODE) {
        (async () => {
          logger.info(`[Simulation] Starting ID verification for user ${userId}`);
          timer.startStep('idVerification');
          await new Promise(r => setTimeout(r, 1500)); // Simulate network lag
          timer.endStep('idVerification');
          timer.setPhase('idPhaseMs', Date.now() - timer.flowStart);

          ctx.session.transactionId = 'sim-transaction-' + Date.now();
          ctx.session._timer = timer.toSession();
          verificationCooldown.delete(userId);
          await ctx.reply(`✅ (Simulation) ${t('enter_otp', lang)}`, { parse_mode: 'Markdown' });
        })();
        return;
      }

      // Branch: Mobile APP API vs Resident Portal (Captcha) API
      if (process.env.FAYDA_APP_API_KEY) {
        // --- Modern Flow: Mobile App API ---
        (async () => {
          try {
            timer.startStep('idVerification');
            const response = await faydaApp.sendOtp(validation.value, validation.type || 'FCN');
            timer.endStep('idVerification');
            timer.setPhase('idPhaseMs', Date.now() - timer.flowStart);

            if (response && response.success) {
              ctx.session.transactionId = response.transactionId;
              ctx.session._timer = timer.toSession();
              verificationCooldown.delete(userId);
              await ctx.reply(`✅ ${t('enter_otp', lang)}`, { parse_mode: 'Markdown' });
            }
          } catch (error) {
            timer.endStep('idVerification');
            timer.report('id_verification_failed');
            verificationCooldown.set(userId, Date.now());
            activeDownloads.delete(userId);
            ctx.session.step = null;
            const rawMsg = error.message || '';
            const userMsg = /too many|limit|wait|429/i.test(rawMsg) ? t('error_rate_limit', lang).replace('{waitTime}', 'few') : t('id_error', lang);
            await ctx.reply(userMsg).catch(() => { });
          }
        })();
      } else {
        // --- Legacy Flow: Resident Portal API (Captcha) ---
        const verifyPromise = (async () => {
          let lastErr;
          let apiWasCalled = false;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              timer.startStep('captchaSolve');
              let captchaToken = null;
              if (attempt === 1 && pendingCaptchas.has(userId)) {
                captchaToken = await pendingCaptchas.get(userId);
                pendingCaptchas.delete(userId);
              }
              if (!captchaToken) {
                const result = await solver.recaptcha(SITE_KEY, 'https://resident.fayda.et/', {
                  ...RECAPTCHA_OPTS,
                  headers: {
                    'Origin': 'https://resident.fayda.et',
                    'Referer': 'https://resident.fayda.et/',
                    'Accept-Encoding': 'gzip, deflate'
                  }
                });
                captchaToken = result.data;
              }
              timer.endStep('captchaSolve');

              timer.startStep('idVerification');
              apiWasCalled = true;
              const res = await fayda.api.post('/verify', {
                idNumber: validation.value,
                verificationMethod: validation.type || 'FCN',
                captchaValue: captchaToken
              }, { timeout: 35000 });
              timer.endStep('idVerification');

              console.log('DEBUG: Fayda Verify Response:', JSON.stringify(res.data));
              fs.appendFileSync('debug_fayda.log', `[${new Date().toISOString()}] USER ${userId} VERIFY SUCCESS: ${JSON.stringify(res.data)}\n`);
              verificationCooldown.delete(userId);
              timer.setPhase('idPhaseMs', Date.now() - timer.flowStart);
              return { success: true, token: res.data.token, timer };
            } catch (e) {
              console.log(`DEBUG: ID Verification attempt ${attempt} failed:`, e.message);
              if (e.response) {
                console.log(`DEBUG: API Error Detail:`, JSON.stringify(e.response.data));
              }
              timer.endStep('captchaSolve');
              timer.endStep('idVerification');
              lastErr = e;
              if (e.response?.status >= 400 && e.response?.status < 500) break;
            }
          }
          if (apiWasCalled) verificationCooldown.set(userId, Date.now());
          const rawMsg = lastErr?.response?.data?.message || lastErr?.message || '';
          console.log(`DEBUG: ID Verification FAILED for ${userId}:`, rawMsg);
          fs.appendFileSync('debug_fayda.log', `[${new Date().toISOString()}] USER ${userId} VERIFY FAILED: ${rawMsg} | Details: ${JSON.stringify(lastErr?.response?.data || {})}\n`);
          timer.report('id_verification_failed');
          return { success: false, error: rawMsg, timer };
        })();

        verifyPromise.then(result => {
          if (pendingVerifications.get(userId) !== verifyPromise) return;
          if (result.success) {
            ctx.reply(`✅ ${t('enter_otp', lang)}`, { parse_mode: 'Markdown' }).catch(() => { });
          } else {
            const rawMsg = result.error || '';
            const userMsg = /too many|limit|wait/i.test(rawMsg) ? t('error_rate_limit', lang).replace('{waitTime}', 'few') : t('id_error', lang);
            ctx.reply(userMsg).catch(() => { });
            activeDownloads.delete(userId);
            ctx.session.step = null;
          }
        }).catch(() => { });

        pendingVerifications.set(userId, verifyPromise);
      }
      return;
    }

    // ----- Download Flow: OTP Step -----
    if (state.step === 'OTP') {
      const userId = ctx.from.id.toString();

      // Staleness check (Fix 5)
      const maxOtpSessionAge = 5 * 60 * 1000; // 5 minutes
      if (state._verifyStartTime && (Date.now() - state._verifyStartTime) > maxOtpSessionAge) {
        activeDownloads.delete(userId);
        ctx.session = ctx.session || {}; ctx.session.step = null;
        return ctx.reply(t('session_expired', lang));
      }

      // Prevent duplicate processing (atomic lock against webhook retries)
      if (processingOTPs.has(userId) || state.processingOTP) {
        logger.warn('Duplicate OTP request ignored (already processing)', { userId });
        return; // Already processing, ignore duplicate webhook retry
      }
      processingOTPs.add(userId);
      state.processingOTP = true;

      const validation = validateOTP(text, lang);
      if (!validation.valid) {
        state.processingOTP = false;
        return ctx.reply(`❌ ${validation.error}.`);
      }
      const statusMsg = await ctx.reply(t('otp_verifying', lang));

      // --- SIMULATION MODE Branch ---
      if (SIMULATION_MODE) {
        let timer;
        try {
          timer = DownloadTimer.fromSession(state._timer, userId);
          logger.info(`[Simulation] Verifying OTP for user ${userId}`);
          timer.startStep('otpValidation');
          await new Promise(r => setTimeout(r, 1500)); // Simulate verification
          timer.endStep('otpValidation');
          
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, t('otp_verified_fetching', lang)).catch(() => { });

          timer.startStep('pdfFetch');
          await new Promise(r => setTimeout(r, 1500)); // Simulate fetch
          timer.endStep('pdfFetch');

          timer.startStep('pdfConversion');
          // Use sample file
          let pdfPath = fs.existsSync('sample_output.pdf') ? 'sample_output.pdf' : 'assets/fayda_template.pdf';
          const pdfBuffer = fs.readFileSync(pdfPath);
          timer.endStep('pdfConversion');

          timer.startStep('telegramUpload');
          await ctx.replyWithDocument({ source: pdfBuffer, filename: `Simulation_Fayda_ID.pdf` }, { caption: `✅ (Simulation) ${t('digital_id_ready', lang)}` });
          timer.endStep('telegramUpload');

          // NOTE: Simulation mode does NOT increment downloadCount.
          // Only real ID downloads should count toward user statistics.
          ctx.session.step = null;
          activeDownloads.delete(userId);
          if (state._verifyStartTime) timer.setPhase('otpPhaseMs', Date.now() - state._verifyStartTime);
          timer.report('success_simulation');
        } catch (e) {
          logger.error("[Simulation] OTP Error:", e.message);
          activeDownloads.delete(userId);
          ctx.session.step = null;
          await ctx.reply(`❌ Simulation error: ${e.message}`);
        } finally {
          processingOTPs.delete(userId);
          state.processingOTP = false;
        }
        return;
      }

      // Branch: Mobile APP API vs Resident Portal (Captcha) API
      if (process.env.FAYDA_APP_API_KEY) {
        // --- Modern Flow: Mobile App API ---
        const transactionId = state.transactionId;
        if (!transactionId) {
          state.processingOTP = false;
          activeDownloads.delete(userId);
          ctx.session.step = null;
          return ctx.reply(t('error_session', lang));
        }

        let timer;
        try {
          timer = DownloadTimer.fromSession(state._timer, userId);
          timer.startStep('otpValidation');
          const otpResponse = await faydaApp.verifyOtp(validation.value, transactionId, state.id);
          timer.endStep('otpValidation');
          state.otpRetryCount = 0;
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, t('otp_verified_fetching', lang)).catch(() => { });

          timer.startStep('pdfConversion');
          const { userData, images } = otpResponse;
          const pdfBuffer = await buildFaydaPdf(userData, images);
          timer.endStep('pdfConversion');

          const safeName = (userData.fullName_eng || 'Fayda_Card').replace(/[^a-zA-Z0-9]/g, '_');
          timer.startStep('telegramUpload');
          await ctx.replyWithDocument({ source: pdfBuffer, filename: `${safeName}.pdf` }, { caption: t('digital_id_ready', lang) });
          timer.endStep('telegramUpload');

          await incrementUserDownload(userId);
          ctx.session.step = null;
          activeDownloads.delete(userId);
          if (state._verifyStartTime) timer.setPhase('otpPhaseMs', Date.now() - state._verifyStartTime);
          timer.report('success');
        } catch (e) {
          if (timer) timer.endStep('otpValidation');
          const isInvalidOtp = /invalid otp/i.test(e.message) || (e.response && e.response.status === 400);
          if (isInvalidOtp) {
            const retryCount = state.otpRetryCount || 0;
            if (retryCount < 2) {
              state.otpRetryCount = retryCount + 1;
              state.processingOTP = false;
              await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, t('otp_retry', lang)).catch(() => { });
              return;
            }
          }
          logger.error("OTP Error (Mobile):", e.message);
          activeDownloads.delete(userId);
          ctx.session.step = null;
          await ctx.reply(`❌ ${e.message || 'Verification failed.'}`);
        } finally {
          processingOTPs.delete(userId);
          state.processingOTP = false;
        }
      } else {
        // --- Legacy Flow: Resident Portal API (Captcha) ---
        try {
          let verifyResult;
          if (pendingVerifications.has(userId)) {
            verifyResult = await pendingVerifications.get(userId);
            pendingVerifications.delete(userId);
          } else {
            logger.error('No pending verification found for user', { userId });
            state.processingOTP = false;
            activeDownloads.delete(userId);
            ctx.session.step = null;
            return ctx.reply(t('error_session', lang));
          }

          if (!verifyResult.success) {
            state.processingOTP = false;
            activeDownloads.delete(userId);
            ctx.session.step = null;
            return ctx.reply(verifyResult.error || t('id_error', lang));
          }

          const timer = verifyResult.timer;
          state.tempJwt = verifyResult.token;
          const authHeader = { ...HEADERS, 'Authorization': `Bearer ${state.tempJwt}` };

          timer.startStep('otpValidation');
          const otpResponse = await fayda.api.post('/validateOtp', {
            otp: validation.value,
            uniqueId: state.id,
            verificationMethod: state.verificationMethod || 'FCN'
          }, { headers: authHeader, timeout: 35000 });
          timer.endStep('otpValidation');

          const { signature, uin, fullName } = otpResponse.data;
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, t('otp_verified_fetching', lang)).catch(() => { });

          // Start PDF fetch (with retries for 502/504)
          timer.startStep('pdfFetch');
          let pdfResponse;
          let pdfError;
          for (let pdfAttempt = 1; pdfAttempt <= 3; pdfAttempt++) {
            try {
              console.log(`DEBUG: PDF Fetch attempt ${pdfAttempt} for ${userId}...`);
              pdfResponse = await fayda.api.post('/printableCredentialRoute', { uin, signature }, {
                headers: authHeader,
                responseType: 'text',
                timeout: 60000
              });
              fs.appendFileSync('debug_fayda.log', `[${new Date().toISOString()}] USER ${userId} PDF FETCH SUCCESS\n`);
              break; // Success!
            } catch (err) {
              pdfError = err;
              console.log(`DEBUG: PDF Fetch attempt ${pdfAttempt} failed: ${err.message}`);
              fs.appendFileSync('debug_fayda.log', `[${new Date().toISOString()}] USER ${userId} PDF FETCH ATTEMPT ${pdfAttempt} FAILED: ${err.message} | Status: ${err.response?.status}\n`);
              if (pdfAttempt < 3 && [502, 503, 504].includes(err.response?.status)) {
                await new Promise(r => setTimeout(r, 3000));
                continue;
              }
              break;
            }
          }
          timer.endStep('pdfFetch');

          if (!pdfResponse) {
             throw pdfError || new Error("Fayda PDF service unavailable (502). Please try again in 5 minutes.");
          }

          timer.startStep('pdfConversion');
          const { buffer: pdfBuffer } = parsePdfResponse(pdfResponse.data);
          timer.endStep('pdfConversion');

          const safeName = (fullName?.eng || 'Fayda_Card').replace(/[^a-zA-Z0-9]/g, '_');
          timer.startStep('telegramUpload');
          await ctx.replyWithDocument({ source: pdfBuffer, filename: `${safeName}.pdf` }, { caption: t('digital_id_ready', lang) });
          timer.endStep('telegramUpload');

          await incrementUserDownload(userId);
          ctx.session.step = null;
          activeDownloads.delete(userId);
          timer.report('success');
        } catch (e) {
          logger.error("OTP Error (Legacy):", e.message);
          activeDownloads.delete(userId);
          ctx.session.step = null;
          await ctx.reply(`❌ ${e.response?.data?.message || e.message || 'Download failed.'}`);
        } finally {
          processingOTPs.delete(userId);
          state.processingOTP = false;
        }
      }
      return;
    }
  } catch (error) {
    logger.error('Text handler error:', {
      message: error.message,
      stack: error.stack,
      status: error.response?.status,
      response: safeResponseForLog(error.response?.data)
    });
    // Safety net: clean up ALL state if an error escapes inner catches (C3)
    const uid = ctx.from?.id?.toString();
    if (uid) {
      activeDownloads.delete(uid);
      processingOTPs.delete(uid);
    }
    if (ctx.session) {
      ctx.session.step = null;
      ctx.session.processingOTP = false;
      ctx.session.otpRetryCount = 0;
    }
    const lang = ctx.state.user?.language || 'en';
    ctx.reply(t('error_generic', lang)).catch(() => { });
  }
});

// ---------- Graceful Shutdown ----------
async function gracefulShutdown(signal) {
  logger.info(`${signal} received, starting graceful shutdown...`);

  try {
    // bot.stop() only works with polling (bot.launch()), not webhooks
    // In webhook mode the bot is not "running" so stop() throws
    try { await bot.stop(signal); } catch (_) { /* webhook mode — ignore */ }

    await disconnectDB();
    await pdfQueue.close();
    // Flush and quit Redis client gracefully
    try {
      const { redisClient } = require('./utils/rateLimiter');
      await redisClient.quit();
    } catch (e) {
      logger.error('Error closing Redis during shutdown:', e.message);
    }
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', { message: error.message, stack: error.stack });
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ---------- Start Server ----------
let isInitialized = false;

async function initializeBackgroundTasks() {
  try {
    // 1. Connect to database
    logger.info('💾 Background: Connecting to MongoDB...');
    await connectDB();
    logger.info('✅ Background: MongoDB connected');

    // 2. Run migrations
    logger.info('🔧 Background: Running role migrations...');
    await migrateRoles();
    logger.info('✅ Background: Migrations complete');

    isInitialized = true;
    logger.info('⭐ Background: Bot is fully initialized and operational');
  } catch (err) {
    logger.error("❌ Background: Initialization failure:", err);
    // We don't exit(1) here because the web server is already running
    // This allows the user to see the error in logs while the process stays alive
  }
}

async function startServer() {
  logger.info('🚀 High-Priority: Starting Express server...');
  try {
    // 1. Setup periodic cleanup (safe to start early)
    setInterval(() => {
      const now = Date.now();
      let cooldownCleared = 0;
      for (const [userId, timestamp] of verificationCooldown.entries()) {
        if (now - timestamp > VERIFICATION_COOLDOWN_MS) {
          verificationCooldown.delete(userId);
          cooldownCleared++;
        }
      }
      if (cooldownCleared > 0) logger.info(`Cleaned up ${cooldownCleared} expired verification cooldowns`);
    }, 15 * 60 * 1000);

    // 2. Set webhook or use Polling
    const webhookPath = '/webhook';
    let webhookDomain = process.env.WEBHOOK_DOMAIN || '';
    
    // Improved detection: 
    // - Force polling if FAYDA_LOCAL_DEV is true
    // - Use polling if no webhook domain is set
    // - Use polling if we're clearly not on a production platform (no RAILWAY_STATIC_URL, etc.)
    const isLocal = process.env.FAYDA_LOCAL_DEV === 'true' || 
                   !webhookDomain || 
                   (!process.env.RAILWAY_STATIC_URL && process.env.NODE_ENV !== 'production');

    console.log('DEBUG: bot startup isLocal status:', isLocal, 'WebhookDomain:', webhookDomain);

    if (!isLocal && webhookDomain) {
      logger.info('🛜 High-Priority: Configuring Telegram webhook...');
      if (!webhookDomain.startsWith('http')) {
        webhookDomain = `https://${webhookDomain}`;
      }
      const webhookUrl = `${webhookDomain}${webhookPath}`;
      
      try {
        await bot.telegram.setWebhook(webhookUrl);
        logger.info(`✅ Webhook configured: ${webhookUrl}`);
        app.use(bot.webhookCallback(webhookPath));
      } catch (whErr) {
        logger.error('⚠️ Webhook set failed:', whErr.message);
      }
    } else {
      logger.info('🔌 Local Environment: Starting bot with Long Polling...');
      try {
        // Clear any previous webhook so polling works
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        logger.info('🗑️ Previous webhook deleted');
        
        console.log('DEBUG: Launching bot...');
        bot.launch({
          allowedUpdates: ['message', 'callback_query', 'my_chat_member']
        }).then(() => {
          console.log('DEBUG: Bot launched successfully!');
          logger.info('✅ Bot started via Long Polling');
        }).catch(err => {
          console.log('DEBUG: Bot launch FAILED!');
          logger.error('❌ Bot launch failed (Async):', err);
        });
      } catch (pollErr) {
        logger.error('⚠️ Polling setup failed (Sync):', pollErr);
      }
    }

    // 3. Start Express IMMEDIATELY to pass health checks
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      logger.info(`🚀 Server listening on port ${PORT} (Marked as ONLINE by Railway)`);
      
      // 4. Trigger background initialization
      initializeBackgroundTasks();
    });

  } catch (err) {
    logger.error("❌ FATAL: Failed to start web server:", err);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { app, bot, startServer };
