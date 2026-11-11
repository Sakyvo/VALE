"""Train a small embedding network for Minecraft item-icon retrieval.

Input: one 16x16 RGBA slot crop rendered from a pack's texture (see render_hotbar).
Target: identify which pack it came from, among the whole corpus — the exact job
the browser matcher has to do. Contrastive training with an InfoNCE objective on
label-smoothed pack identity, plus augmentation that mirrors real screenshot
damage (downscale, JPEG, brightness/contrast drift, sub-pixel shifts).

Output: ONNX model producing a 128-d unit vector per slot icon.
"""

import argparse
import io
import sys as _sys
import math
import os
import random
import sys

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image, ImageEnhance

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render_hotbar import render_reference, render_capture  # noqa: E402

TEXTURES = [
    ("diamond_sword", ["diamond_sword.png"]),
    ("ender_pearl", ["ender_pearl.png"]),
    ("splash_potion", ["splash_potion_of_healing.png", "potion_bottle_splash.png"]),
    ("steak", ["steak.png"]),
    ("golden_carrot", ["golden_carrot.png"]),
]
EMBED_DIM = 128


def collect_packs(thumb_root, limit=0):
    packs = []
    for name in sorted(os.listdir(thumb_root)):
        d = os.path.join(thumb_root, name)
        if not os.path.isdir(d):
            continue
        found = []
        for key, files in TEXTURES:
            for f in files:
                p = os.path.join(d, f)
                if os.path.exists(p):
                    found.append((key, p))
                    break
        if found:
            packs.append((name, found))
        if limit and len(packs) >= limit:
            break
    return packs


def aug_tensor(img, rng):
    """Damage a 16x16 slot crop the way a screenshot+JPEG would."""
    # Sub-pixel scale/shift: the game's icon size varies with GUI scale.
    scale = rng.uniform(0.82, 1.0)
    if scale < 0.995:
        side = max(6, int(round(16 * scale)))
        small = img.resize((side, side), Image.BILINEAR)
        canvas = Image.new("RGBA", (16, 16), (32, 32, 32, 255))
        dx = rng.randint(0, 16 - side)
        dy = rng.randint(0, 16 - side)
        canvas.alpha_composite(small, (dx, dy))
        img = canvas
    # Brightness / contrast drift from capture and gamma.
    img = ImageEnhance.Brightness(img).enhance(rng.uniform(0.80, 1.25))
    img = ImageEnhance.Contrast(img).enhance(rng.uniform(0.80, 1.30))
    # JPEG artefacts.
    if rng.random() < 0.85:
        buf = io.BytesIO()
        img.convert("RGB").save(buf, format="JPEG", quality=rng.randint(45, 92))
        buf.seek(0)
        img = Image.open(buf).convert("RGBA")
    arr = np.asarray(img, dtype=np.float32) / 255.0
    # Colour jitter in mild form.
    arr[..., :3] = np.clip(arr[..., :3] * rng.uniform(0.92, 1.08), 0, 1)
    return torch.from_numpy(arr).permute(2, 0, 1)


class SlotEncoder(nn.Module):
    def __init__(self, dim=EMBED_DIM):
        super().__init__()
        self.body = nn.Sequential(
            nn.Conv2d(4, 32, 3, padding=1), nn.BatchNorm2d(32), nn.ReLU(inplace=True),
            nn.Conv2d(32, 32, 3, padding=1), nn.BatchNorm2d(32), nn.ReLU(inplace=True),
            nn.MaxPool2d(2),                                   # 8x8
            nn.Conv2d(32, 64, 3, padding=1), nn.BatchNorm2d(64), nn.ReLU(inplace=True),
            nn.Conv2d(64, 64, 3, padding=1), nn.BatchNorm2d(64), nn.ReLU(inplace=True),
            nn.MaxPool2d(2),                                   # 4x4
            nn.Conv2d(64, 128, 3, padding=1), nn.BatchNorm2d(128), nn.ReLU(inplace=True),
            nn.AdaptiveAvgPool2d(1),
        )
        self.head = nn.Linear(128, dim)

    def forward(self, x):
        return F.normalize(self.head(self.body(x).flatten(1)), dim=1)


