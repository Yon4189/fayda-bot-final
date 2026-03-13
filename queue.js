const Queue = require('bull');
const bot = require('./bot');
const User = require('./models/User');
const logger = require('./utils/logger');
const { safeResponseForLog } = require('./utils/logger');
const { sanitizeFilename } = require('./utils/validators');
const { parsePdfResponse } = require('./utils/pdfHelper');
const { getMainMenu } = require('./utils/menu');
const fayda = require('./utils/faydaClient');
const { DownloadTimer } = require('./utils/timer');
const { t } = require('./utils/i18n');
const PDF_FETCH_ATTEMPTS = 3;
const PDF_FETCH_RETRY_DELAY_MS = 2000;
const PDF_QUEUE_CONCURRENCY = Math.min(Math.max(parseInt(process.env.PDF_QUEUE_CONCURRENCY, 10) || 10, 1), 50);


// Bull queue configuration - use Redis URL directly
const pdfQueue = new Queue('pdf generation', process.env.REDIS_URL, {
  redis: {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    keepAlive: 10000,
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    }
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000
    },
    removeOnComplete: {
      age: 3600, // Keep completed jobs for 1 hour
      count: 1000 // Keep max 1000 completed jobs
    },
    removeOnFail: {
      age: 24 * 3600 // Keep failed jobs for 24 hours
    }
  },
  settings: {
    maxStalledCount: 1,
    retryProcessDelay: 5000
  }
});

// Queue event handlers
pdfQueue.on('completed', (job) => {
  logger.info(`PDF job completed for user ${job.data.userId}`);
});

pdfQueue.on('failed', async (job, err) => {
  logger.error(`PDF job failed for user ${job.data.userId}:`, err.message);
  // Notify user so they know to try again
  try {
    const chatId = job?.data?.chatId;
    if (chatId) {
      const lang = job.data?.language || 'en';
      await bot.telegram.sendMessage(
        chatId,
        t('pdf_fail_queue', lang)
      );
    }
  } catch (notifyErr) {
    logger.error('Failed to notify user of PDF job failure:', notifyErr.message);
  }
});

pdfQueue.on('stalled', (job) => {
  logger.warn(`PDF job stalled for user ${job.data.userId}`);
});

pdfQueue.on('error', (err) => {
  if (err.message && err.message.includes('ECONNRESET')) return;
  logger.error('Bull queue Redis error:', { message: err.message });
});

logger.info(`PDF queue worker started with concurrency ${PDF_QUEUE_CONCURRENCY}`);

// Worker: processes jobs concurrently (configurable for 100–300 users; default 10)
pdfQueue.process(PDF_QUEUE_CONCURRENCY, async (job) => {
  const { chatId, userId, userRole, language, authHeader, pdfPayload, fullName, _timer } = job.data;
  const lang = language || 'en';

  // Restore or create timer (preserves requestId from sync flow if available)
  const timer = DownloadTimer.fromSession(_timer, userId);

  try {
    // 1. Fetch PDF from Fayda with retries for transient failures
    let pdfResponse;
    let lastError;
    timer.startStep('pdfFetch');
    for (let attempt = 1; attempt <= PDF_FETCH_ATTEMPTS; attempt++) {
      try {
        pdfResponse = await fayda.api.post('/printableCredentialRoute', pdfPayload, {
          headers: authHeader,
          responseType: 'text',
          timeout: 30000
        });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        const isRetryable = !err.response || (err.response.status >= 500 && err.response.status < 600) || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET';
        if (attempt < PDF_FETCH_ATTEMPTS && isRetryable) {
          logger.warn(`PDF fetch attempt ${attempt} failed for user ${userId}, retrying in ${PDF_FETCH_RETRY_DELAY_MS}ms:`, err.message);
          await new Promise(r => setTimeout(r, PDF_FETCH_RETRY_DELAY_MS));
        } else {
          throw lastError;
        }
      }
    }
    timer.endStep('pdfFetch');

    timer.startStep('pdfConversion');
    const { buffer: pdfBuffer } = parsePdfResponse(pdfResponse.data);
    timer.endStep('pdfConversion');

    // 2. Generate filename from fullName (sanitize)
    const filename = `${sanitizeFilename(fullName?.eng)}.pdf`;

    // 3. Send PDF via Telegram
    timer.startStep('telegramUpload');
    await bot.telegram.sendDocument(chatId, {
      source: pdfBuffer,
      filename: filename
    }, { caption: t('digital_id_ready', lang) });
    timer.endStep('telegramUpload');

    // 4. Send main menu so user can continue
    const menu = getMainMenu(userRole || 'user', lang);
    await bot.telegram.sendMessage(chatId, t('main_menu_title', lang), {
      parse_mode: 'Markdown',
      ...menu
    });

    // 5. Increment download count and update history for the user
    // We fetch the user first to cleanly manage the history array
    const userDoc = await User.findOne({ telegramId: userId });
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

    logger.info(`PDF sent successfully to user ${userId}`);
    timer.report('success_queued');
    return { success: true };
  } catch (error) {
    timer.endStep('pdfFetch');      // no-op if already ended
    timer.endStep('pdfConversion'); // no-op if not started
    timer.endStep('telegramUpload');
    logger.error(`Job failed for user ${userId}:`, {
      message: error.message,
      stack: error.stack,
      status: error.response?.status,
      response: safeResponseForLog(error.response?.data)
    });
    timer.report('failed_queued');
    // Rethrow so Bull retries
    throw error;
  }
});


module.exports = pdfQueue;