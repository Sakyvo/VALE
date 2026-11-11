"""Render pack icons two ways so the encoder can learn the gap between them.

`render_reference` is how the offline index sees a texture (crop to content,
nearest-scale onto a slot plate). `render_capture` is how the browser's slot
extractor sees the same item after the game drew it and the screenshot was
downscaled — a different resampling path, and the reason references and queries
never matched. Training on (reference, capture) pairs of the same texture teaches
the encoder to ignore that difference.
"""

from PIL import Image

PLATE = (32, 32, 32, 255)
ICON_FILL = 0.86
CAPTURE_SLOT_PX = 54


def load_first_frame(path):
    img = Image.open(path).convert("RGBA")
    w, h = img.size
    if h > w and h % w == 0:
        img = img.crop((0, 0, w, w))
    return img


def crop_to_content(img, alpha_min=48):
    bbox = img.split()[3].point(lambda a: 255 if a >= alpha_min else 0).getbbox()
    if not bbox:
        return None
    return img.crop(bbox)


def _compose(item, out_size):
    plate = Image.new("RGBA", (out_size, out_size), PLATE)
    off = (out_size - item.size[0]) // 2
    plate.alpha_composite(item, (off, off))
    return plate


def render_reference(path, out_size=16):
    """Index-side view: content-cropped item scaled onto a slot plate."""
    icon = crop_to_content(load_first_frame(path))
    if icon is None:
        return None
    item_px = max(2, int(round(out_size * ICON_FILL)))
    return _compose(icon.resize((item_px, item_px), Image.NEAREST), out_size)


def render_capture(path, out_size=16, slot_px=CAPTURE_SLOT_PX):
    """Extractor-side view: draw at slot resolution, then nearest-downscale.

    This mirrors what `extractHotbarSlots` hands the matcher for a real
    screenshot, so training positives cover the same resampling.
    """
    frame = load_first_frame(path)
    icon = crop_to_content(frame)
    if icon is None:
        return None
    item_px = max(2, int(round(slot_px * ICON_FILL)))
    big = _compose(icon.resize((item_px, item_px), Image.NEAREST), slot_px)
    return big.resize((out_size, out_size), Image.NEAREST)


# Backwards-compatible alias: the reference renderer is the index-side view.
def render_slot(path, out_size=16, rng=None):
    return render_reference(path, out_size)
