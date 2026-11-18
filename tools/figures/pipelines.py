"""Static, paper-style pipeline figures for the project pages (wide and phone layouts).

Usage: python3 tools/figures/pipelines.py OUT_DIR
Writes <name>-wide.svg and <name>-narrow.svg for every figure in FIGURES.
Colors come from the site's CSS tokens (--fig-*), so the figures follow light and dark mode.
"""
import html
import sys

COLORS = {"blue": "var(--fig-blue)", "violet": "var(--fig-violet)", "teal": "var(--fig-teal)",
          "red": "var(--fig-red)", "muted": "var(--muted)"}
# rough advance widths (px per char) for wrapping
CH = {"d-note": 5.8, "d-title": 6.8, "d-code": 6.3, "d-dim": 5.8, "d-req": 5.9}
LINE = {"d-note": 14, "d-title": 15, "d-code": 14, "d-dim": 15}
PAD = 9
# phone figures are drawn narrower than the screen so their text renders larger
NARROW_W = 350


def wrap(s, width, cls):
    words, rows, cur = s.split(" "), [], ""
    for w in words:
        t = w if not cur else cur + " " + w
        if len(t) * CH[cls] <= width or not cur:
            cur = t
        else:
            rows.append(cur)
            cur = w
    rows.append(cur)
    return rows


def layout_box(b, w):
    """Wrapped (cls, text) rows and the height of one box at width w."""
    rows = [("d-title", r, False) for r in wrap(b["title"], w - 2 * PAD, "d-title")]
    for item in b.get("lines", []):
        cls, s = item if isinstance(item, tuple) else ("d-note", item)
        parts = wrap(s, w - 2 * PAD - (8 if cls == "d-note" else 0), cls)
        rows += [(cls, r, i == 0 and cls == "d-note") for i, r in enumerate(parts)]
    h = PAD + 4 + sum(LINE[c] for c, _, _ in rows) + PAD - 2
    return rows, h


class Svg:
    def __init__(self, prefix):
        self.p, self.parts = prefix, []

    def box(self, x, y, w, h, b, rows):
        dash = ' stroke-dasharray="4 3"' if b.get("dashed") else ""
        self.parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="4" '
                          f'fill="var(--paper)" stroke="{COLORS[b.get("color", "blue")]}" stroke-width="1.4"{dash}/>')
        ty = y + PAD + 2
        for cls, s, dot in rows:
            ty += LINE[cls]
            indent = 8 if cls == "d-note" else 0
            if dot:
                self.parts.append(f'<circle cx="{x + PAD + 2:.1f}" cy="{ty - 4:.1f}" r="1.3" class="d-dot"/>')
            self.parts.append(f'<text x="{x + PAD + indent:.1f}" y="{ty - 3:.1f}" class="{cls}">'
                              f'{html.escape(s)}</text>')

    def line(self, d, arrow=True):
        end = f' marker-end="url(#{self.p}-a)"' if arrow else ""
        self.parts.append(f'<path d="{d}" fill="none" stroke="var(--muted)" stroke-width="1.3"{end}/>')

    def render(self, w, h, label, cls):
        marker = (f'<marker id="{self.p}-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" '
                  f'markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" '
                  f'fill="var(--muted)"/></marker>')
        return (f'<svg class="loops {cls}" viewBox="0 0 {w} {h:.0f}" role="img" '
                f'aria-label="{html.escape(label, quote=True)}"><defs>{marker}</defs>' + "".join(self.parts) + "</svg>")


