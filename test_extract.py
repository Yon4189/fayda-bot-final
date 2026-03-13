import sys
import pdfplumber

sys.path.append("System Building Assets/backend")
import generate_data_pdf

with pdfplumber.open("sample_output.pdf") as pdf:
    text = ""
    for page in pdf.pages:
        text += page.extract_text() + "\n"
        
    fields = generate_data_pdf.extract_fields_from_text(text)
    print("EXTRACTED FIELDS:", fields)
