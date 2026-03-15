const axios = require('axios');
const logger = require('./logger');

class SolveCaptcha {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://2captcha.com';
    }

    async recaptcha(siteKey, pageUrl, options = {}) {
        try {
            const response = await axios.get(`${this.baseUrl}/in.php`, {
                params: {
                    key: this.apiKey,
                    method: 'userrecaptcha',
                    googlekey: siteKey,
                    pageurl: pageUrl,
                    json: 1,
                    ...options
                }
            });

            if (response.data.status !== 1) {
                throw new Error(`2Captcha error: ${response.data.request}`);
            }

            const captchaId = response.data.request;
            return this.pollResult(captchaId);
        } catch (error) {
            logger.error('Captcha solve request failed:', error.message);
            throw error;
        }
    }

    async pollResult(captchaId, attempts = 20, interval = 5000) {
        for (let i = 0; i < attempts; i++) {
            try {
                const response = await axios.get(`${this.baseUrl}/res.php`, {
                    params: {
                        key: this.apiKey,
                        action: 'get',
                        id: captchaId,
                        json: 1
                    }
                });

                if (response.data.status === 1) {
                    return { success: true, data: response.data.request };
                }

                if (response.data.request !== 'CAPCHA_NOT_READY') {
                    throw new Error(`2Captcha error: ${response.data.request}`);
                }

                await new Promise(resolve => setTimeout(resolve, interval));
            } catch (error) {
                if (error.message.includes('CAPCHA_NOT_READY')) continue;
                logger.error('Captcha polling failed:', error.message);
                throw error;
            }
        }
        throw new Error('Captcha solve timeout');
    }
}

module.exports = SolveCaptcha;
