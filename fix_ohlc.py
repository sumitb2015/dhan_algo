import re

with open('lib/dhan_helper.py', 'r', encoding='utf-8') as f:
    content = f.read()

# Find and replace the problematic return statement
old_pattern = r'''return self\.get_ohlc\(
            security_id=int\(sec\['SECURITY_ID'\]\),
            exchange_segment=sec\['SEGMENT'\]
        \)'''

new_code = '''quote = self.get_ohlc(
            symbol=int(sec['SECURITY_ID']),
            exchange=sec.get('EXCH_ID', 'NSE'),
            instrument=sec.get('INSTRUMENT', 'OPTIDX')
        )
        
        if quote:
            # Add contract info for convenience
            quote['CONTRACT_INFO'] = sec
            
        return quote'''

content = content.replace(old_pattern, new_code)

with open('lib/dhan_helper.py', 'w', encoding='utf-8') as f:
    f.write(content)

print("Fixed!")