def build_index(packs, rng, cache):
    """Both sides of the retrieval problem, per texture.

    The index stores the reference view while the browser hands over the capture
    view; without positives that span both, the encoder never learns to ignore
    that resampling difference and every query lands far from its own pack.
    """
    items = []
    for pack_id, (name, textures) in enumerate(packs):
        for key, path in textures:
            if path in cache:
                views = cache[path]
            else:
                views = [v for v in (render_reference(path, 16), render_capture(path, 16)) if v is not None]
                cache[path] = views
            for base in views:
                items.append((pack_id, key, base))
    return items


def sample_batch(by_pack, rng, packs_per_batch, shots):
    """PK sampling: every batch is `packs_per_batch` identities x `shots` views.

    Random batches leave almost no same-pack positives, which is why plain
    shuffling stalls the contrastive loss near log(batch).
    """
    chosen = [pid for pid in rng.sample(sorted(by_pack), min(packs_per_batch, len(by_pack)))]
    xs, ys = [], []
    for pid in chosen:
        pool = by_pack[pid]
        for _ in range(shots):
            base = pool[rng.randrange(len(pool))]
            xs.append(aug_tensor(base, rng))
            ys.append(pid)
    return torch.stack(xs), torch.tensor(ys)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--thumbs", default="thumbnails")
    ap.add_argument("--out", default="assets/models/sbi-embed.onnx")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--packs", type=int, default=0, help="limit packs (0 = all)")
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--pack-batch", type=int, default=32, help="identities sampled per step")
    ap.add_argument("--shots", type=int, default=4, help="views per identity per step")
    ap.add_argument("--steps", type=int, default=60, help="steps per epoch")
    ap.add_argument("--temp", type=float, default=0.07)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--device", default="cpu")
    args = ap.parse_args()

    # The console is GBK on this machine; torch.onnx prints emoji progress marks.
    try:
        _sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        _sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    rng = random.Random(args.seed)

    packs = collect_packs(args.thumbs, args.packs)
    print(f"packs: {len(packs)}")
    cache = {}
    items = build_index(packs, rng, cache)
    print(f"icons: {len(items)}")
    pack_count = len(packs)

    model = SlotEncoder().to(args.device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    by_pack = {}
    for pid, key, base in items:
        by_pack.setdefault(pid, []).append(base)
    print(f"identities: {len(by_pack)}")
    steps = args.steps
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=args.epochs * steps)

    for epoch in range(args.epochs):
        model.train()
        total = 0.0
        acc_total = 0.0
        for step in range(steps):
            x, y = sample_batch(by_pack, rng, args.pack_batch, args.shots)
            x, y = x.to(args.device), y.to(args.device)

            emb = model(x)
            logits = emb @ emb.t() / args.temp
            logits.fill_diagonal_(-1e4)
            pos = (y[:, None] == y[None, :]).float()
            pos.fill_diagonal_(0)
            pos_mass = pos.sum(1)
            log_prob = F.log_softmax(logits, dim=1)
            loss = -(log_prob * pos).sum(1) / pos_mass.clamp(min=1)
            loss = loss.mean()

            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            total += float(loss.detach())
            with torch.no_grad():
                correct = (y[logits.argmax(1)] == y).float().mean().item()
                acc_total += correct
        print(f"epoch {epoch + 1}/{args.epochs} loss {total / max(1, steps):.4f} batch_retrieval {acc_total / max(1, steps):.3f}")

    # Export: identical inference path the browser will use.
    model.eval()
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    dummy = torch.zeros(1, 4, 16, 16, device=args.device)
    torch.onnx.export(
        model, dummy, args.out,
        input_names=["slot"], output_names=["embedding"],
        opset_version=18, dynamic_axes={"slot": {0: "batch"}, "embedding": {0: "batch"}},
    )
    size = os.path.getsize(args.out)
    print(f"wrote {args.out} ({size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