def wide(name, rows_of_stages, label):
    W, M, GAP, RGAP = 800, 4, 30, 36
    n = max(len(r) for r in rows_of_stages)
    # a later row that opens with parallel boxes needs a gutter for the bus that feeds them
    G = 16 if any(len(r[0]) > 1 for r in rows_of_stages[1:]) else 0
    cw = (W - 2 * M - G - GAP * (n - 1)) / n
    s = Svg(name + "w")
    y0 = M
    prev = None  # (bottom-center x, bottom y) of the last stage in the previous row
    for stages in rows_of_stages:
        cols = []
        for st in stages:
            laid = [layout_box(b, cw) for b in st]
            cols.append((st, laid, sum(h for _, h in laid) + 10 * (len(st) - 1)))
        rh = max(c[2] for c in cols)
        mid = y0 + rh / 2
        mids = []
        for i, (st, laid, ch) in enumerate(cols):
            x, y = M + G + i * (cw + GAP), mid - ch / 2
            ys, last = [], None
            for b, (rows, h) in zip(st, laid):
                s.box(x, y, cw, h, b, rows)
                ys.append(y + h / 2)
                last = (x + cw / 2, y, y + h)
                y += h + 10
            mids.append((x, ys, last))
        if prev:
            fx, ftop = mids[0][2][0], mid - cols[0][2] / 2
            gy = prev[1] + (ftop - prev[1]) / 2
            ys = mids[0][1]
            if len(ys) > 1:  # parallel first stage: feed every box through a bus on its left
                bx = M + 2
                s.line(f"M{prev[0]:.1f},{prev[1]:.1f} V{gy:.1f} H{bx:.1f} V{ys[-1]:.1f}", arrow=False)
                for yy in ys:
                    s.line(f"M{bx:.1f},{yy:.1f} H{M + G - 2:.1f}")
            else:
                s.line(f"M{prev[0]:.1f},{prev[1]:.1f} V{gy:.1f} H{fx:.1f} V{ftop - 2:.1f}")
        for i in range(len(cols) - 1):
            (x0, ys0, _), (x1, ys1, _) = mids[i], mids[i + 1]
            out_x, in_x = x0 + cw, x1
            if len(ys0) > 1:
                bx = out_x + 8
                for yy in ys0:
                    s.line(f"M{out_x:.1f},{yy:.1f} H{bx:.1f}", arrow=False)
                s.line(f"M{bx:.1f},{ys0[0]:.1f} V{ys0[-1]:.1f}", arrow=False)
                out_x = bx
            if len(ys1) > 1:
                bx = in_x - 8
                s.line(f"M{bx:.1f},{ys1[0]:.1f} V{ys1[-1]:.1f}", arrow=False)
                for yy in ys1:
                    s.line(f"M{bx:.1f},{yy:.1f} H{in_x - 2:.1f}")
                s.line(f"M{out_x:.1f},{mid:.1f} H{bx:.1f}", arrow=False)
            else:
                s.line(f"M{out_x:.1f},{mid:.1f} H{in_x - 2:.1f}")
        lx, _, lbot = mids[-1][2]
        prev = (lx, mid + cols[-1][2] / 2)
        y0 += rh + RGAP
    return s.render(W, y0 - RGAP + M, label, "loops-wide")


def narrow(name, rows_of_stages, label):
    stages = [st for row in rows_of_stages for st in row]
    W, M, GAP = NARROW_W, 4, 26
    s = Svg(name + "n")
    y = M
    rows_mid = []
    for st in stages:
        k = len(st)
        bw = (W - 2 * M - 10 * (k - 1)) / k
        laid = [layout_box(b, bw) for b in st]
        rh = max(h for _, h in laid)
        xs = []
        for j, (b, (rows, h)) in enumerate(zip(st, laid)):
            x = M + j * (bw + 10)
            s.box(x, y, bw, rh, b, rows)
            xs.append(x + bw / 2)
        rows_mid.append((y, rh, xs))
        y += rh + GAP
    cx = W / 2
    for i in range(len(rows_mid) - 1):
        (y0, h0, xs0), (y1, _, xs1) = rows_mid[i], rows_mid[i + 1]
        out_y, in_y = y0 + h0, y1
        if len(xs0) > 1:
            by = out_y + 8
            for xx in xs0:
                s.line(f"M{xx:.1f},{out_y:.1f} V{by:.1f}", arrow=False)
            s.line(f"M{xs0[0]:.1f},{by:.1f} H{xs0[-1]:.1f}", arrow=False)
            out_y = by
        if len(xs1) > 1:
            by = in_y - 8
            s.line(f"M{xs1[0]:.1f},{by:.1f} H{xs1[-1]:.1f}", arrow=False)
            for xx in xs1:
                s.line(f"M{xx:.1f},{by:.1f} V{in_y - 2:.1f}")
            s.line(f"M{cx:.1f},{out_y:.1f} V{by:.1f}", arrow=False)
        else:
            s.line(f"M{cx:.1f},{out_y:.1f} V{in_y - 2:.1f}")
    return s.render(W, y - GAP + M, label, "loops-narrow")


