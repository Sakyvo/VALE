"""Headless acceptance on real homepage/List/SBI renderers; optional public --base-url."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_sbi import cdp_call, cdp_eval, wait_for, wait_for_http, get_sbi_ws_url, resolve_browser_path
import websockets

ROOT = Path(__file__).resolve().parents[1]
PACK = 'Eum3_Blue_Editee'

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', default='http://127.0.0.1:8765')
    args = parser.parse_args()
    base = args.base_url.rstrip('/')
    local = base.startswith('http://127.0.0.1:')
    profile = tempfile.mkdtemp(prefix='vale-cover-layout-')
    hidden = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0
    server = browser = None
    results = []
    # The headless browser in this environment cannot reach the asset host (not even a
    # plain fetch), while the uploaded bytes are verified by ETag at publish time. A local
    # run therefore swaps the asset host for this checkout's masters: same PNG bytes, same
    # renderer, same stylesheet. A --base-url run against the deployment keeps the real host.
    localize = "(prefix) => { for (const img of document.querySelectorAll('img')) { if (img.src.includes('https://assets.vale.cc.cd/')) img.src = img.src.replace('https://assets.vale.cc.cd/', location.origin + '/thumbnails/'); } }"
    try:
        if local:
            server = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '--bind', '127.0.0.1'], cwd=ROOT,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=hidden)
        assert wait_for_http(base), 'site did not become ready'
        browser = subprocess.Popen([resolve_browser_path(None), '--headless=new', '--disable-gpu', '--no-first-run',
                                    '--no-default-browser-check', '--ignore-certificate-errors', '--remote-debugging-port=9277',
                                    '--user-data-dir=' + profile, 'about:blank'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=hidden)
        ws_url = None
        for _ in range(50):
            ws_url = get_sbi_ws_url(9277)
            if ws_url:
                break
            await asyncio.sleep(.2)
        assert ws_url, 'headless CDP did not become ready'
        async with websockets.connect(ws_url, max_size=50_000_000, proxy=None) as ws:
            await cdp_call(ws, 'Page.enable')
            await cdp_call(ws, 'Network.enable')
            await cdp_call(ws, 'Network.setCacheDisabled', {'cacheDisabled': True})
            async def navigate(route, ready):
                await cdp_call(ws, 'Page.navigate', {'url': base + route})
                await wait_for(ws, ready, timeout=180)
            async def measure(selector, page, width):
                await wait_for(ws, f"(() => {{const i=document.querySelector({json.dumps(selector)});return i && i.complete;}})()", timeout=240)
                probe = await cdp_eval(ws, f"(() => {{const i=document.querySelector({json.dumps(selector)});return [i.naturalWidth,i.naturalHeight,i.currentSrc];}})()")
                if probe[0] == 0:
                    markup = await cdp_eval(ws, "document.querySelector('#sbi-results').innerHTML.slice(0,400)")
                    print('SBI MARKUP', page, width, repr(markup)[:400])
                    diag = await cdp_eval(ws, f"(async () => {{ try {{ const r = await fetch({json.dumps(probe[2])}); return [r.status, r.headers.get('content-type')]; }} catch (e) {{ return ['fetch error', String(e)]; }} }})()")
                    print('IMAGE DIAGNOSTIC', page, width, probe, diag)
                assert probe[0] > 0, (page, width, probe)
                state = await cdp_eval(ws, f"""(() => {{
                  const i=document.querySelector({json.dumps(selector)}), r=i.getBoundingClientRect(), c=getComputedStyle(i);
                  const card=i.closest('.pack-card,.sbi-result-card').getBoundingClientRect();
                  return {{natural:[i.naturalWidth,i.naturalHeight],src:i.currentSrc,
                    rect:[r.x,r.y,r.width,r.height],card:[card.x,card.y,card.width,card.height],fit:c.objectFit,
                    overflow:document.documentElement.scrollWidth>innerWidth,
                    columns:document.querySelector('.pack-grid') ? getComputedStyle(document.querySelector('.pack-grid')).gridTemplateColumns.split(' ').length : null}};
                }})()""")
                assert state['natural'] == [728, 196], (page, width, state)
                assert 'cover-hud-v1.png' in state['src'], state
                assert (local and '/thumbnails/' in state['src']) or (not local and 'assets.vale.cc.cd' in state['src']), state
                assert state['fit'] == 'contain', state
                assert not state['overflow'], state
                x,y,w,h = state['rect']; cx,cy,cw,ch = state['card']
                assert w > 0 and h > 0 and x >= cx-1 and x+w <= cx+cw+1 and y+h <= cy+ch+1, state
                if page in ['home','list']:
                    assert abs(w/(h-1)-26/7) < .08, state
                    assert state['columns'] == (3 if width > 900 else 2 if width > 600 else 1), state
                results.append({'page':page,'width':width,**state})
            for width in [1400,800,390]:
                await cdp_call(ws, 'Emulation.setDeviceMetricsOverride', {'width':width,'height':900,'deviceScaleFactor':1,'mobile':False})
                await navigate('/', "!!window.PackLoader && !!document.querySelector('.pack-card')")
                await cdp_eval(ws, "document.querySelector('#search-input').value='Eum3 Blue Editee';document.querySelector('.search-btn').click();")
                if local: await cdp_eval(ws, "(" + localize + ")()")
                await measure('.pack-card .cover', 'home', width)
                await navigate('/l/Sakyvo/', "!!document.querySelector('#list-pack-search') && !!document.querySelector('.pack-card .cover')")
                if local: await cdp_eval(ws, "(" + localize + ")()")
                await measure('.pack-card .cover', 'list', width)
                await navigate('/sbi/', "!!window.__sbiTest && !!window.__sbiTest.renderResultCard")
                await cdp_eval(ws, "(async()=>{await window.__sbiTest.ensurePackNameIndex();const el=document.querySelector('#sbi-results');el.hidden=false;el.innerHTML=window.__sbiTest.renderResultCard({name:'Eum3_Blue_Editee',score:1},0,'full');})()")
                if local: await cdp_eval(ws, "(" + localize + ")()")
                await measure('.sbi-result-cover', 'sbi', width)
            print(json.dumps({'passed':len(results),'results':results}, ensure_ascii=True))
    finally:
        for process in [browser, server]:
            if process:
                process.terminate()
                try: process.wait(timeout=8)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
        shutil.rmtree(profile, ignore_errors=True)

if __name__ == '__main__':
    asyncio.run(main())
