const fs = require('fs');
const buf = fs.readFileSync('assets/template_card_front.png').slice(0, 8);
console.log('Header:', buf.toString('hex'));
if (buf.toString('hex').startsWith('89504e470d0a1a0a')) console.log('PNG');
else if (buf.toString('hex').startsWith('ffd8ff')) console.log('JPG');
else console.log('Unknown');