def B(title, *lines, color="blue", dashed=False, status=None):
    lines = list(lines) + ([("d-dim", status)] if status else [])
    return {"title": title, "lines": lines, "color": color, "dashed": dashed}


FIGURES = {
    "mp-capture": ("My Portrait screen capture: triggers, privacy gates, deduplication, OCR and storage", [
        [B("Triggers", "app switch, click, Return, typing burst, scroll stop, clipboard change, 30 s idle tick",
           "200 ms debounce; waits for the screen to settle")],
        [B("Privacy gates", "password fields, private windows and DRM content are skipped", color="red")],
        [B("Deduplication", "4× downscale to grayscale", "FNV-1a hash, then histogram distance (Hellinger < 0.02)",
           "one frame kept every 10 s regardless")],
        [B("OCR", "Apple Vision, accurate mode", "Chinese and English, word-level boxes",
           "can wait for idle or charging time")],
        [B("Storage", "JPEG first, HEVC chunks after 10 min", color="teal")],
    ]),
    "mp-listen": ("My Portrait audio: capture, voice activity detection, transcription, diarization and speaker matching", [
        [B("Microphone", "AVAudioEngine"), B("System audio", "ScreenCaptureKit")],
        [B("Voice activity", "16 kHz mono", "Silero VAD v5, segments up to 60 s", "noise and music filtering on vDSP")],
        [B("Transcription", "Whisper large-v3 or Qwen3-ASR on MLX", "batched while idle or charging",
           "mic and system duplicates merged")],
        [B("Diarization", "pyannote segmentation", "Kaldi-style fbank", "CAM++ speaker embeddings")],
        [B("Speaker match", "cosine ≥ 0.45 to a voiceprint", "0.10 margin over the next speaker",
           "a 30 s recording enrolls a voice", color="violet")],
    ]),
    "mp-overview": ("My Portrait pipeline: capture and EventSession are shipped, Event Merge v1 is in training, the portrait pipeline is in testing, and the proactive agent is the goal", [
        [B("Capture", "screenshots with Vision OCR", "audio: VAD, transcription, speaker ID", "keyboard input",
           color="teal", status="shipped")],
        [B("EventSession", "Qwen3.5-9B vision-language model, QAD 4-bit, about 6 GB",
           "writes up each app session from its frames and keys", color="violet", status="shipped")],
        [B("Event Merge", "EmbeddingGemma retrieval; the 9B model answers narrow questions",
           "same-day events, then a cross-day library", dashed=True, status="v1 in training")],
        [B("Portrait", "six sections plus Pattern", "every entry cites its events", dashed=True,
           status="pipeline in testing"),
         B("Neural Graph", "events as a force-directed graph", color="teal", status="shipped")],
        [B("Proactive agent", "acts for me from what it knows about me", color="muted", dashed=True,
           status="goal")],
    ]),
    "mp-eventsession": ("EventSession: a session's frames and keys go to an on-device vision-language model that writes up the session", [
        [B("App session", "frames and keystrokes from one app and window")],
        [B("Qwen3.5-9B VLM", "LoRA-distilled from a larger teacher", "QAD to 4-bit MLX, about 6 GB",
           "runs while plugged in or idle", color="violet")],
        [B("Write-up", "what I did in the session, in plain text", color="teal")],
    ]),
    "mp-merge": ("Event Merge v1: session write-ups are retrieved with embeddings, joined into events through narrow questions, narrated, and fused into a cross-day library", [
        [B("Session write-ups", "from EventSession")],
        [B("Recall", "EmbeddingGemma 2, 768-d, on MLX", "top 4 events by vector, plus the latest one")],
        [B("Narrow questions", "did this session do anything?", "does it join this event?",
           "are these two events the same?", color="violet")],
        [B("Narrative", "summaries of every 10 sessions, then an overview")],
        [B("Cross-day library", "continues a library event? (top 5 by vector, tags and the last 48 h)",
           "rewrites the entry's title and overview", color="teal")],
    ]),
    "mp-portrait": ("Portrait pipeline: events are recalled per entry, checked through narrow questions, written and reviewed into portrait entries", [
        [B("Events", "from the event library")],
        [B("Recall", "vectors, BM25 over evidence, title overlap", "94% recall at about 14 candidates")],
        [B("Narrow questions", "any material for this section?", "attach to this entry?", color="violet")],
        [B("Write", "create, deduplicate, rewrite", "a review agent checks each change")],
        [B("Portrait", "entries with a title, a detail paragraph and evidence event ids", color="teal")],
    ]),
    "mp-graph": ("My Portrait graph engine: scene, physics thread with a shadow engine, snapshot and SwiftUI Canvas renderer", [
        [B("Scene", "me at the center, folders as hubs, events as leaves", "radius from event weight")],
        [B("Physics thread, 60 Hz", "Barnes-Hut repulsion (θ² = 0.81)", "springs, collision, bubble constraints",
           "parks once the layout settles"),
         B("Shadow engine", "runs ahead in the background to predict the final layout", dashed=True)],
        [B("Snapshot", "lock-protected handoff to the renderer")],
        [B("SwiftUI Canvas", "pre-rasterized labels", "off-screen culling", "hash-grid hit tests", color="teal")],
    ]),
    "stb-injection": ("Sparky-toolbox prompt-injection defense: untrusted content is read by an isolated subagent whose answers are checked before the main agent sees them", [
        [B("Untrusted content", "mail, attachments, web pages, course sites", color="red")],
        [B("Isolated subagent", "own sandbox, model and tools",
           "answers only the questions it was asked, each with a quote and its source", color="violet")],
        [B("Platform checks", "question copied from the main agent's prompt", "quote found word for word in the source",
           "numbers appear in the quote", "suspicious answers flagged")],
        [B("Main agent", "receives the checked answers, not the raw text")],
    ]),
    "stb-oneoff": ("Sparky-toolbox one-off tasks: a long request becomes an approved background task in the priority queue", [
        [B("My message", "a long request")],
        [B("Chat agent", "judges that it will take long")],
        [B("Builder", "drafts a one-off task with its own prompt, tools and priority")],
        [B("Approval card", "one per proposal", color="red")],
        [B("Priority queue", "one large model at a time", "my messages preempt at the next tool call",
           "preempted tasks resume from a checkpoint", color="teal")],
        [B("Background task", "sends me the result when done")],
    ]),
    "stbl-engine": ("STBLarge: a predictor and a scheduler stream routed experts from the SSD into an expert cache ahead of the GPU", [
        [B("Predictor", "runs the next layer's router early",
           "looks further ahead while the GPU waits on a read", color="violet")],
        [B("Global scheduler", "coordinates SSD reads, the cache and GPU work", "reads needed now go first",
           "guesses read in 2 MiB slices, cancelled once the real routing is known")],
        [B("SSD", "routed experts of the 476 GB model", "io_uring, about 12 GB/s", color="teal")],
        [B("Expert cache", "unified memory", "evicts by decayed use frequency")],
        [B("GPU", "native FP8, BF16 and MXFP4 kernels", "each expert starts as soon as it lands",
           "speculative decoding with the draft head")],
    ]),
}

# how many stages each row of the wide layout holds
ROWS = {"mp-capture": [3, 2], "mp-listen": [3, 2], "mp-overview": [3, 2], "mp-eventsession": [3],
        "mp-merge": [3, 2], "mp-portrait": [3, 2], "mp-graph": [4],
        "stb-injection": [4], "stb-oneoff": [3, 3], "stbl-engine": [3, 2]}

if __name__ == "__main__":
    out = sys.argv[1]
    for name, (label, stages) in FIGURES.items():
        rows, i = [], 0
        for k in ROWS[name]:
            rows.append(stages[i:i + k])
            i += k
        open(f"{out}/{name}-wide.svg", "w").write(wide(name, rows, label))
        open(f"{out}/{name}-narrow.svg", "w").write(narrow(name, rows, label))
