import asyncio
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

# Force stdout to UTF-8 on Windows
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

DEFAULT_BROWSER_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\chrome-win\chrome.exe",
]
DEFAULT_PORT = 9880
DEFAULT_DEBUG_PORT = 9337
TEST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_img")

PACK_ALIAS = {
    "pvpmen": "Pvpmen",
}


def normalize_pack_name(raw):
    # Strip " (2)" style counter suffixes and brackets; keep letters/digits/_
    s = re.sub(r"\s*\(\d+\)\s*$", "", raw).strip()
    s = s.replace("[", "").replace("]", "")
    s = re.sub(r"\s+", "_", s)
    s = re.sub(r"[^A-Za-z0-9_\-]", "", s)
    return s


def parse_test_images():
    tests = []
    for name in sorted(os.listdir(TEST_DIR)):
        m = re.match(r"^(Large|Small)\s*-\s*(.+)\.(png|jpe?g)$", name, re.I)
        if not m:
            continue
        scale = m.group(1).lower()
        expected = normalize_pack_name(m.group(2))
        low = expected.lower()
        if low in PACK_ALIAS:
            expected = PACK_ALIAS[low]
        tests.append((name, scale, expected))
    return tests


def parse_synthetic_manifest(tests_dir, tiers=None):
    """Read test_img/synthetic/manifest.json and emit (relpath, scale, expected_pack_name) triples.

    relpath is relative to test_img/synthetic/ so that the caller constructs
    the HTTP URL as base/test_img/synthetic/<relpath>.
    """
    manifest_path = os.path.join(tests_dir, 'synthetic', 'manifest.json')
    if not os.path.exists(manifest_path):
        return []
    with open(manifest_path, 'r', encoding='utf-8') as fh:
        manifest = json.load(fh)
    images = manifest.get('images', [])
    tests = []
    for img in images:
        if tiers and img.get('tier') not in tiers:
            continue
        rel = img.get('file')
        if not rel:
            continue
        expected = img.get('packId', '')
        if not expected:
            continue
        normalized = normalize_pack_name(expected)
        tests.append((rel.replace('\\', '/'), 'synthetic', normalized))
    return tests


def parse_args():
    parser = argparse.ArgumentParser(description="Run SBI image matching regression tests.")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--image", help="Run one test image by exact or case-insensitive substring match.")
    group.add_argument("--filter", help="Run test images whose filename matches this regex.")
    group.add_argument("--synthetic", action="store_true",
                       help="Evaluate the synthetic corpus (test_img/synthetic/manifest.json) instead of the 9-shot regression set.")
    parser.add_argument("--fail-fast", action="store_true", help="Stop after the first failed test.")
    parser.add_argument("--quiet", action="store_true", help="Only print compact per-image results and summary.")
    parser.add_argument("--verbose", action="store_true", help="Print slot features and top-10 rows.")
    parser.add_argument("--diagnostics-json", help="Write full candidate diagnostics for offline scoring analysis.")
    parser.add_argument("--no-timings", action="store_true", help="Hide per-image timing output.")
    parser.add_argument("--base-url", help="Test a deployed site instead of starting the local HTTP server.")
    parser.add_argument("--benchmark", choices=("warm", "cold"), help="Run repeated warm- or cold-cache measurements.")
    parser.add_argument("--runs", type=int, default=5, help="Runs per image in benchmark mode (default: 5).")
    parser.add_argument("--force-fallback", action="store_true", help="Force the global coarse fallback path.")
    parser.add_argument("--benchmark-groups", type=int, help="Inflate the browser corpus to this many groups for performance testing.")
    parser.add_argument("--enforce-budgets", action="store_true", help="Fail when benchmark p95 exceeds SBI budgets.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="HTTP server port.")
    parser.add_argument("--debug-port", type=int, default=DEFAULT_DEBUG_PORT, help="Browser CDP port.")
    parser.add_argument("--browser", help="Browser executable path. Defaults to Edge if available, then Chrome.")
    parser.add_argument("--synthetic-tiers", default="light",
                       help="Comma-separated synthetic tiers to evaluate (default: light).")
    parser.add_argument("--limit", type=int, default=0,
                       help="Cap the number of evaluated images (0 = no cap). Useful for baseline sampling.")
    parser.add_argument("--headless", default="--headless", help="Browser headless flag, e.g. --headless or --headless=new.")
    return parser.parse_args()


def filter_tests(tests, args):
    if getattr(args, 'synthetic', False):
        return tests
    if args.image:
        needle = args.image.lower()
        exact = [test for test in tests if test[0].lower() == needle]
        return exact or [test for test in tests if needle in test[0].lower()]
    if args.filter:
        pattern = re.compile(args.filter, re.I)
        return [test for test in tests if pattern.search(test[0])]
    return tests


def fmt_seconds(value):
    return f"{value:.2f}s"


def percentile(values, quantile):
    ordered = sorted(value for value in values if isinstance(value, (int, float)))
    if not ordered:
        return None
    index = max(0, min(len(ordered) - 1, int((len(ordered) * quantile + 0.999999)) - 1))
    return ordered[index]


def resolve_browser_path(path):
    if path:
        if not os.path.isfile(path):
            raise FileNotFoundError(f"Browser not found: {path}")
        return path
    for candidate in DEFAULT_BROWSER_CANDIDATES:
        if os.path.isfile(candidate):
            return candidate
    raise FileNotFoundError("No supported browser found. Pass --browser <path>.")


async def cdp_call(ws, method, params=None, recv_timeout=10, _counter=[0]):
    _counter[0] += 1
    msg_id = _counter[0]
    await ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=recv_timeout)
        resp = json.loads(raw)
        if resp.get("id") == msg_id:
            if "error" in resp:
                raise RuntimeError(resp["error"].get("message", "CDP error"))
            return resp.get("result", {})


