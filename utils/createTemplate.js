/**
 * createTemplate.js
 * 
 * Run ONCE to strip user-specific content from a sample Fayda PDF
 * and produce a blank template (`fayda_template.pdf`).
 * 
 * How it works:
 * The PDF content is stored as a PDFArray of 4 streams:
 *   Stream 0: empty (2 chars)
 *   Stream 1: ALL design content (backgrounds, headers, labels, disclaimer) — 124K chars
 *   Stream 2: empty (2 chars)  
 *   Stream 3: ALL user-specific content (text + images) — 2.8K chars  ← DROP THIS
 * 
 * We simply drop Stream 3 and the user image XObjects to create the template.
 * 
 * Usage: node utils/createTemplate.js
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName, PDFArray } = require('pdf-lib');

// The 4 user-specific image names to remove from XObjects
const USER_IMAGES = [
  'Image-250812044',   // Profile photo 480x640
  'Image-1275322832',  // QR code 250x250
  'Image-7720966295',  // Front card 1968x3150
  'Image-4525072762',  // Back card 1968x3150
];

// User-specific font name prefixes to remove
const USER_FONT_PREFIXES = [
  'BarlowSemiCondensed-Medium-',
  'Nyala-Regular-',
];

async function createTemplate() {
  const samplePath = path.join(__dirname, '..', 'assets for system building', 'Edmon_Dejen_Haileselassie.pdf');
  const outputPath = path.join(__dirname, '..', 'assets', 'fayda_template.pdf');

  console.log('Loading sample PDF:', samplePath);
  const pdfBytes = fs.readFileSync(samplePath);
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

  const page = pdfDoc.getPages()[0];
  const pageNode = page.node;

  // --- Step 1: Drop Stream 3 (user data) from the Contents array ---
  const contentsRef = pageNode.get(PDFName.of('Contents'));
  const contentsArr = pdfDoc.context.lookup(contentsRef);
  
  if (!(contentsArr instanceof PDFArray)) {
    throw new Error('Expected Contents to be a PDFArray');
  }

  console.log(`Content streams: ${contentsArr.size()}`);
  
  // Keep only streams 0, 1, 2 (design), drop stream 3 (user data)
  const newContentsArr = pdfDoc.context.obj([]);
  for (let i = 0; i < contentsArr.size() - 1; i++) {
    newContentsArr.push(contentsArr.get(i));
  }
  console.log(`Kept ${newContentsArr.size()} streams, dropped stream 3 (user data)`);
  
  // Replace the Contents reference
  const newContentsRef = pdfDoc.context.register(newContentsArr);
  pageNode.set(PDFName.of('Contents'), newContentsRef);

  // --- Step 2: Remove user image XObjects from resources ---
  const resources = pageNode.get(PDFName.of('Resources'));
  if (resources) {
    const xobjects = resources.get(PDFName.of('XObject'));
    if (xobjects) {
      for (const imgName of USER_IMAGES) {
        xobjects.delete(PDFName.of(imgName));
        console.log(`Removed XObject /${imgName}`);
      }
    }

    // Remove user-specific fonts
    const fonts = resources.get(PDFName.of('Font'));
    if (fonts) {
      const entries = [...fonts.entries()];
      for (const [key] of entries) {
        const keyStr = key.toString().replace('/', '');
        if (USER_FONT_PREFIXES.some(prefix => keyStr.startsWith(prefix))) {
          fonts.delete(key);
          console.log(`Removed font ${key.toString()}`);
        }
      }
    }
  }

  // --- Step 3: Save the template ---
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const templateBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, templateBytes);
  
  console.log(`\n✅ Template saved to: ${outputPath}`);
  console.log(`Template size: ${(templateBytes.length / 1024).toFixed(1)} KB`);
  console.log(`Original was: ${(pdfBytes.length / 1024).toFixed(1)} KB`);
  console.log(`Saved: ${((pdfBytes.length - templateBytes.length) / 1024).toFixed(1)} KB`);
}

createTemplate().catch(err => {
  console.error('❌ Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
