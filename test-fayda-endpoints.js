const axios = require('axios');

async function testEndpoint(url) {
    console.log(`Testing ${url}...`);
    try {
        const start = Date.now();
        const res = await axios.get(url, { timeout: 10000 });
        console.log(`Success ${url}: ${res.status} (${Date.now() - start}ms)`);
    } catch (err) {
        console.log(`Failed ${url}: ${err.message} ${err.response?.status ? `(Status: ${err.response.status})` : ''}`);
    }
}

async function run() {
    // These are typical base URLs
    await testEndpoint('https://api-resident.fayda.et/health');
    await testEndpoint('https://api-resident.id.et/health');
    await testEndpoint('https://api-resident.fayda.et/');
    await testEndpoint('https://api-resident.id.et/');
}

run();
