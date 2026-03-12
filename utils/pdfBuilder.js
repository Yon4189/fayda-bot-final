const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const logger = require('./logger');

// Load the blank template we created
const TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'fayda_template.pdf');
// Font supporting both Latin and Ethiopic characters
const FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansEthiopic-Medium.ttf');

let templateBytes = null;
let fontBytes = null;

// The exact layout coordinates extracted from the original PDF content stream
const LAYOUT = {
  // --- IMAGES ---
  images: {
    photo: { x: 53.8, y: 624.39, width: 85, height: 117.5 },
    qr:    { x: 110,  y: 268.89, width: 164, height: 162 },
    front: { x: 397.1, y: 511.89, width: 156.6, height: 240 },
    back:  { x: 397.1, y: 264.89, width: 156.6, height: 240 }
  },
  
  // --- TEXT FIELDS ---
  // Default text styling
  textOptions: {
    size: 9,
    color: { type: 'RGB', red: 0.137, green: 0.364, blue: 0.443 }, // Hex #235D71
  },
  
  // Text positions
  text: [
    // Phone numbers
    { id: 'phone', x: 59.6, y: 553.19 },
    { id: 'fcn',   x: 73.6, y: 605.99 }, // Technically FCN number, placed separately
    
    // Demographics left side (Amharic top, English bottom)
    { id: 'gender_amh', x: 59.6, y: 517.99 },
    { id: 'gender_eng', x: 59.6, y: 508.59 },
    
    { id: 'nationality_amh', x: 59.6, y: 487.29 },
    { id: 'nationality_eng', x: 59.6, y: 477.59 },
    
    { id: 'dob', x: 59.6, y: 455.29 }, // Format: YYYY/MM/DD \n YYYY/MM/DD
    
    // Demographics right side (Amharic top, English bottom)
    { id: 'regionCity_amh', x: 203.2, y: 553.19 },
    { id: 'regionCity_eng', x: 203.2, y: 544.49 },
    
    { id: 'subcityZone_amh', x: 203.2, y: 517.99 },
    { id: 'subcityZone_eng', x: 203.2, y: 508.59 },
    
    { id: 'woreda_amh', x: 203.2, y: 487.29 },
    { id: 'woreda_eng', x: 203.2, y: 477.59 },
    
    // Full Name
    { id: 'fullName_amh', x: 170.7, y: 615.99 },
    { id: 'fullName_eng', x: 170.7, y: 604.49 }
  ]
};

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
  
  if (!fontBytes) {
    if (!fs.existsSync(FONT_PATH)) {
      throw new Error(`Font not found at ${FONT_PATH}.`);
    }
    fontBytes = fs.readFileSync(FONT_PATH);
  }
}

/**
 * Builds the final PDF by placing user data into the blank template
 * 
 * @param {Object} userData - Data extracted from the verify-otp API
 * @param {Object} images - Base64 strings: { photo, qrCode, front, back }
 * @returns {Promise<Buffer>} The completed PDF bytes
 */
async function buildFaydaPdf(userData, images) {
  try {
    preloadAssets();
    
    // 1. Load template
    const pdfDoc = await PDFDocument.load(templateBytes);
    
    // 2. Register fontkit to support custom fonts
    pdfDoc.registerFontkit(fontkit);
    const customFont = await pdfDoc.embedFont(fontBytes);
    
    const page = pdfDoc.getPages()[0];
    
    // 3. Embed and draw images
    const embedImageSafely = async (base64Str) => {
      if (!base64Str) return null;
      // Remove data URIs if present
      const cleanBase64 = base64Str.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
      const buffer = Buffer.from(cleanBase64, 'base64');
      
      const isPng = cleanBase64.startsWith('iVBORw0KGgo');
      // If it starts with /9j/ it's definitely JPEG, but default to jpeg fallback
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

    // Helper to format DOB
    // We place the Ethiopian date on top, Gregorian below.
    let dobText = '';
    if (userData.dateOfBirth_et && userData.dateOfBirth_eng) {
         dobText = `${userData.dateOfBirth_et}\n${userData.dateOfBirth_eng}`;
    }

    // Map the userData to our layout IDs
    const fieldMapping = {
      phone: userData.phone,
      fcn: userData.fcn || userData.UIN,
      
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
        page.drawText(String(textToDraw), {
          x: field.x,
          y: field.y,
          size: LAYOUT.textOptions.size,
          font: customFont,
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
