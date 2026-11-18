"""Static board diagram of STBLarge on a DGX Spark: who does what, what sits where, and the four speed-ups.

Usage: python3 tools/figures/stblarge.py OUT_DIR  ->  stbl-board-wide.svg, stbl-board-narrow.svg
Sizes follow the engine's layout: model on disk (Engram 189, experts 269, draft head 6.7, fixed 9.9 GiB)
and memory (fixed 9, expert cache 103, KV and headroom 9 GiB).
"""
import html
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from pipelines import wrap, LINE, NARROW_W  # noqa: E402

FILL = {"blue": "var(--fig-blue)", "violet": "var(--fig-violet)", "teal": "var(--fig-teal)",
        "red": "var(--fig-red)", "muted": "var(--muted)"}


class Fig:
    def __init__(self, prefix):
        self.p, self.parts = prefix, []

    def text(self, x, y, s, cls="d-note", anchor="start"):
        self.parts.append(f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="{anchor}" class="{cls}">{html.escape(s)}</text>')

    def rect(self, x, y, w, h, color, fill=None, dashed=False, rx=4, tint=0.0):
        dash = ' stroke-dasharray="4 3"' if dashed else ""
        f = (f'fill="{FILL[color]}" fill-opacity="{tint}"' if tint else f'fill="{fill or "var(--paper)"}"')
        self.parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{rx}" {f} '
                          f'stroke="{FILL[color]}" stroke-width="1.4"{dash}/>')

    def line(self, d, color="muted", arrow=True, dashed=False, both=False):
        dash = ' stroke-dasharray="4 3"' if dashed else ""
        m = f' marker-end="url(#{self.p}-{color})"' if arrow else ""
        if both:
            m += f' marker-start="url(#{self.p}-{color})"'
        self.parts.append(f'<path d="{d}" fill="none" stroke="{FILL[color]}" stroke-width="1.3"{dash}{m}/>')

    def star(self, x, y):
        self.parts.append(f'<text x="{x:.1f}" y="{y + 0.5:.1f}" text-anchor="middle" class="d-star">★</text>')

    def num(self, x, y, n):
        self.parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="8" fill="var(--fig-blue)"/>')
        self.text(x, y + 3.5, str(n), "d-badge", "middle")

    def block(self, x, y, w, title, role, bullets, color, n=None, min_h=0):
        """Titled box with an italic role line and bullet notes; returns its height."""
        star = title.startswith("*")
        title = title.lstrip("*")
        rows = [("d-note", r, (i == 0) and ("star" if b.startswith("*") else True))
                for b in bullets for i, r in enumerate(wrap(b.lstrip("*"), w - 26, "d-note"))]
        tlines = wrap(title, w - (30 if (star or n) else 18), "d-title")
        h = max(min_h, 9 + 15 * len(tlines) + (15 if role else 0) + 14 * len(rows) + 9)
        self.rect(x, y, w, h, color)
        ty = y + 9 + 12
        tx = x + 9
        if n:
            self.num(x + 17, ty - 4, n)
            tx = x + 31
        if star:
            self.star(x + 13, ty)
            tx = x + 21
        for i, t in enumerate(tlines):
            self.text(tx, ty + 15 * i, t, "d-title")
        ty += 15 * (len(tlines) - 1)
        if role:
            ty += 15
            self.text(x + 9, ty, role, "d-dim")
        for cls, s, dot in rows:
            ty += 14
            if dot == "star":
                self.star(x + 11, ty)
            elif dot:
                self.parts.append(f'<circle cx="{x + 11:.1f}" cy="{ty - 4:.1f}" r="1.3" class="d-dot"/>')
            self.text(x + 17, ty, s, cls)
        return h

    def bar(self, x, y, w, h, segs, total):
        """Proportional bar. segs: (size, color, [label lines]) with labels drawn inside when they fit."""
        cx = x
        spans = []
        for size, color, labels in segs:
            sw = w * size / total
            self.rect(cx, y, sw, h, color, tint=0.16, rx=2)
            if labels:
                for i, s in enumerate(labels):
                    self.text(cx + sw / 2, y + h / 2 - 7 * (len(labels) - 1) + 14 * i + 4, s,
                              "d-title" if i == 0 else "d-note", "middle")
            spans.append((cx, sw))
            cx += sw
        return spans

    def render(self, w, h, label, cls):
        defs = "".join(f'<marker id="{self.p}-{k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" '
                       f'markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{c}"/></marker>'
                       for k, c in FILL.items())
        return (f'<svg class="loops {cls}" viewBox="0 0 {w} {h:.0f}" role="img" aria-label="{html.escape(label, quote=True)}">'
                f'<defs>{defs}</defs>' + "".join(self.parts) + "</svg>")


