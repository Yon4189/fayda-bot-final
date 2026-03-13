const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const logger = require('./logger');

// Load the blank template we created
const TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'fayda_template.pdf');
// Dual fonts matching the original Fayda PDF
const ENGLISH_FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'BarlowSemiCondensed-Medium.ttf');
const AMHARIC_FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'nyala.ttf');

let templateBytes = null;
let englishFontBytes = null;
let amharicFontBytes = null;

// pdfplumber 'top' coordinates from the original PDF (efayda_Ayenew_Birhanie_Endalamew.pdf):
//   FCN groups:       top=228.7, x0=73.6 / 90.5 / 107.9 / 126.3
//   Amharic Name:     top=218.4, x0=170.7
//   English Name:     top=230.2, x0=170.7
//   DOB Ethiopian:    top=281.5, x0=59.6
//   DOB Gregorian:    top=290.2, x0=59.6
//   Gender Amh:       top=316.4, x0=59.6
//   Gender Eng:       top=326.1, x0=59.6
//   Nationality Amh:  top=347.1, x0=59.6
//   Nationality Eng:  top=357.1, x0=59.6
//   Phone:            top=379.4, x0=59.6
//   Region Amh:       top=281.2, x0=203.2
//   Region Eng:       top=290.2, x0=203.2
//   Subcity Amh:      top=316.4, x0=203.2
//   Subcity Eng:      top=326.1, x0=203.2
//   Woreda Amh:       top=347.1, x0=203.2
//   Woreda Eng:       top=357.1, x0=203.2

// Calibrated pdf-lib Y values computed from our measured output:
// Our last test: FCN at top=220.8 with y=613.89  → to get top=228.7 we need y = 613.89 - 7.9 = 606.0
//                Amh Name at top=212.0 with y=623.89 → to get top=218.4 we need y = 623.89 - 6.4 = 617.5
//                Eng Name at top=222.8 with y=611.89 → to get top=230.2 we need y = 611.89 - 7.4 = 604.5
//                DOB_et at top=281.5 with y=553.19  → PERFECT
//                DOB_eng at top=291.1 with y=553.19 (lineHeight) → need top=290.2, so adjust lineHeight
//                Gender Amh at top=317.9 with y=517.99 → to get top=316.4 we need y = 517.99 + 1.5 = 519.5
//                Gender Eng at top=326.1 with y=508.59 → PERFECT
//                Nat Amh at top=348.6 with y=487.29 → to get top=347.1 we need y = 487.29 + 1.5 = 488.8
//                Nat Eng at top=357.1 with y=477.59 → PERFECT
//                Phone at top=379.4 with y=455.29 → PERFECT
//                Region Amh at top=282.7 with y=553.19 → to get top=281.2 we need y = 553.19 + 1.5 = 554.7
//                Region Eng at top=290.2 with y=544.49 → PERFECT
//                Subcity Amh at top=317.9 with y=517.99 → need y = 519.5
//                Subcity Eng at top=326.1 with y=508.59 → PERFECT
//                Woreda Amh at top=348.6 with y=487.29 → need y = 488.8
//                Woreda Eng at top=357.1 with y=477.59 → PERFECT

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
  
  // For mode3 detection, top MUST be exactly 227-229.
  // Y = 841.89 - Top - 7.20. Target Top=228.5 => Y ~ 606.19
  fcn: { x: 73.6, y: 606.19 },
  
  // Text positions mathematically calibrated to fit exactly inside generate_data_pdf.py mode3 windows
  // PDF Top value = 841.89 - Y - 7.20
  text: [
    // Full Name: top must be 217.6 - 231
    { id: 'fullName_amh', x: 170.7, y: 616.0, lang: 'am' }, 
    { id: 'fullName_eng', x: 170.7, y: 604.5, lang: 'en' }, 
    
    // Date of Birth: ethiopian top must be 280 - 292
    { id: 'dob_et',  x: 59.6, y: 554.0, lang: 'en' },  // top=280.69
    { id: 'dob_eng', x: 59.6, y: 544.0, lang: 'en' },  // top=290.69
    
    // Gender (Matches Subcity horizontal line visually)
    { id: 'gender_amh', x: 59.6, y: 518.69, lang: 'am' }, 
    { id: 'gender_eng', x: 59.6, y: 508.69, lang: 'en' }, 
    
    // Nationality (Matches Woreda horizontal line visually)
    { id: 'nationality_amh', x: 59.6, y: 487.69, lang: 'am' }, 
    { id: 'nationality_eng', x: 59.6, y: 477.69, lang: 'en' }, 
    
    // Phone Number: top must be 378 - 380
    { id: 'phone', x: 59.6, y: 455.69, lang: 'en' }, // top=379.0
    
    // Region/City: top must be 281 - 291 for BOTH!
    { id: 'regionCity_amh', x: 203.2, y: 552.69, lang: 'am' }, // top=282.0
    { id: 'regionCity_eng', x: 203.2, y: 544.69, lang: 'en' }, // top=290.0
    
    // Subcity: top must be 315 - 327 for BOTH!
    { id: 'subcityZone_amh', x: 203.2, y: 518.69, lang: 'am' }, // top=316.0
    { id: 'subcityZone_eng', x: 203.2, y: 508.69, lang: 'en' }, // top=326.0
    
    // Woreda: top must be 346 - 358 for BOTH!
    { id: 'woreda_amh', x: 203.2, y: 487.69, lang: 'am' }, // top=347.0
    { id: 'woreda_eng', x: 203.2, y: 477.69, lang: 'en' }, // top=357.0
  ]
};