async def cdp_eval(ws, expr, timeout=60):
    result = await cdp_call(ws, "Runtime.evaluate", {
        "expression": expr,
        "returnByValue": True,
        "awaitPromise": True,
        "timeout": timeout * 1000,
    }, recv_timeout=timeout + 5)
    val = result.get("result", {})
    if val.get("subtype") == "error":
        raise RuntimeError(val.get("description", "JS error"))
    return val.get("value")


async def wait_for(ws, js_expr, timeout=30):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        val = await cdp_eval(ws, js_expr, timeout=5)
        if val:
            return val
        await asyncio.sleep(0.3)
    raise TimeoutError(f"Timed out waiting for: {js_expr}")


def wait_for_http(url, timeout=10):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 VALE-SBI-Test"})
            with urllib.request.urlopen(request, timeout=2) as resp:
                if resp.status < 500:
                    return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


def fetch_cdp_json(debug_port, path):
    try:
        raw = urllib.request.urlopen(f"http://127.0.0.1:{debug_port}{path}", timeout=1).read()
        return json.loads(raw)
    except Exception:
        return None


def get_cdp_pages(debug_port):
    return fetch_cdp_json(debug_port, "/json/list") or []


def get_sbi_ws_url(debug_port):
    pages = get_cdp_pages(debug_port)
    if not pages:
        return None
    fallback = None
    for page in pages:
        if page.get("type") != "page" or not page.get("webSocketDebuggerUrl"):
            continue
        if not fallback:
            fallback = page["webSocketDebuggerUrl"]
        if "/sbi/" in page.get("url", ""):
            return page["webSocketDebuggerUrl"]
    return fallback


def match_name(expected, got):
    return expected == got