PRED = ("*MoE expert predictor", None, ["guesses the experts of upcoming layers"])
SCHED = ("*Global scheduler", None, ["demand reads first", "prefetch in 2 MiB slices", "cancels once routing is known"])
GPU = ("GPU (Blackwell)", "compute",
       ["native FP8, BF16 and MXFP4", "40 layers, top-6 of 384 experts each",
        "*runs ahead during read stalls", "*draft length set by confidence and cost",
        "*certified output-head screening", "*expert kernels launch as each matrix lands"])
MEM = [(9, "blue", None), (103, "teal", None), (9, "muted", None)]
SSD = [(189.1, "muted", None), (268.9, "teal", None), (6.7, "violet", None), (9.9, "blue", None)]
LABEL = ("STBLarge on a DGX Spark: the GPU sends routing to the CPU's expert predictor; the global scheduler "
         "times GPU kernels, places experts in cache slots and issues, orders and cancels SSD reads; "
         "stars mark the engine's own techniques")


def board(W, narrow):
    f = Fig("sb" + ("n" if narrow else "w"))
    L = 20                      # left edge of the bars; the dashed read line runs left of it
    BW = W - L - 8
    # GB10 frame: a CPU container (predictor above scheduler) and the GPU, with control lines between them
    sx, sw = (14, W - 18) if narrow else (140, 520)
    gap = 58 if narrow else 64
    cpw = (sw - 24 - gap) * 0.5
    cx0 = sx + 12
    gx = cx0 + cpw + gap
    gw = sx + sw - 12 - gx
    tmp = Fig("x")
    iw = cpw - 20
    ph, shh = tmp.block(0, 0, iw, *PRED, "violet"), tmp.block(0, 0, iw, *SCHED, "violet")
    top = 34
    role = wrap("prediction and scheduling", cpw - 18, "d-dim")
    py = top + 9 + 15 + 15 * len(role) + 4
    sy = py + ph + 22
    cph = sy + shh + 10 - top
    gh = max(cph, tmp.block(0, 0, gw, *GPU, "blue"))
    cph = gh
    f.rect(sx, 8, sw, gh + 40, "muted", fill="none")
    f.text(sx + 12, 26, "NVIDIA GB10 Grace Blackwell", "d-head")
    f.rect(cx0, top, cpw, cph, "violet")
    f.text(cx0 + 9, top + 21, "CPU, 20 Arm cores", "d-title")
    for i, r in enumerate(role):
        f.text(cx0 + 9, top + 36 + 15 * i, r, "d-dim")
    f.block(cx0 + 10, py, iw, *PRED, "violet")
    f.block(cx0 + 10, sy, iw, *SCHED, "violet")
    f.block(gx, top, gw, *GPU, "blue", min_h=gh)
    pmid, smid = py + ph / 2, sy + shh / 2
    f.line(f"M{cx0 + 10 + iw / 2:.1f},{py + ph + 1:.1f} V{sy - 2:.1f}", "violet")
    mid = (cx0 + 10 + iw + gx) / 2
    f.line(f"M{gx - 1:.1f},{pmid:.1f} H{cx0 + 10 + iw + 2:.1f}", "blue")
    f.text(mid, pmid - 6, "routing", "d-note", "middle")
    f.line(f"M{cx0 + 10 + iw + 1:.1f},{smid:.1f} H{gx - 2:.1f}", "violet")
    f.text(mid, smid - 18, "kernel", "d-note", "middle")
    f.text(mid, smid - 6, "timing", "d-note", "middle")
    ch = gh
    y = 8 + ch + 40
    frame_bot = y
    # unified memory (on phones the title goes under the bar, out of the way of the control lines)
    if narrow:
        y += 18
    else:
        y += 26
        f.text(L, y, "Unified LPDDR5X, 128 GB (121 GiB usable)", "d-title")
        f.text(W - 8, y, "shared by CPU and GPU", "d-dim", "end")
        y += 8
    mspans = f.bar(L, y, BW, 40, [(s, c, None) for s, c, _ in MEM], 121)
    (fx, fw), (cx_, cw_), (kx, kw) = mspans
    f.text(cx_ + cw_ / 2, y + 17, "expert cache, 103 GiB", "d-title", "middle")
    f.text(cx_ + cw_ / 2 + 5, y + 32, "~5,900 slots; decayed-frequency eviction", "d-note", "middle")
    f.star(cx_ + cw_ / 2 - 108, y + 32)
    f.text(fx + fw / 2, y + 25, "9", "d-note", "middle")
    f.text(kx + kw / 2, y + 25, "9", "d-note", "middle")
    mem_top, mem_bot = y, y + 40
    y += 40 + 15
    if narrow:
        f.text(L, y, "Unified LPDDR5X, 128 GB (121 GiB usable)", "d-title")
        y += 15
        f.text(L, y, "fixed weights 9 · KV and headroom 9 GiB", "d-note")
        y += 15
    else:
        f.text(L, y, "fixed weights 9 GiB", "d-note")
        f.text(W - 8, y, "KV cache and headroom 9 GiB", "d-note", "end")
    # GPU reads its weights from memory
    ax = gx + gw / 2
    f.line(f"M{ax:.1f},{mem_top - 2:.1f} V{top + ch + 2:.1f}", "teal")
    f.text(ax + 6, frame_bot + 14, "273 GB/s", "d-note")
    # scheduler places experts in cache slots and evicts
    sched_l, sched_r = cx0 + 10, cx0 + 10 + iw
    lx = sched_l + iw * 0.8
    f.line(f"M{lx:.1f},{sy + shh + 1:.1f} V{mem_top - 2:.1f}", "violet")
    f.text(lx + 6, frame_bot + 14, "slots, eviction", "d-note")
    # SSD
    y += 30
    f.text(L, y, "NVMe SSD, 4 TB", "d-title")
    if narrow:
        y += 15
        f.text(L, y, "official safetensors, read in place, ~475 GiB", "d-dim")
    else:
        f.text(W - 8, y, "official safetensors, read in place, ~475 GiB", "d-dim", "end")
    y += 8
    sspans = f.bar(L, y, BW, 40, [(s, c, None) for s, c, _ in SSD], 474.6)
    (ex, ew), (px, pw), (dx, dw), (qx, qw) = sspans
    for i in range(1, 40):
        xx = px + pw * i / 40
        f.parts.append(f'<path d="M{xx:.1f},{y + 1:.1f} V{y + 7:.1f}" stroke="var(--fig-teal)" stroke-width="0.8"/>')
    f.text(ex + ew / 2, y + 17, "Engram table" if narrow else "Engram table, 189 GiB", "d-title", "middle")
    f.text(ex + ew / 2, y + 32, "189 GiB, on disk" if narrow else "on disk; one batched read per token", "d-note", "middle")
    f.text(px + pw / 2, y + 17, "experts, 269 GiB", "d-title", "middle")
    f.text(px + pw / 2, y + 32, "40 layers × 384", "d-note", "middle")
    ssd_top = y
    y += 40 + 15
    f.text(W - 8, y, "draft head 6.7 GiB · fixed weights 9.9 GiB", "d-note", "end")
    # SSD → expert cache
    bx = px + pw * (0.82 if narrow else 0.3)
    f.line(f"M{bx:.1f},{ssd_top - 2:.1f} V{mem_bot + 2:.1f}", "teal")
    if narrow:
        f.text(bx - 6, ssd_top - 38, "io_uring, 12.3 GB/s", "d-note", "end")
    else:
        f.text(bx + 6, mem_bot + 30, "io_uring, 12.3 GB/s", "d-note")
    # scheduler → SSD: what to read, when, and what to cancel
    ry = smid + 12
    f.line(f"M{sched_l - 1:.1f},{ry:.1f} H6 V{ssd_top + 20:.1f} H{L - 2}", "violet", dashed=True)
    if not narrow:
        f.text((6 + sx) / 2 + 2, ry - 18, "reads: what,", "d-note", "middle")
        f.text((6 + sx) / 2 + 2, ry - 6, "when, cancel", "d-note", "middle")
    y += 8
    return f.render(W, y, LABEL, "loops-narrow" if narrow else "loops-wide")


if __name__ == "__main__":
    out = sys.argv[1]
    open(f"{out}/stbl-board-wide.svg", "w").write(board(800, False))
    open(f"{out}/stbl-board-narrow.svg", "w").write(board(NARROW_W, True))
