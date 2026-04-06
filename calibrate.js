const { PDFDocument, rgb } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const fontkit = require('@pdf-lib/fontkit');

async function calibrate() {
  const cardDoc = await PDFDocument.create();
  cardDoc.registerFontkit(fontkit);
  const cardW = 242.6;
  const cardH = 153.0;

  const TEMPLATE_FRONT = path.join(__dirname, 'assets', 'template_card_front.png');
  const frontTempBytes = fs.readFileSync(TEMPLATE_FRONT);
  const frontImg = await cardDoc.embedPng(frontTempBytes);

  const page = cardDoc.addPage([cardW, cardH]);
  page.drawImage(frontImg, { x: 0, y: 0, width: cardW, height: cardH });

  // Draw a grid
  for (let x = 0; x <= cardW; x += 20) {
    page.drawLine({ start: { x, y: 0 }, end: { x, y: cardH }, thickness: 0.5, color: rgb(1,0,0) });
    page.drawText(String(x), { x, y: 2, size: 5, color: rgb(1,0,0) });
  }
  for (let y = 0; y <= cardH; y += 20) {
    page.drawLine({ start: { x: 0, y }, end: { x: cardW, y }, thickness: 0.5, color: rgb(1,0,0) });
    page.drawText(String(y), { x: 2, y, size: 5, color: rgb(1,0,0) });
  }

  const pdfBytes = await cardDoc.save();
  fs.writeFileSync('calibrate_front.pdf', pdfBytes);
  console.log('Created calibrate_front.pdf');
}

calibrate();
