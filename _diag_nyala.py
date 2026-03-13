import pdfplumber
import sys

# Write output to a file to avoid encoding issues
with open("_diag_output.txt", "w", encoding="utf-8") as out:
    with pdfplumber.open("sample_output.pdf") as pdf:
        page = pdf.pages[0]
        words = page.extract_words(extra_attrs=["fontname", "size"])
        
        out.write("=== ALL USER DATA TEXT (top < 400) ===\n")
        for w in words:
            fn = w.get('fontname', '')
            if w['top'] < 400:
                out.write(f"  top={w['top']:.2f}  x0={w['x0']:.2f}  font={fn}  text=\"{w['text']}\"\n")
        
        out.write("\n=== EXTERNAL SYSTEM MODE3 RANGES ===\n")
        out.write("amharic_name: 217.6 <= top <= 231 AND 167 <= x0 <= 350\n")
        out.write("amharic_city: 281 <= top <= 291 AND x0 >= 200\n")
        out.write("FIN:          228 <= top <= 229 AND 73 <= x0 <= 140\n")

print("Output written to _diag_output.txt")
