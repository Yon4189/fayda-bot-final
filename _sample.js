const fs = require('fs');
const { buildFaydaPdf } = require('./utils/pdfBuilder');

const userData = {
  fcn: '2971851627931407',
  phone: '0949185511',
  dateOfBirth_eng: '2004/02/25',
  dateOfBirth_et: '17/06/1996',
  gender_amh: 'ወንድ',
  gender_eng: 'Male',
  citizenship_amh: 'ኢትዮጵያዊ',
  citizenship_Eng: 'Ethiopian',
  region_amh: 'አማራ',
  region_eng: 'Amhara',
  zone_amh: 'ባህር ዳር ልዩ ዞን',
  zone_eng: 'Bahir Dar Special Zone',
  woreda_amh: 'ዳግማዊ ሚኒሊክ',
  woreda_eng: 'Dagmawi Minilik',
  fullName_amh: 'አየነው ብርሃኔ እንዳላመው',
  fullName_eng: 'Ayenew Birhanie Endalamew',
};

let images = { photo: null, qrCode: null, front: null, back: null };
try {
  images = JSON.parse(fs.readFileSync('_mock_images.json', 'utf8'));
} catch (e) {
  console.log('No mock images found, using empty');
}

buildFaydaPdf(userData, images)
  .then(bytes => {
    fs.writeFileSync('sample_output.pdf', bytes);
    console.log('sample_output.pdf created -', (bytes.length / 1024).toFixed(1), 'KB');
  })
  .catch(err => console.error('Error:', err.message));
