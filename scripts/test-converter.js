const fs = require('fs');
const { PDFDocument } = require('pdf-lib');

async function checkDimensions() {
  const path = 'assets/fayda_template.pdf';
  if (!fs.existsSync(path)) {
    console.log(`File not found: ${path}`);
    return;
  }
  
  const pdfBytes = fs.readFileSync(path);
  const doc = await PDFDocument.load(pdfBytes);
  const pages = doc.getPages();
  const page = pages[0];
  const { width, height } = page.getSize();
  
  console.log(`Original PDF Dimensions: width=${width}, height=${height}`);
}

checkDimensions().catch(console.error);
