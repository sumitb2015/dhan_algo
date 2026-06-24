from dhanhq import dhanhq
import inspect

print("dhanhq class fields/attributes:")
for name, value in inspect.getmembers(dhanhq):
    if not name.startswith('_') and not callable(value):
        print(f"  {name}: {value}")

print("\nMethod list:")
for name, value in inspect.getmembers(dhanhq):
    if not name.startswith('_') and callable(value):
        print(f"  {name}")
