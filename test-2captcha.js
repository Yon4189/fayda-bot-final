const axios = require('axios');
require('dotenv').config();

const apiKey = process.env.CAPTCHA_KEY;
console.log('Testing 2Captcha API Key:', apiKey);

async function test2Captcha() {
    try {
        const response = await axios.get('https://2captcha.com/res.php', {
            params: {
                key: apiKey,
                action: 'getbalance',
                json: 1
            }
        });
        console.log('2Captcha Response:', JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('2Captcha Test Failed:', error.message);
    }
}

test2Captcha();
