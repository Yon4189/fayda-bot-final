const { PDFDocument } = require('pdf-lib');

/**
 * Converts a standard A4 Fayda Digital ID PDF into a 2-page CR80 printable card format.
 * CR80 Dimensions: 3.375" x 2.125" (243 x 153 points at 72 dpi)
 * 
 * @param {Buffer|Uint8Array} inputPdfBytes The original PDF buffer
 * @returns {Promise<Buffer>} The newly generated CR80 format PDF buffer
 */
async function convertToPrintableCard(inputPdfBytes) {
  // Load the original document
  const originalDoc = await PDFDocument.load(inputPdfBytes);
  const [originalPage] = originalDoc.getPages();

  // Create a new document for the CR80 card
  const cr80Doc = await PDFDocument.create();

  // CR80 Portrait dimensions (Standard ID card orientation for Fayda)
  const cardWidth = 2.125 * 72;   // ~153 points (153)
  const cardHeight = 3.375 * 72;  // ~243 points (243)
  
  // Actually, let's use a higher resolution CR80 size to preserve vector quality
  // We'll scale it up by 2x for the PDF page size, though PDFs are vector anyway.
  const pageW = cardWidth * 1.5;   // 229.5
  const pageH = cardHeight * 1.5;  // 364.5

  // Bounding box estimates for the FRONT and BACK cards on the A4 page
  // The A4 is 595 x 842. The cards are on the left side.
  // Front card spans roughly x: 15 to 265, y: 435 to 830
  // Back card spans roughly x: 15 to 265, y: 40 to 435
  const boxWidth = 250;
  const boxHeight = 395;

  const scale = pageW / boxWidth; // ~ 0.918

  const frontX = 15;
  const frontY = 435;

  const backX = 15;
  const backY = 40;

  // Embed the original page into our new document
  const embeddedPage = await cr80Doc.embedPage(originalPage);

  // --- Page 1: FRONT ---
  const frontPage = cr80Doc.addPage([pageW, pageH]);
  frontPage.drawPage(embeddedPage, {
    x: -frontX * scale,
    y: -frontY * scale,
    xScale: scale,
    yScale: scale,
  });

  // --- Page 2: BACK ---
  const backPage = cr80Doc.addPage([pageW, pageH]);
  backPage.drawPage(embeddedPage, {
    x: -backX * scale,
    y: -backY * scale,
    xScale: scale,
    yScale: scale,
  });

  const pdfBytes = await cr80Doc.save();
  return Buffer.from(pdfBytes);
}

module.exports = { convertToPrintableCard };
