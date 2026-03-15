# Fayda Bot

A scalable Telegram bot for downloading Fayda ID documents with subscription management.

## Features

- 📥 Download Fayda ID PDFs via Telegram
- 👥 User management system (Admin, Buyer, Sub-user roles)
- 📊 Dashboard for tracking downloads and users
- ⚡ Queue-based PDF processing for scalability
- 🛡️ Rate limiting and security features
- 📈 Optimized for 300+ concurrent users

## Prerequisites

- Node.js 18+ 
- MongoDB database
- Redis instance
- Telegram Bot Token
- 2Captcha API key

## Environment Variables

Create a `.env` file with the following variables:

```env
# Bot Configuration
BOT_TOKEN=your_telegram_bot_token

# Database
MONGODB_URI=mongodb://localhost:27017/fayda_bot
REDIS_URL=redis://localhost:6379

# Session & Security
SESSION_SECRET=your_random_secret_key_here

# Deployment
WEBHOOK_DOMAIN=https://your-domain.com
PORT=3000
NODE_ENV=production

# Optional – Web dashboard (Super Admin, same options as bot):
# ADMIN_USER=admin
# ADMIN_PASS=your_secure_password

# Optional – faster under heavy load (50+ concurrent downloads):
# PDF_QUEUE_CONCURRENCY=20
# PREFER_QUEUE_PDF=true
```

## Installation

```bash
# Install dependencies
npm install

# Create logs directory
mkdir -p logs

# Start the application
npm start
```

## Deployment Options

### Option 1: Docker (Recommended)

```bash
# Build and run with Docker Compose
docker-compose up -d

# Or build and run manually
docker build -t fayda-bot .
docker run -d --env-file .env -p 3000:3000 fayda-bot
```

### Option 2: PM2 (Production)

```bash
# Install PM2 globally
npm install -g pm2

# Start with PM2
npm run pm2:start

# Monitor
pm2 monit

# View logs
pm2 logs fayda-bot
```

### Option 3: Render.com

1. Connect your GitHub repository
2. Set environment variables in Render dashboard
3. Set build command: `npm install`
4. Set start command: `node index.js`
5. Deploy!

### Option 4: Railway.app

1. Connect your GitHub repository
2. Add environment variables
3. Railway will auto-detect and deploy

### Option 5: DigitalOcean App Platform

1. Connect your GitHub repository
2. Configure environment variables
3. Set build command: `npm install`
4. Set start command: `node index.js`
5. Deploy!

## Architecture

### Scalability Features

- **Connection Pooling**: MongoDB connection pool (5-50 connections)
- **Queue System**: Bull queue with Redis for async PDF processing
- **Rate Limiting**: Per-user and per-IP rate limiting
- **Database Indexes**: Optimized queries with proper indexes
- **Error Handling**: Comprehensive error handling and logging
- **Health Checks**: `/health` endpoint for monitoring

### Performance Optimizations

- Batch database queries to avoid N+1 problems
- **Sync-first PDF**: Download is attempted immediately after OTP (no Redis on happy path); queue is used only when sync fails or for retries.
- Async job processing for PDF generation (Bull + Redis)
- Connection reuse and pooling
- Efficient session management

### Scaling for 100–300 Users

- **Railway / Render / Fly.io**: One web process is enough for 100–300 users. The bot is I/O-bound (Fayda API, 2Captcha, MongoDB).
- **Faster PDF delivery**: Set `PDF_QUEUE_CONCURRENCY=15` (or 20) so more PDF jobs run in parallel when the queue is used. Don’t set too high or the Fayda API may rate-limit.
- **Hosting for max speed**: Deploy in a region close to your users or to the Fayda API (e.g. same cloud region). Railway and Render use AWS; choose a region with low latency to Ethiopia if most users are there.
- **MongoDB / Redis**: Use managed services (MongoDB Atlas, Upstash Redis) in the same region as the app to reduce latency.

### Free tier: Railway + MongoDB Atlas + Upstash Redis

Using the **free** plans for all three is enough for this bot at moderate scale (dozens to low hundreds of users, not all hitting at once):

| Service | Free tier | Enough? |
|--------|-----------|--------|
| **Railway** | $1/month credit, 0.5 GB RAM, 1 vCPU (or $5 trial with 1 GB RAM) | Yes. PDFs are handled one-at-a-time per user (sync-first); queue only used when sync fails. Keep `PDF_QUEUE_CONCURRENCY=5` on 0.5 GB to be safe. |
| **MongoDB Atlas** | M0 cluster, 512 MB storage | Yes. Only user metadata and sessions are stored; no PDFs in DB. |
| **Upstash Redis** | 256 MB, 500K commands/month, 10 GB bandwidth | Yes. Bull stores only job metadata (no PDF content); rate-limit keys are small. |

**Large PDF responses:** The Fayda API returns the PDF as base64 (~1.8–2 MB string). The app is built for this: response is parsed in memory, never stored in Redis or MongoDB, and logs never include the full body (only truncated or status). A 8 MB cap rejects obviously bad responses to avoid OOM.

### Zero-failure setup (paid hosting)

For **no sleep, no random restarts, and best uptime**:

| What | Recommendation |
|------|-----------------|
| **Railway** | Use **Hobby plan** (~$5/month): no sleep, more RAM, no $1 cap. Free tier can sleep and has 0.5 GB RAM. |
| **MongoDB Atlas** | Free M0 is fine; for production you can use M2/M5 if you want backups and more headroom. |
| **Upstash Redis** | Free tier is enough; upgrade only if you exceed 500K commands/month. |
| **2Captcha** | Keep enough balance so captcha solves don’t fail; the bot retries 3 times then shows a clear error. |

**Monitoring:** Use `GET /health` for a simple alive check and `GET /health/ready` for a readiness check (returns 200 only if MongoDB and Redis are reachable; use it for k8s/load balancer readiness).

### What happens when 50 people use the bot at the same time?

| Phase | What happens |
|-------|----------------|
| **All 50 tap menus** (Download ID, Dashboard, etc.) | No problem. Each request does a quick DB read + Telegram API call. Node handles 50 concurrent I/O requests easily; MongoDB and Redis handle the load. |
| **50 people all enter Fayda ID** | All 50 see “⏳ Solving Captcha…”. The bot sends 50 captcha tasks to **2Captcha**. 2Captcha has its own queue: they process in order (or in parallel on their side). So **2Captcha is the bottleneck**: some users get “Captcha solved” in ~15–30 s, others may wait 1–2 min. The bot retries up to 3 times if 2Captcha fails. |
| **50 people all enter OTP** | 50 `validateOtp` calls hit the **Fayda API** (with 2 retries each on 5xx/network). Then 50 **sync PDF** requests. If Fayda throttles or is slow, some requests may fail after retries and their job is **queued**. |
| **Queue** | PDF jobs that don’t complete in sync are added to Redis. The **queue worker** runs **PDF_QUEUE_CONCURRENCY** jobs at once (default 10). So at most 10 PDFs are fetched from Fayda at the same time; the rest wait in the queue. Those users already saw “Your request has been queued. You will receive your PDF shortly.” and get the PDF when their job runs (typically within 1–2 minutes). |
| **Rate limit** | Each user is limited to **30 actions per minute**. So 50 users = up to 1,500 actions/min total, which is fine for MongoDB/Redis. |

**Summary:** The app accepts all 50; no one gets “server busy”. The real limits are **2Captcha** (captcha solve speed) and **Fayda API** (how many verify/validateOtp/PDF calls they allow at once). Retries and the queue smooth this out.

### Making it faster for 50+ concurrent downloads

| What | Why it helps |
|------|----------------|
| **`PREFER_QUEUE_PDF=true`** | Skip the immediate (sync) PDF fetch and always add a job to the queue. Under load, 50 sync requests can trigger Fayda throttling; with the queue you send at most **PDF_QUEUE_CONCURRENCY** requests at a time (e.g. 20). Fewer throttles and retries, so the queue drains faster. |
| **`PDF_QUEUE_CONCURRENCY=20`** (or 25) | More PDF jobs run in parallel. With `PREFER_QUEUE_PDF=true`, this caps how many requests hit Fayda at once (e.g. 20 instead of 50). |
| **Keep-alive HTTP** | A shared HTTP client with keep-alive is used for all Fayda API calls (no config needed). |
| **Railway Hobby + 2Captcha balance** | More RAM, no sleep; enough captcha balance so 2Captcha isn't the bottleneck. |

## Web Dashboard (Super Admin)

If `ADMIN_USER` and `ADMIN_PASS` are set, a web dashboard is available at `/login`. Same options as the bot:

- **Dashboard**: Add Buyer, View Pending Users, Buyers list with stats
- **Pending Users**: Users who sent /start but aren't added yet (with their Telegram ID for adding)
- **Manage Buyer**: Add Sub-User (by Telegram ID), Remove Sub-User, Remove Admin

**How we get Telegram ID:** When anyone sends a message to the bot (including /start), Telegram includes `ctx.from` with `id`, `first_name`, `username`, etc. We upsert that into MongoDB on every interaction. So when a new user sends /start, we save them with `role: 'pending'` — admins can then see them in View Pending Users and add them by their Telegram ID.

## Monitoring

- Health check endpoint: `GET /health`
- Logs are stored in `logs/` directory
- Winston logger for structured logging
- PM2 monitoring (if using PM2)

## Security

- Input validation for all user inputs
- Rate limiting to prevent abuse
- Secure session management
- `FAYDA_APP_API_KEY`: API Key for the mobile app (bypasses Captcha).
- `CAPTCHA_KEY`: 2Captcha API Key (required as fallback if `FAYDA_APP_API_KEY` is not provided).
- `CAPTCHA_SITE_KEY`: (Optional) Site key for Resident Portal Captcha.
- `MONGODB_URI`: Connection string for MongoDB.
- XSS protection

## Troubleshooting

### Bot not responding
- Check webhook URL is correct
- Verify BOT_TOKEN is valid
- Check logs for errors

### Database connection issues
- Verify MONGODB_URI is correct
- Check network connectivity
- Ensure database is accessible

### Queue not processing
- Verify REDIS_URL is correct
- Check Redis connection
- Review queue logs

## License

MIT
