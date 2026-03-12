const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const logger = require('./logger');

// Load the blank template we created
const TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'fayda_template.pdf');
// Dual fonts matching the original Fayda PDF
const ENGLISH_FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'BarlowSemiCondensed-Medium.ttf');
const AMHARIC_FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'AbyssinicaSIL-R.ttf');

let templateBytes = null;
let englishFontBytes = null;
let amharicFontBytes = null;

// Page height for coordinate reference: 841.89 (A4)
// pdfplumber top → pdf-lib y:  y = 841.89 - top

// The exact layout coordinates aligned with mode3 of generate_data_pdf.py
// mode3 expects:
//   FIN:     top ≈ 228,  x0 = 73.6    → y ≈ 613.89
//   Names:   top ≈ 218-230, x0 ≈ 167   → y ≈ 612-624
//   DOB:     top ≈ 280-292, x0 ≤ 170    → y ≈ 550-562
//   City:    top ≈ 281-291, x0 ≥ 200    → y ≈ 551-561
//   Subcity: top ≈ 315-327, x0 ≥ 200    → y ≈ 515-527
//   Woreda:  top ≈ 346-358, x0 ≈ 200    → y ≈ 484-496
//   Phone:   top ≈ 378-380, x0 ≥ 59     → y ≈ 462

const LAYOUT = {
  // --- IMAGES ---
  images: {
    photo: { x: 53.8, y: 624.39, width: 85, height: 117.5 },
    qr:    { x: 110,  y: 268.89, width: 164, height: 162 },
    front: { x: 397.1, y: 511.89, width: 156.6, height: 240 },
    back:  { x: 397.1, y: 264.89, width: 156.6, height: 240 }
  },
  
  // --- TEXT FIELDS ---
  textOptions: {
    size: 9,
    color: { red: 0.137, green: 0.364, blue: 0.443 }, // #235D71
  },
  
  // Text positions — corrected for mode3 compatibility
  // lang: 'am' = Amharic font, 'en' = English font, 'both' = English font (numbers/mixed)
  text: [
    // FCN / FIN number (top ≈ 228, x0 = 73.6)
    { id: 'fcn',   x: 73.6, y: 613.89, lang: 'en' },
    
    // Full Name (top ≈ 218-230, x0 ≈ 170)
    { id: 'fullName_amh', x: 170.7, y: 623.89, lang: 'am' },
    { id: 'fullName_eng', x: 170.7, y: 611.89, lang: 'en' },
    
    // Date of Birth (top ≈ 280-292, x0 ≤ 170) — FIXED: was at phone position
    { id: 'dob', x: 59.6, y: 553.19, lang: 'en' },
    
    // Gender (top ≈ 315-327, x0 ≤ 120)
    { id: 'gender_amh', x: 59.6, y: 517.99, lang: 'am' },
    { id: 'gender_eng', x: 59.6, y: 508.59, lang: 'en' },
    
    // Nationality (top ≈ 346-358, x0 ≤ 120)
    { id: 'nationality_amh', x: 59.6, y: 487.29, lang: 'am' },
    { id: 'nationality_eng', x: 59.6, y: 477.59, lang: 'en' },
    
    // Phone Number (top ≈ 378-380, x0 ≥ 59) — FIXED: was at DOB position
    { id: 'phone', x: 59.6, y: 455.29, lang: 'en' },
    
    // Region/City (top ≈ 281-291, x0 ≥ 200)
    { id: 'regionCity_amh', x: 203.2, y: 553.19, lang: 'am' },
    { id: 'regionCity_eng', x: 203.2, y: 544.49, lang: 'en' },
    
    // Subcity/Zone (top ≈ 315-327, x0 ≥ 200)
    { id: 'subcityZone_amh', x: 203.2, y: 517.99, lang: 'am' },
    { id: 'subcityZone_eng', x: 203.2, y: 508.59, lang: 'en' },
    
    // Woreda (top ≈ 346-358, x0 ≈ 200-365)
    { id: 'woreda_amh', x: 203.2, y: 487.29, lang: 'am' },
    { id: 'woreda_eng', x: 203.2, y: 477.59, lang: 'en' },
  ]
};

/**
 * Format FCN/FIN with spaces every 4 digits
 * "4658694398563761" → "4658 6943 9856 3761"
 */
function formatFCN(fcn) {
  if (!fcn) return '';
  const digits = String(fcn).replace(/\s/g, '');
  return digits.replace(/(.{4})/g, '$1 ').trim();
}

/**
 * Ensures template and fonts are loaded into memory
 */
