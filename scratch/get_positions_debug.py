import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client

def main():
    dhan = get_dhan_client()
    if not dhan:
        print("Failed to authenticate")
        return
    res = dhan.get_positions()
    print(json.dumps(res, indent=2))

if __name__ == '__main__':
    main()
