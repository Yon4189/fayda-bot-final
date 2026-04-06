const { convertToPrintableCard } = require('./utils/cardConverter');
const fs = require('fs');

async function test() {
  const samplePdf = fs.readFileSync('sample_output.pdf');
  const userData = {
    fullName_eng: "MENGISTU TEFERA FEREDE",
    fullName_amh: "መንግስቱ ተፈራ ፈረደ",
    dob_et: "28/06/1998",
    dob_eng: "2006/Mar/07",
    gender_amh: "ወንድ",
    gender_eng: "Male",
    fcn: "2075 2850 3487 2312",
    phone: "0930631583",
    nationality_amh: "ኢትዮጵያዊ",
    nationality_eng: "Ethiopian",
    region_amh: "አማራ",
    region_eng: "Amhara",
    zone_amh: "ምስራቅ ጎጃም ዞን",
    zone_eng: "East Gojjam Zone",
    woreda_amh: "ባሶ ሊበን",
    woreda_eng: "Baso Liben"
  };

  const cardPdf = await convertToPrintableCard(samplePdf, userData, null);
  fs.writeFileSync('output_card_v2.pdf', cardPdf);
  console.log('Created output_card_v2.pdf');
}

test().catch(console.error);
