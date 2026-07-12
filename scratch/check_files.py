import os

atm_dir = r"c:\dhan_algo\dhan_algo\Options Data\NIFTY\ATM"
if os.path.exists(atm_dir):
    files = sorted(os.listdir(atm_dir))
    print("Files starting with 2026-04 in ATM folder:")
    for f in files:
        if f.startswith("2026-04"):
            print(f)
