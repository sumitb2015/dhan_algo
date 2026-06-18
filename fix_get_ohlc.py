# Read the file
with open('lib/dhan_helper.py', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Replace lines 918-921 (0-indexed: 917-920)
new_lines = [
    '        quote = self.get_ohlc(\n',
    '            symbol=int(sec["SECURITY_ID"]),\n',
    '            exchange=sec.get("EXCH_ID", "NSE"),\n',
    '            instrument=sec.get("INSTRUMENT", "OPTIDX")\n',
    '        )\n',
    '        \n',
    '        if quote:\n',
    '            quote["CONTRACT_INFO"] = sec\n',
    '        \n',
    '        return quote\n'
]

# Replace the problematic lines
lines[917:921] = new_lines

# Write back
with open('lib/dhan_helper.py', 'w', encoding='utf-8') as f:
    f.writelines(lines)

print("Successfully fixed get_ohlc call!")
