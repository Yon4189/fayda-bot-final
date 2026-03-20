const fs = require('fs');
const { convertToPrintableCard } = require('./utils/cardConverter');

async function testConvert() {
  const path = 'assets/fayda_template.pdf';
  if (!fs.existsSync(path)) {
    console.log(`File not found: ${path}`);
    return;
  }
  
  const pdfBytes = fs.readFileSync(path);
  const outBytes = await convertToPrintableCard(pdfBytes);
  
  fs.writeFileSync('output_card_test.pdf', outBytes);
  console.log('Successfully created output_card_test.pdf');
}

testConvert().catch(console.error);
