const SolveCaptcha = require('./utils/solveCaptcha');
require('dotenv').config();

const SITE_KEY = "6LcSAIwqAAAAAGsZElBPqf63_0fUtp17idU-SQYC";
const solver = new SolveCaptcha(process.env.CAPTCHA_KEY);

console.log('Testing Captcha Submission to 2Captcha...');
console.log('Using Site Key:', SITE_KEY);

// We only want to test the submission (in.php), not wait for a full solve (5-10 mins)
// So we'll try-catch it and see if the initial request passes.

async function testSubmission() {
    try {
        console.log('Initiating recaptcha request...');
        // Mocking the behavior but using the real solver
        const siteKey = SITE_KEY;
        const pageUrl = 'https://resident.fayda.et/';
        
        // Manual call to in.php via axios to see the exact response if we want, 
        // or just use the class and catch the error.
        
        const res = await solver.recaptcha(siteKey, pageUrl, { version: 'v3', action: 'verify', min_score: 0.5 });
        console.log('Captcha Solved (Unexpectedly fast!):', res);
    } catch (error) {
        console.error('Captcha Submission FAILED:', error.message);
    }
}

testSubmission();
