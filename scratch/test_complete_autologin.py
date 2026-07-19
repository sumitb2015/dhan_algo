import sys
import os

# Add project root to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.zerodha.main import login_zerodha

def test_autologin():
    print("Testing the complete Zerodha login flow...")
    try:
        kite, kitew, enctoken, nifty_index, nifty_futures = login_zerodha()
        print("\n[SUCCESS] Entire autologin flow completed successfully!")
        print(f"Kite Access Token: {kite.access_token}")
        print(f"KiteApp enctoken: {enctoken}")
    except Exception as e:
        print(f"\n[FAILURE] Autologin failed: {e}")

if __name__ == "__main__":
    test_autologin()