/**
 * Format FCN/FIN with spaces every 4 digits
 * "4658694398563761" → "4658 6943 9856 3761"
 */
function formatFCN(fcn) {
  if (!fcn) return '';
  const digits = String(fcn).replace(/\s/g, '');
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
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
    const engFont = await pdfDoc.embedFont(englishFontBytes, { subset: true });
    // IMPORTANT: Subsetting breaks complex Amharic script rendering in pdf-lib. Must be false.
    const amhFont = await pdfDoc.embedFont(amharicFontBytes, { subset: false });
    
    const page = pdfDoc.getPages()[0];
    
    // 3. Embed and draw images (with JPEG quality reduction for file size)
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
    const fontSize = LAYOUT.textOptions.size;

    // 4a. Draw FCN — single spaced string (e.g. "2971 8516 2793 1407")
    const fcnText = formatFCN(userData.fcn || userData.UIN);
    if (fcnText) {
      page.drawText(fcnText, {
        x: LAYOUT.fcn.x,
        y: LAYOUT.fcn.y,
        size: fontSize,
        font: engFont,
        color: textColor,
      });
    }

    // 4b. Map the userData to layout IDs — DOB as separate lines
    const fieldMapping = {
      fullName_amh: userData.fullName_amh,
      fullName_eng: userData.fullName_eng,
      
      dob_et: userData.dateOfBirth_et,
      dob_eng: userData.dateOfBirth_eng,
      
      gender_amh: userData.gender_amh,
      gender_eng: userData.gender_eng,
      
      nationality_amh: userData.citizenship_amh,
      nationality_eng: userData.citizenship_Eng,
      
      phone: userData.phone,
      
      regionCity_amh: userData.region_amh,
      regionCity_eng: userData.region_eng,
      
      subcityZone_amh: userData.zone_amh,
      subcityZone_eng: userData.zone_eng,
      
      woreda_amh: userData.woreda_amh,
      woreda_eng: userData.woreda_eng,
    };

    for (const field of LAYOUT.text) {
      const textToDraw = fieldMapping[field.id];
      if (textToDraw) {
        const font = field.lang === 'am' ? amhFont : engFont;
        page.drawText(String(textToDraw), {
          x: field.x,
          y: field.y,
          size: fontSize,
          font: font,
          color: textColor,
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
