import json
with open('access_token.json') as f:
    d = json.load(f)
print(d.get('accessToken', ''))
