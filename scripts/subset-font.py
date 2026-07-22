# Subset site webfonts into assets/fonts/:
#   Minecraft-AE.ttf     -> minecraft-ae.woff2   (names: Basic Latin + Latin-1 + every pack/List name char)
#   HarmonyOS_Sans.ttf   -> harmonyos-sans.woff2 (UI text: Basic Latin + Latin-1, variable wght kept)
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
UI_SRC = 'C:/Users/ASUS/Desktop/HarmonyOS Sans/HarmonyOS_Sans.ttf'
ROOT = os.path.join(os.path.dirname(__file__), '..')
OUT = os.path.join(ROOT, 'assets', 'fonts', 'minecraft-ae.woff2')
UI_OUT = os.path.join(ROOT, 'assets', 'fonts', 'harmonyos-sans.woff2')

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

ui_opts = Options()
ui_opts.flavor = 'woff2'
ui_sub = Subsetter(options=ui_opts)
ui_sub.populate(unicodes=sorted(set(range(0x20, 0x7F)) | set(range(0xA0, 0x100)) |
                               {0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x2190, 0x2192}))
ui_font = TTFont(UI_SRC)
ui_sub.subset(ui_font)
ui_font.save(UI_OUT)
print(f'saved {UI_OUT} ({os.path.getsize(UI_OUT)} bytes, variable: {"fvar" in ui_font})')
