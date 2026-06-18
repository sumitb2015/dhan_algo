import inspect
from dhanhq import dhanhq

try:
    print("Signature:", inspect.signature(dhanhq.__init__))
    
    client_id = "1100342379" 
    access_token = "eyJ0eXAiOi..."
    
    print("\n--- TEST 4: DhanContext ---")
    try:
        from dhanhq import DhanContext
        context = DhanContext(client_id, access_token)
        d = dhanhq(context)
        print("Success: d = dhanhq(DhanContext(cid, token))")
    except ImportError:
        print("Failed: DhanContext not found")
    except Exception as e:
        print(f"Failed: {e}")
except Exception as e:
    print(e)

except Exception as e:
    print(e)
