# Subset Minecraft-AE.ttf -> assets/fonts/minecraft-ae.woff2
# Coverage: Basic Latin + Latin-1 + every character used in pack/list names.
# Rerun after adding packs or lists whose names contain new non-Latin characters:
#   python scripts/subset-font.py
import io
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

SRC = 'C:/Users/ASUS/AppData/Local/Microsoft/Windows/Fonts/Minecraft-AE.ttf'
ROOT = os.path.join(os.path.dirname(__file__), '..')
OUT = os.path.join(ROOT, 'assets', 'fonts', 'minecraft-ae.woff2')

chars = set()
idx = json.load(io.open(os.path.join(ROOT, 'data', 'index.json'), encoding='utf-8'))
for it in idx['items']:
    chars.update(it.get('displayName') or '')
    chars.update(it.get('id') or '')
    chars.update(re.sub(r'<[^>]+>', '', it.get('coloredName') or ''))
lists_path = os.path.join(ROOT, 'l', 'lists.json')
if os.path.exists(lists_path):
    for l in json.load(io.open(lists_path, encoding='utf-8')):
        chars.update(l.get('name') or '')

unicodes = set(range(0x20, 0x7F)) | set(range(0xA0, 0x100))
unicodes |= {0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026}
unicodes |= {ord(c) for c in chars if ord(c) >= 0x20}

font = TTFont(SRC)
available = set(font.getBestCmap())
missing = sorted(c for c in unicodes if c not in available and c > 0xFF)
if missing:
    print('not in font (will fall back):', ' '.join(chr(c) for c in missing))

opts = Options()
opts.flavor = 'woff2'
opts.desubroutinize = True
sub = Subsetter(options=opts)
sub.populate(unicodes=sorted(unicodes))
sub.subset(font)
font.save(OUT)
print(f'saved {OUT} ({os.path.getsize(OUT)} bytes, {len(unicodes)} codepoints requested)')
