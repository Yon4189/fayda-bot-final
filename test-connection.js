const net = require('net');

async function testPort(host, port) {
    return new Promise((resolve) => {
        console.log(`Testing ${host}:${port}...`);
        const socket = new net.Socket();
        const timeout = 5000;
        
        socket.setTimeout(timeout);
        
        socket.on('connect', () => {
            console.log(`✅ SUCCESS: ${host}:${port} is reachable!`);
            socket.destroy();
            resolve(true);
        });
        
        socket.on('timeout', () => {
            console.log(`❌ TIMEOUT: ${host}:${port} took too long (5s).`);
            socket.destroy();
            resolve(false);
        });
        
        socket.on('error', (err) => {
            console.log(`❌ ERROR: ${host}:${port} failed (${err.message})`);
            socket.destroy();
            resolve(false);
        });
        
        socket.connect(port, host);
    });
}

async function runTests() {
    console.log('--- Database Connectivity Diagnostics ---');
    await testPort('ac-hkqkcsy-shard-00-00.ukrvddz.mongodb.net', 27017);
    await testPort('possible-anemone-69660.upstash.io', 6379);
    console.log('-----------------------------------------');
    console.log('If both failed with TIMEOUT, your network is still blocking these ports.');
}

runTests();
