const { Telegraf } = require('telegraf');
require('dotenv').config();

async function getBotInfo() {
  const bot = new Telegraf(process.env.BOT_TOKEN);
  try {
    const me = await bot.telegram.getMe();
    console.log(`BOT_USERNAME=@${me.username}`);
  } catch (err) {
    console.error('Error fetching bot info:', err.message);
  }
}

getBotInfo();
