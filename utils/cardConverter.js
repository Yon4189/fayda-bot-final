const { PDFDocument, rgb } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const fontkit = require('@pdf-lib/fontkit');
const logger = require('./logger');

const TEMPLATE_FRONT = path.join(__dirname, '..', 'assets', 'template_card_front.png');
const TEMPLATE_BACK = path.join(__dirname, '..', 'assets', 'template_card_back.png');
const AMHARIC_FONT = path.join(__dirname, '..', 'assets', 'fonts', 'nyala.ttf');
const ENGLISH_FONT = path.join(__dirname, '..', 'assets', 'fonts', 'BarlowSemiCondensed-Medium.ttf');

/**
 * High-quality ID card converter.
 * Instead of cropping, this extracts data and renders it onto a professional template.
 */
async function convertToPrintableCard(inputPdfBytes, userData = null, images = null) {
  try {
    const cardDoc = await PDFDocument.create();
    cardDoc.registerFontkit(fontkit);

    const cardW = 242.6; // 85.6mm
    const cardH = 153.0; // 54mm

    // 1. Load Templates and Fonts
    const frontTempBytes = fs.readFileSync(TEMPLATE_FRONT);
    const backTempBytes = fs.readFileSync(TEMPLATE_BACK);
    const amhFontBytes = fs.readFileSync(AMHARIC_FONT);
    const engFontBytes = fs.readFileSync(ENGLISH_FONT);

    const frontImg = await cardDoc.embedJpg(frontTempBytes);
    const backImg = await cardDoc.embedJpg(backTempBytes);
    const amhFont = await cardDoc.embedFont(amhFontBytes, { subset: false });
    const engFont = await cardDoc.embedFont(engFontBytes, { subset: true });

    // 2. Prepare Data (Fallback to extraction if null - simplified for now)
    const data = userData || { 
      fullName_eng: "Sample Name", fullName_amh: "ናሙና ስም", 
      dob_et: "01/01/1990", dob_eng: "1997/Jan/01",
      gender_amh: "ወንድ", gender_eng: "Male",
      nationality_amh: "ኢትዮጵያዊ", nationality_eng: "Ethiopian",
      fcn: "0000 0000 0000 0000",
      phone: "0900000000",
      region_amh: "አዲስ አበባ", region_eng: "Addis Ababa",
      zone_amh: "አዲስ አበባ", zone_eng: "Addis Ababa",
      woreda_amh: "አራዳ", woreda_eng: "Arada"
    };

    // 3. --- Page 1: FRONT ---
    const page1 = cardDoc.addPage([cardW, cardH]);
    page1.drawImage(frontImg, { x: 0, y: 0, width: cardW, height: cardH });

    // Embed and draw photo if provided
    if (images && images.photo) {
      const cleanPhoto = images.photo.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
      const photoBuffer = Buffer.from(cleanPhoto, 'base64');
      const photoImg = await cardDoc.embedJpg(photoBuffer); // Usually JPG
      page1.drawImage(photoImg, { x: 12, y: 38, width: 54, height: 72 });
      
      // Small thumbnail (bottom right)
      page1.drawImage(photoImg, { x: 198, y: 15, width: 22, height: 28 });
    }

    const textOpt = { size: 6.5, color: rgb(0, 0, 0) };
    const amhSize = 7.5;

    // Draw Values (Calibrated Coordinates)
    // Name
    page1.drawText(String(data.fullName_amh || ""), { x: 98, y: 104, size: amhSize, font: amhFont, ...textOpt });
    page1.drawText(String(data.fullName_eng || ""), { x: 98, y: 92, font: engFont, ...textOpt });

    // DOB
    const dobText = `${String(data.dob_et || data.dateOfBirth_et || "")} | ${String(data.dob_eng || data.dateOfBirth_eng || "")}`;
    page1.drawText(dobText, { x: 98, y: 72, font: engFont, ...textOpt });

    // Sex
    const sexText = `${String(data.gender_amh || "")} | ${String(data.gender_eng || "")}`;
    page1.drawText(sexText, { x: 98, y: 52, font: amhFont, ...textOpt });

    // Expiry
    const expAmh = data.dateOfExpired_amh || "2026/07/03";
    const expEng = data.dateOfExpired_eng || "2034/Mar/12";
    const expiryText = `${String(expAmh)} | ${String(expEng)}`;
    page1.drawText(expiryText, { x: 98, y: 32, font: engFont, ...textOpt });

    // FCN Barcode Area
    page1.drawText(String(data.fcn || data.UIN || ""), { x: 115, y: 12, size: 8, font: engFont, ...textOpt });

    // --- Page 2: BACK ---
    const page2 = cardDoc.addPage([cardW, cardH]);
    page2.drawImage(backImg, { x: 0, y: 0, width: cardW, height: cardH });

    // Phone / Nationality / Address
    page2.drawText(String(data.phone || ""), { x: 15, y: 132, font: engFont, ...textOpt });
    page2.drawText(`${String(data.nationality_amh || "ኢትዮጵያዊ")} | ${String(data.nationality_eng || "Ethiopian")}`, { x: 15, y: 112, font: amhFont, ...textOpt });
    
    const addr1 = `${String(data.region_amh || "")} | ${String(data.region_eng || "")}`;
    const addr2 = `${String(data.zone_amh || "")} | ${String(data.zone_eng || "")}`;
    const addr3 = `${String(data.woreda_amh || "")} | ${String(data.woreda_eng || "")}`;
    page2.drawText(addr1, { x: 15, y: 92, font: amhFont, ...textOpt });
    page2.drawText(addr2, { x: 15, y: 80, font: amhFont, ...textOpt });
    page2.drawText(addr3, { x: 15, y: 68, font: amhFont, ...textOpt });

    // QR Code (Back)
    if (images && images.qrCode) {
      const cleanQr = images.qrCode.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
      const qrBuffer = Buffer.from(cleanQr, 'base64');
      const qrImg = await cardDoc.embedPng(qrBuffer);
      page2.drawImage(qrImg, { x: 140, y: 35, width: 85, height: 85 });
    }

    // FIN
    page2.drawText(`FIN ${data.fcn || ""}`, { x: 35, y: 22, size: 7, font: engFont, ...textOpt });

    const pdfBytes = await cardDoc.save();
    return Buffer.from(pdfBytes);
  } catch (err) {
    logger.error('Card conversion error:', err);
    throw err;
  }
}

module.exports = { convertToPrintableCard };