async def main():
    import websockets

    args = parse_args()
    if args.runs <= 0:
        print("ERROR: --runs must be positive")
        return 1
    if args.benchmark_groups is not None and (args.benchmark_groups <= 0 or not args.benchmark):
        print("ERROR: --benchmark-groups requires --benchmark and a positive group count")
        return 1
    base = args.base_url.rstrip("/") if args.base_url else f"http://127.0.0.1:{args.port}"
    sbi_url = f"{base}/sbi/"
    try:
        browser_path = resolve_browser_path(args.browser)
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}")
        return 1
    print(f"Browser: {browser_path}\n", flush=True)
    if args.synthetic:
        tiers = set(t.strip() for t in args.synthetic_tiers.split(",") if t.strip())
        tests = filter_tests(parse_synthetic_manifest(TEST_DIR, tiers), args)
        if args.limit > 0:
            tests = tests[:args.limit]
    else:
        tests = filter_tests(parse_test_images(), args)
    if not tests:
        print("No test images found in", TEST_DIR)
        return 1

    print(f"Found {len(tests)} test image(s)\n", flush=True)
    suite_t0 = time.monotonic()

    server_proc = None
    if not args.base_url:
        server_proc = subprocess.Popen(
            [sys.executable, "-m", "http.server", str(args.port), "--bind", "127.0.0.1"],
            cwd=os.path.dirname(os.path.abspath(__file__)),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    if not wait_for_http(sbi_url):
        print(f"ERROR: SBI URL did not become ready at {sbi_url}")
        if server_proc:
            server_proc.terminate()
        return 1

    # Start browser with remote debugging
    profile_dir = tempfile.mkdtemp(prefix="sbi-test-")
    edge_log_path = os.path.join(profile_dir, "edge.log")
    edge_log = open(edge_log_path, "w", encoding="utf-8", errors="replace")
    edge_proc = subprocess.Popen([
        browser_path,
        f"--remote-debugging-port={args.debug_port}",
        f"--user-data-dir={profile_dir}",
        "--no-first-run", "--no-default-browser-check",
        "--disable-extensions", "--disable-popup-blocking",
        "--disable-gpu",
        "--disable-gpu-sandbox",
        "--disable-software-rasterizer",
        "--disable-features=VizDisplayCompositor",
        "--use-angle=swiftshader",
        "--use-gl=swiftshader",
        args.headless,
        sbi_url,
    ], stdout=edge_log, stderr=edge_log)

    results = []
    synthetic_records = []  # (file, packId, tier, recalled, topGroupId, expectedGroupId)
    diagnostics = []
    candidate_recalls = []
    benchmark_samples = []
    try:
        # Wait for CDP
        ws_url = None
        for _ in range(60):
            ws_url = get_sbi_ws_url(args.debug_port)
            if ws_url:
                break
            await asyncio.sleep(0.5)

        if not ws_url:
            print("ERROR: Could not connect to browser CDP")
            if edge_proc.poll() is not None:
                print(f"Browser exited with code {edge_proc.returncode}")
            edge_log.flush()
            try:
                with open(edge_log_path, "r", encoding="utf-8", errors="replace") as fh:
                    lines = fh.readlines()[-20:]
                for line in lines:
                    print("  " + line.rstrip())
            except Exception:
                pass
            return 1

        ws = None
        for attempt in range(5):
            try:
                ws_url = get_sbi_ws_url(args.debug_port) or ws_url
                ws = await websockets.connect(ws_url, max_size=50_000_000, proxy=None)
                await cdp_call(ws, "Runtime.enable")
                await cdp_call(ws, "Page.enable")
                if args.benchmark == "cold":
                    await cdp_call(ws, "Network.enable")
                break
            except Exception:
                if ws:
                    await ws.close()
                ws = None
                if attempt == 4:
                    print("ERROR: Could not attach to browser CDP target")
                    edge_log.flush()
                    try:
                        with open(edge_log_path, "r", encoding="utf-8", errors="replace") as fh:
                            lines = fh.readlines()[-20:]
                        for line in lines:
                            print("  " + line.rstrip())
                    except Exception:
                        pass
                    return 1
                await asyncio.sleep(0.5)

        async with ws:
            # Wait for SBI page ready
            try:
                await wait_for(ws, "!!window.__sbiTest && !!document.getElementById('sbi-results')", timeout=30)
            except TimeoutError:
                state = await cdp_eval(ws, """
                    JSON.stringify({
                        href: location.href,
                        readyState: document.readyState,
                        hasResults: !!document.getElementById('sbi-results'),
                        hasHook: !!window.__sbiTest,
                    })
                """, timeout=5)
                print(f"DEBUG page state: {state}")
                return 1

            print("SBI page ready\n", flush=True)

            test_runs = []
            if args.benchmark == "warm":
                test_runs.append((*tests[0], True, 0))
            run_count = args.runs if args.benchmark else 1
            benchmark_exclusions = sorted({test[2] for test in tests})
            for run_index in range(run_count):
                for test in tests:
                    test_runs.append((*test, False, run_index + 1))

            for img_name, preset, expected, is_warmup, run_index in test_runs:
                if args.benchmark == "cold":
                    await cdp_call(ws, "Network.setCacheDisabled", {"cacheDisabled": True})
                    await cdp_call(ws, "Page.reload", {"ignoreCache": True})
                    await wait_for(ws, "!!window.__sbiTest && !!document.getElementById('sbi-results')", timeout=30)
                test_t0 = time.monotonic()
                try:
                    if getattr(args, 'synthetic', False):
                        img_url = f"{base}/test_img/synthetic/{urllib.parse.quote(img_name)}"
                    else:
                        img_url = f"{base}/test_img/{urllib.parse.quote(img_name)}"
                    js_img_name = json.dumps(img_name)
                    js_preset = json.dumps(preset)
                    js_img_url = json.dumps(img_url)
                    js_detail = json.dumps("verbose" if args.verbose else "compact")
                    js_expected = json.dumps(expected)
                    js = f"""
                    (async () => {{
                      const timings = {{}};
                      const t0 = performance.now();
                      const resp = await fetch({js_img_url});
                      if (!resp.ok) throw new Error("Fetch " + resp.status);
                      const blob = await resp.blob();
                      timings.fetch = performance.now() - t0;
                      const file = new File([blob], {js_img_name}, {{ type: blob.type }});
                      window.__sbiTest.setForceGlobalFallback({str(bool(args.force_fallback)).lower()});
                      window.__sbiTest.setBenchmarkCorpusSize({args.benchmark_groups or 0}, {json.dumps(benchmark_exclusions)});
                      try {{
                        const p0 = performance.now();
                        await window.__sbiTest.processImage(file, {js_preset});
                        timings.process = performance.now() - p0;
                      }} catch(e) {{
                        return JSON.stringify({{ error: e.message || String(e) }});
                      }} finally {{
                        window.__sbiTest.setForceGlobalFallback(false);
                      }}
                      const errEl = document.querySelector('.sbi-no-results');
                      if (errEl) return JSON.stringify({{ error: errEl.textContent }});
                      const s = window.__sbiTest.getSummary({{ detail: {js_detail} }});
                      s.expectedResult = window.__sbiTest.getPackResult({js_expected});
                      if ({str(True if (args.verbose or args.diagnostics_json) else False).lower()}) {{
                        s.anchorEvidence = window.__sbiTest.getAnchorEvidence();
                        s.slotVariantImages = {{
                          ds: window.__sbiTest.getSlotVariantImages(0),
                          ep: window.__sbiTest.getSlotVariantImages(1),
                        }};
                        s.comparisons = {{}};
                        const names = Array.from(new Set([{js_expected}, ...s.ranked.slice(0, 3).map(row => row.name)]));
                        for (const name of names) {{
                          s.comparisons[name] = {{
                            DS: window.__sbiTest.comparePackSlot(name, 0, 'diamond_sword'),
                            EP: window.__sbiTest.comparePackSlot(name, 1, 'ender_pearl'),
                          }};
                        }}
                      }}
                      s.timings = Object.assign(timings, s.timings || {{}});
                      return JSON.stringify(s);
                    }})()
                    """
                    raw = await cdp_eval(ws, js, timeout=90)
                    summary = json.loads(raw) if isinstance(raw, str) else raw

                    if is_warmup:
                        if "error" in summary:
                            raise RuntimeError(f"Warm-up failed: {summary['error']}")
                        print("Warm cache ready\n", flush=True)
                        continue

                    if "error" in summary:
                        elapsed = time.monotonic() - test_t0
                        results.append((img_name, expected, f"ERROR: {summary['error']}", False, elapsed))
                        candidate_recalls.append(False)
                        print(f"  [ERROR] {img_name}: {summary['error']} ({fmt_seconds(elapsed)})\n")
                        if args.fail_fast:
                            break
                        continue

                    ranked = summary.get("ranked", [])
                    debug = summary.get("debug", {})
                    timings = summary.get("timings", {})
                    top1 = ranked[0]["name"] if ranked else "(none)"
                    top_group = ranked[0].get("groupId") if ranked else None
                    expected_result = summary.get("expectedResult") or {}
                    expected_group = expected_result.get("groupId")
                    expected_member_exists = expected in (expected_result.get("groupMembers") or [])
                    recall_ok = bool(expected_group and expected_result.get("fullScored"))
                    candidate_recalls.append(recall_ok)
                    margin = None
                    if len(ranked) >= 2:
                        margin = ranked[0].get("score", 0) - ranked[1].get("score", 0)
                    ok = expected_member_exists and recall_ok and expected_group == top_group
                    status = "PASS" if ok else "FAIL"
                    elapsed = time.monotonic() - test_t0
                    results.append((img_name, expected, top1, ok, elapsed))
                    if args.synthetic:
                        parts = img_name.split('/')
                        tier = parts[1] if len(parts) >= 3 else 'unknown'
                        synthetic_records.append({
                            'image': img_name,
                            'expected': expected,
                            'tier': tier,
                            'recalled': recall_ok,
                            'expected_group': expected_group,
                            'top_group': top_group,
                            'member_exists': expected_member_exists,
                        })
                    if args.benchmark:
                        benchmark_samples.append({
                            "mode": args.benchmark,
                            "image": img_name,
                            "run": run_index,
                            "timings": timings,
                            "matchMetrics": debug.get("matchMetrics") or {},
                        })
                    if args.diagnostics_json:
                        diagnostics.append({
                            "image": img_name,
                            "preset": preset,
                            "expected": expected,
                            "summary": summary,
                        })
                    def fmt_row(r):
                        parts = [f"{r['name']}={r['score']:.4f}"]
                        if r.get('slotComposite') is not None:
                            parts.append(f"slot={r['slotComposite']:.3f}")
                        pts = r.get('perTypeScores') or {}
                        if pts:
                            tparts = []
                            for k in ('DS', 'EP', 'HL', 'SK/GC'):
                                v = pts.get(k)
                                if v is not None:
                                    tparts.append(f"{k}={v:.2f}")
                            if tparts:
                                parts.append("(" + " ".join(tparts) + ")")
                        if r.get('criticalTypeScore') is not None:
                            parts.append(f"crit={r['criticalTypeScore']:.2f}")
                        if r.get('healthSim') is not None:
                            parts.append(f"HP={r['healthSim']:.2f}")
                        if r.get('hungerSim') is not None:
                            parts.append(f"Hu={r['hungerSim']:.2f}")
                        if r.get('armorSim') is not None:
                            parts.append(f"Ar={r['armorSim']:.2f}")
                        if r.get('widgetSim') is not None:
                            parts.append(f"wg={r['widgetSim']:.3f}")
                        if r.get('coverage') is not None:
                            parts.append(f"cov={r['coverage']:.2f}")
                        if r.get('distinguishability') is not None:
                            parts.append(f"dist={r['distinguishability']:.2f}")
                        if r.get('sharedness') is not None:
                            parts.append(f"shared={r['sharedness']:.2f}")
                        if r.get('anchorPenalty') is not None:
                            parts.append(f"apen={r['anchorPenalty']:.3f}")
                        gaps = r.get('anchorGaps') or {}
                        if gaps:
                            gap_parts = []
                            for key in ('ds', 'ep', 'widget', 'hp'):
                                v = gaps.get(key)
                                if isinstance(v, (int, float)) and v > 0.001:
                                    gap_parts.append(f"{key}={v:.2f}")
                            if gap_parts:
                                parts.append("gap(" + " ".join(gap_parts) + ")")
                        return "[" + " ".join(parts) + "]"
                    timing_parts = []
                    if not args.no_timings:
                        for key in ("fetch", "decode", "fingerprints", "extract", "food", "inflate", "inflateSettle", "match", "render", "process"):
                            value = timings.get(key)
                            if isinstance(value, (int, float)):
                                timing_parts.append(f"{key}={value / 1000:.2f}s")
                        timing_parts.append(f"total={fmt_seconds(elapsed)}")
                    timing_text = (" | " + ", ".join(timing_parts)) if timing_parts else ""

                    margin_text = f" | margin={margin:.4f}" if isinstance(margin, (int, float)) else ""
                    run_text = f" [run {run_index}]" if args.benchmark else ""
                    print(f"  [{status}]{run_text} {img_name} -> {top1}{margin_text}{timing_text}")
                    if not args.quiet:
                        print(f"    Expected: {expected}")
                        print(f"    Group:    expected={expected_group or '-'}, top={top_group or '-'}, recalled={recall_ok}")
                        if debug:
                            print(f"    Debug:    slots={debug.get('slotCount')}, hearts={debug.get('heartCount')}, hunger={debug.get('hungerCount')}, armor={debug.get('armorCount')}, ranked={debug.get('rankedCount')}")
                        print(f"    SlotTypes: {summary.get('slotTypes', '-')}")
                    if args.verbose:
                        expected_result = summary.get('expectedResult') or {}
                        print(
                            f"    ExpectedState: rank={expected_result.get('rank')} "
                            f"fullScored={expected_result.get('fullScored')} group={expected_result.get('groupId')}"
                        )
                        sfs = summary.get('slotFeatures', [])
                        for sf in sfs:
                            if sf is None: continue
                            sig = sf.get('sig') or {}
                            print(f"    Slot[{sf['index']}]: act={sf.get('activity',0):.2f} var={sf.get('variance',0):.0f} n={sig.get('n','?')} cov={sig.get('coverage',0):.2f} lum={sig.get('meanLum',0):.0f} R={sig.get('meanR',0):.0f} G={sig.get('meanG',0):.0f} B={sig.get('meanB',0):.0f} redF={sig.get('redFrac',0):.3f} yF={sig.get('yellowFrac',0):.3f} blueF={sig.get('blueFrac',0):.3f}")
                        for r in ranked[:10]:
                            print(f"    #  {fmt_row(r)}")
                        for pack_name, types in (summary.get('comparisons') or {}).items():
                            parts = []
                            for type_name in ('DS', 'EP'):
                                comparison = types.get(type_name) if isinstance(types, dict) else None
                                variants = (comparison or {}).get('variants') or []
                                if not variants:
                                    continue
                                best = max(variants, key=lambda row: row.get('final') or 0)
                                parts.append(
                                    f"{type_name}:final={best.get('final', 0):.3f} "
                                    f"base={best.get('base', 0):.3f} spatial={best.get('spatial', 0):.3f} "
                                    f"shape={best.get('spatialShape', 0):.3f} dir={best.get('spatialDirection', 0):.3f} "
                                    f"color={best.get('spatialColor', 0):.3f} "
                                    f"sig={best.get('signature', 0):.3f} hash={best.get('hamming', 0):.3f} "
                                    f"hist={best.get('histogram', 0):.3f} mom={best.get('moments', 0):.3f} edge={best.get('edge', 0):.3f}"
                                )
                            if parts:
                                print(f"    Compare {pack_name}: " + " | ".join(parts))
                    if not ok:
                        for idx, r in enumerate(ranked):
                            if match_name(expected, r['name']):
                                print(f"    Expected@#{idx+1}: {fmt_row(r)}")
                                break
                        if args.fail_fast:
                            break
                    print()
                except Exception as e:
                    elapsed = time.monotonic() - test_t0
                    results.append((img_name, expected, f"ERROR: {e}", False, elapsed))
                    candidate_recalls.append(False)
                    print(f"  [ERROR] {img_name}: {e} ({fmt_seconds(elapsed)})\n")
                    if args.fail_fast:
                        break

    finally:
        edge_proc.terminate()
        if server_proc:
            server_proc.terminate()
        try:
            edge_proc.wait(timeout=5)
        except Exception:
            edge_proc.kill()
        if server_proc:
            try:
                server_proc.wait(timeout=3)
            except Exception:
                server_proc.kill()
        await asyncio.sleep(0.5)
        try:
            edge_log.close()
        except Exception:
            pass
        shutil.rmtree(profile_dir, ignore_errors=True)

    # Summary
    passed = sum(1 for result in results if result[3])
    total = len(results)
    suite_elapsed = time.monotonic() - suite_t0
    print("=" * 50)
    print(f"Results: {passed}/{total} passed in {fmt_seconds(suite_elapsed)}")
    print(f"Candidate recall: {sum(candidate_recalls)}/{len(candidate_recalls)}")
    for name, expected, got, ok, elapsed in results:
        print(f"  {'PASS' if ok else 'FAIL'}: {name} -> {got} (expected {expected}, {fmt_seconds(elapsed)})")

    if args.synthetic:
        print("\n# Synthetic corpus (separate from 9-shot regression; diagnostic only, NOT acceptance)")
        if not synthetic_records:
            print("  (no synthetic records collected)")
        else:
            by_tier = {}
            for rec in synthetic_records:
                by_tier.setdefault(rec['tier'], []).append(rec)
            for tier in sorted(by_tier):
                recs = by_tier[tier]
                n = len(recs)
                recalled = sum(1 for r in recs if r['recalled'])
                top1_group = sum(1 for r in recs if r['expected_group'] and r['expected_group'] == r['top_group'])
                member_exists = sum(1 for r in recs if r['member_exists'])
                print(f"  [{tier}] n={n}  coarse recall={recalled}/{n} ({100*recalled/n:.1f}%)  "
                      f"group top-1={top1_group}/{n} ({100*top1_group/n:.1f}%)  "
                      f"expected member present={member_exists}/{n} ({100*member_exists/n:.1f}%)")
            # Indistinguishable pack sets: groups whose median member_exists + recalled and top1==expected
            print("  \n# Indistinguishable-pack sets (groups whose every synthetic shot matched its own group as top-1):")
            groups_out = {}
            for rec in synthetic_records:
                gid = rec['expected_group']
                if not gid:
                    continue
                ok = rec['recalled'] and rec['member_exists'] and rec['expected_group'] == rec['top_group']
                groups_out.setdefault(gid, []).append(ok)
            fully = [gid for gid, oks in groups_out.items() if any(oks) and all(oks)]
            partial = [gid for gid, oks in groups_out.items() if any(oks) and not all(oks)]
            none = [gid for gid, oks in groups_out.items() if not any(oks)]
            print(f"  fully indistinguishable: {len(fully)}  partially: {len(partial)}  none: {len(none)}")
        return 0 if passed == total else 1

    budget_ok = True
    if benchmark_samples:
        print("\nBenchmark:")
        percentiles = {}
        timing_metrics = (
            ("total", lambda sample: sample["timings"].get("process")),
            ("match", lambda sample: sample["timings"].get("match")),
            ("load", lambda sample: sample["timings"].get("fingerprints")),
            ("extract", lambda sample: sample["timings"].get("extract")),
            ("inflate", lambda sample: sample["timings"].get("inflate")),
            ("inflate settle", lambda sample: sample["timings"].get("inflateSettle")),
            ("candidate", lambda sample: sample["matchMetrics"].get("candidatePlanningMs")),
            ("coarse", lambda sample: sum(
                sample["matchMetrics"].get(key) or 0 for key in ("coarseMs", "globalCoarseMs")
            )),
            ("full", lambda sample: sum(
                run.get("totalMs") or 0 for run in sample["matchMetrics"].get("runs", [])
            )),
            ("refine", lambda sample: sum(
                run.get("refinementMs") or 0 for run in sample["matchMetrics"].get("runs", [])
            )),
            ("expand", lambda sample: sample["matchMetrics"].get("expansionMs")),
            ("render", lambda sample: sample["timings"].get("render")),
        )
        for label, getter in timing_metrics:
            values = [getter(sample) for sample in benchmark_samples]
            p50 = percentile(values, 0.50)
            p95 = percentile(values, 0.95)
            percentiles[label] = p95
            if p50 is not None and p95 is not None:
                print(f"  {label}: p50={p50:.1f}ms p95={p95:.1f}ms")
        count_metrics = (
            ("prefilter", "candidatePrefilterCount"),
            ("full unique", "fullScoreCount"),
            ("full evaluations", "fullScoreEvaluations"),
            ("global coarse", "globalCoarseCount"),
        )
        for label, key in count_metrics:
            values = [sample["matchMetrics"].get(key) for sample in benchmark_samples]
            p50 = percentile(values, 0.50)
            p95 = percentile(values, 0.95)
            if p50 is not None and p95 is not None:
                print(f"  {label}: p50={p50:.0f} p95={p95:.0f}")
        fallback_count = sum(1 for sample in benchmark_samples if sample["matchMetrics"].get("fallback"))
        print(f"  samples={len(benchmark_samples)} fallback={fallback_count}/{len(benchmark_samples)}")
        if args.enforce_budgets:
            total_limit = 2000 if args.benchmark == "cold" else 1200
            total_p95 = percentiles.get("total")
            match_p95 = percentiles.get("match")
            budget_ok = bool(
                total_p95 is not None and total_p95 <= total_limit and
                match_p95 is not None and match_p95 <= 150
            )
            print(f"  budget={'PASS' if budget_ok else 'FAIL'} total<={total_limit}ms match<=150ms")

    if args.diagnostics_json:
        output_path = os.path.abspath(args.diagnostics_json)
        with open(output_path, "w", encoding="utf-8") as fh:
            json.dump(diagnostics, fh, ensure_ascii=False)
        print(f"Diagnostics: {output_path}")

    return 0 if passed == total and budget_ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