function preloadAssets() {
  if (!templateBytes) {
    if (!fs.existsSync(TEMPLATE_PATH)) {
      throw new Error(`PDF Template not found at ${TEMPLATE_PATH}. Did you run createTemplate.js?`);
    }
    templateBytes = fs.readFileSync(TEMPLATE_PATH);
  }
  
  if (!englishFontBytes) {
    if (!fs.existsSync(ENGLISH_FONT_PATH)) {
      throw new Error(`English font not found at ${ENGLISH_FONT_PATH}.`);
    }
    englishFontBytes = fs.readFileSync(ENGLISH_FONT_PATH);
  }

  if (!amharicFontBytes) {
    if (!fs.existsSync(AMHARIC_FONT_PATH)) {
      throw new Error(`Amharic font not found at ${AMHARIC_FONT_PATH}.`);
    }
    amharicFontBytes = fs.readFileSync(AMHARIC_FONT_PATH);
  }
}

/**
 * Builds the final PDF by placing user data into the blank template
 */
async function buildFaydaPdf(userData, images) {
  try {
    preloadAssets();
    
    // 1. Load template
    const pdfDoc = await PDFDocument.load(templateBytes);
    
    // 2. Register fontkit and embed both fonts
    pdfDoc.registerFontkit(fontkit);
    const engFont = await pdfDoc.embedFont(englishFontBytes);
    const amhFont = await pdfDoc.embedFont(amharicFontBytes);
    
    const page = pdfDoc.getPages()[0];
    
    // 3. Embed and draw images
    const embedImageSafely = async (base64Str) => {
      if (!base64Str) return null;
      const cleanBase64 = base64Str.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
      const buffer = Buffer.from(cleanBase64, 'base64');
      
      const isPng = cleanBase64.startsWith('iVBORw0KGgo');
      if (isPng) {
        return await pdfDoc.embedPng(buffer);
      } else {
        return await pdfDoc.embedJpg(buffer);
      }
    };

    if (images.photo) {
      const photoImg = await embedImageSafely(images.photo);
      if (photoImg) page.drawImage(photoImg, LAYOUT.images.photo);
    }
    
    if (images.qrCode) {
      const qrImg = await embedImageSafely(images.qrCode);
      if (qrImg) page.drawImage(qrImg, LAYOUT.images.qr);
    }
    
    if (images.front) {
      const frontImg = await embedImageSafely(images.front);
      if (frontImg) page.drawImage(frontImg, LAYOUT.images.front);
    }
    
    if (images.back) {
      const backImg = await embedImageSafely(images.back);
      if (backImg) page.drawImage(backImg, LAYOUT.images.back);
    }

    // 4. Draw text fields
    const textColor = rgb(LAYOUT.textOptions.color.red, LAYOUT.textOptions.color.green, LAYOUT.textOptions.color.blue);

    // Format DOB: Ethiopian date on top, Gregorian below
    let dobText = '';
    if (userData.dateOfBirth_et && userData.dateOfBirth_eng) {
         dobText = `${userData.dateOfBirth_et}\n${userData.dateOfBirth_eng}`;
    } else if (userData.dateOfBirth_et) {
         dobText = userData.dateOfBirth_et;
    } else if (userData.dateOfBirth_eng) {
         dobText = userData.dateOfBirth_eng;
    }

    // Map the userData to our layout IDs
    const fieldMapping = {
      phone: userData.phone,
      fcn: formatFCN(userData.fcn || userData.UIN),
      
      gender_amh: userData.gender_amh,
      gender_eng: userData.gender_eng,
      
      nationality_amh: userData.citizenship_amh,
      nationality_eng: userData.citizenship_Eng,
      
      dob: dobText,
      
      regionCity_amh: userData.region_amh,
      regionCity_eng: userData.region_eng,
      
      subcityZone_amh: userData.zone_amh,
      subcityZone_eng: userData.zone_eng,
      
      woreda_amh: userData.woreda_amh,
      woreda_eng: userData.woreda_eng,
      
      fullName_amh: userData.fullName_amh,
      fullName_eng: userData.fullName_eng
    };

    for (const field of LAYOUT.text) {
      const textToDraw = fieldMapping[field.id];
      if (textToDraw) {
        const font = field.lang === 'am' ? amhFont : engFont;
        page.drawText(String(textToDraw), {
          x: field.x,
          y: field.y,
          size: LAYOUT.textOptions.size,
          font: font,
          color: textColor,
          lineHeight: 9.6
        });
      }
    }
    
    // Save and return buffer
    const finalPdfBytes = await pdfDoc.save();
    return Buffer.from(finalPdfBytes);

  } catch (error) {
    logger.error('Error building Fayda PDF:', error);
    throw error;
  }
}

module.exports = {
  buildFaydaPdf
};
