"""Static, paper-style Sparky-toolbox figures (wide and phone layouts).

Usage: python3 gen_paper_figs.py OUT_DIR  ->  fig1-wide.svg fig1-narrow.svg fig2-wide.svg fig2-narrow.svg
Colors come from CSS tokens (--fig-*) so the figures follow the site's light/dark theme.
"""
import html
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from pipelines import wrap, CH, NARROW_W  # noqa: E402

BLUE, VIOLET, TEAL, RED, MUTED = ("var(--fig-blue)", "var(--fig-violet)", "var(--fig-teal)",
                                   "var(--fig-red)", "var(--muted)")
COLORS = {"blue": BLUE, "violet": VIOLET, "teal": TEAL, "red": RED, "muted": MUTED}


class Fig:
    def __init__(self, prefix):
        self.p, self.parts = prefix, []

    def esc(self, s):
        return html.escape(s, quote=True)

    def text(self, x, y, s, cls="d-note", anchor="start"):
        self.parts.append(f'<text x="{x}" y="{y}" text-anchor="{anchor}" class="{cls}">{self.esc(s)}</text>')

    def box(self, x, y, w, h, color, dashed=False, fill="var(--paper)"):
        dash = ' stroke-dasharray="4 3"' if dashed else ""
        self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="4" fill="{fill}" '
                          f'stroke="{COLORS[color]}" stroke-width="1.4"{dash}/>')

    def num(self, x, y, n, color):
        self.parts.append(f'<circle cx="{x}" cy="{y}" r="8" fill="{COLORS[color]}"/>')
        self.parts.append(f'<text x="{x}" y="{y + 3.5}" text-anchor="middle" class="d-badge">{n}</text>')

    def arrow(self, d, color, dashed=False):
        dash = ' stroke-dasharray="4 3"' if dashed else ""
        self.parts.append(f'<path d="{d}" fill="none" stroke="{COLORS[color]}" stroke-width="1.4"{dash} '
                          f'marker-end="url(#{self.p}-{color})"/>')

    def svg(self, w, h, label, cls):
        defs = "".join(
            f'<marker id="{self.p}-{k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" '
            f'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{c}"/></marker>'
            for k, c in COLORS.items())
        return (f'<svg class="loops {cls}" viewBox="0 0 {w} {h}" role="img" aria-label="{self.esc(label)}">'
                f'<defs>{defs}</defs>' + "".join(self.parts) + "</svg>")


# ---------- Figure 1: one agent run (a) and a workflow task (b) ----------

def agent_panel(f, x0, y0, w):
    """Panel (a). Text wraps to the panel width. Returns the bottom y."""
    f.text(x0, y0 + 12, "(a) Agent task: one run, traced", "d-head")
    bx, bw = x0 + 30, w - 30           # step column; the call rail runs on its left
    req = ['"Add the lab meeting to my calendar, and turn the paper', 'my professor sent into a one-page PDF."']
    if any(len(line) * CH["d-req"] > bw - 24 for line in req):
        req = wrap(" ".join(req), bw - 24, "d-req")
    rh = 12 + 16 * len(req)
    f.box(bx, y0 + 26, bw, rh, "muted")
    for i, line in enumerate(req):
        f.text(bx + 12, y0 + 44 + 16 * i, line, "d-req")
    y = y0 + 26 + rh
    tw = bw - 42                        # text width inside a step box

    def rows_of(items, width):
        return [(cls, line) for cls, s in items for line in wrap(s, width, cls)]

    steps = [
        (1, "blue", "Built-in function", [("d-code", 'grep "lab meeting" notes.md'),
                                          ("d-note", "→ Thursday 3 pm")]),
        (2, "blue", "Load a tool", [("d-code", 'load_tool("calendar")'),
                                    ("d-code", 'calendar.add("Lab meeting", Thu 15:00)')]),
        (3, "violet", "Call an isolated subagent", None),
        (4, "blue", "Load a skill", [("d-code", 'load_skill("pdf")'),
                                     ("d-code", "python make_pdf.py summary.md")]),
        (5, "blue", "Answer", [("d-note", "meeting added · summary.pdf saved")]),
    ]
    tops = []
    for n, color, title, items in steps:
        f.arrow(f"M{bx + bw / 2},{y} V{y + 16}", "muted")
        y += 18
        if items is None:
            call = rows_of([("d-code", 'reader: "summarize the paper in today\'s email"')], tw)
            ix, iw = bx + 30, bw - 46
            inner = rows_of([("d-note", "own model, prompt and tools; reads the mail and PDF"),
                             ("d-note", "returns only answers, each with a quote and its source")], iw - 20)
            ih = 30 + 16 * len(inner)
            h = 40 + 17 * (len(call) - 1) + 12 + ih + 36
        else:
            rows = rows_of(items, tw)
            h = 32 + 17 * len(rows)
        f.box(bx, y, bw, h, color)
        f.num(bx + 16, y + 16, n, color)
        f.text(bx + 30, y + 20, title, "d-title")
        if items is None:
            for i, (cls, line) in enumerate(call):
                f.text(bx + 30, y + 40 + 17 * i, line, cls)
            iy = y + 40 + 17 * (len(call) - 1) + 12
            f.box(ix, iy, iw, ih, "violet", dashed=True)
            f.text(ix + 10, iy + 18, "Isolated reader", "d-title")
            for i, (cls, line) in enumerate(inner):
                f.text(ix + 10, iy + 35 + 16 * i, line, cls)
            f.text(bx + 30, iy + ih + 20, "→ answers whose quotes match the source", "d-note")
        else:
            for i, (cls, line) in enumerate(rows):
                f.text(bx + 30, y + 40 + 17 * i, line, cls)
        tops.append((y, h))
        y += h
    # the call rail: every tool call goes model → gateway → tool and back
    top, bot = tops[0][0], tops[-1][0] + tops[-1][1]
    rx = x0 + 10
    f.parts.append(f'<path d="M{bx},{top + 8} H{rx} V{bot - 8} H{bx}" fill="none" stroke="{BLUE}" stroke-width="1.4"/>')
    mid = (top + bot) / 2
    f.parts.append(f'<text x="{rx - 4}" y="{mid}" text-anchor="middle" class="d-note" '
                   f'transform="rotate(-90 {rx - 4} {mid})">every call: model → gateway (budgets · hooks · approvals) → tool</text>')
    return y


def workflow_panel(f, x0, y0, w):
    """Panel (b). Returns the bottom y."""
    f.text(x0, y0 + 12, "(b) Workflow task: fixed steps", "d-head")
    cx = x0 + (w - 30) / 2              # leave room on the right for the return arrow
    tw = (w - 30 - 16) / 3
    for i, name in enumerate(["Schedule", "Listener", "Manual"]):
        tx = x0 + i * (tw + 8)
        f.box(tx, y0 + 26, tw, 28, "teal")
        f.text(tx + tw / 2, y0 + 44, name, "d-title", "middle")
        f.arrow(f"M{tx + tw / 2},{y0 + 54} V{y0 + 76}", "teal")
    qy = y0 + 78
    f.box(x0, qy, w - 30, 30, "teal")
    f.text(cx, qy + 19, "Queue, ordered by priority", "d-title", "middle")
    y = qy + 30
    for i, (t, a, b) in enumerate([("Step 1", "fetch.py", "no GPU: runs at once"),
                                    ("Step 2", "summarize.py + model", "waits for its model"),
                                    ("Step 3", "notify.py", "sends the reply")]):
        f.arrow(f"M{cx},{y} V{y + 18}", "teal")
        y += 20
        f.box(x0, y, w - 30, 64, "teal")
        f.text(x0 + 12, y + 20, t, "d-title")
        f.text(x0 + 12, y + 38, a, "d-code")
        f.text(x0 + 12, y + 55, b, "d-note")
        y += 64
    rx = x0 + w - 12
    f.arrow(f"M{cx},{y} V{y + 16} H{rx} V{qy + 15} H{x0 + w - 30 + 4}", "teal", dashed=True)
    f.text(cx, y + 34, "then waits for the next trigger", "d-note", "middle")
    return y + 40


def fig1(layout):
    f = Fig("f1" + layout[0])
    if layout == "wide":
        b1 = agent_panel(f, 8, 0, 476)
        b2 = workflow_panel(f, 514, 0, 280)
        h = max(b1, b2) + 8
        w = 800
    else:
        w = NARROW_W
        b1 = agent_panel(f, 4, 0, w - 8)
        b2 = workflow_panel(f, 4, b1 + 30, w - 8)
        h = b2 + 8
    return f.svg(w, h, "Sparky-toolbox: (a) one agent run traced through a built-in function, a loaded tool, "
                 "an isolated subagent and a skill, with every call passing the gateway; (b) a workflow task "
                 "with its triggers, priority queue and fixed steps", f"loops-{layout}")


# ---------- Figure 2: how the builder extends the system ----------

def stage(f, x, y, w, h, n, color, title, note, dashed=False):
    f.box(x, y, w, h, color, dashed=dashed)
    if n:
        f.num(x + 16, y + 16, n, color)
    tx = x + (30 if n else 12)
    f.text(tx, y + 20, title, "d-title")
    for i, line in enumerate(note):
        f.text(tx, y + 38 + 16 * i, line, "d-note")


def fig2_wide():
    f = Fig("f2w")
    H = 56
    stage(f, 8, 8, 200, H, 1, "blue", "Needs an ability", ["a task needs a tool, task", "or subagent it lacks"])
    stage(f, 300, 8, 180, H, 2, "blue", "Plan", ["the builder drafts", "what to build"])
    stage(f, 572, 8, 220, H, 3, "red", "Approval", ["an approval card;", "nothing is built before a yes"])
    f.arrow(f"M208,{8 + H / 2} H296", "blue")
    f.arrow(f"M480,{8 + H / 2} H568", "blue")
    f.arrow(f"M682,{8 + H} V114", "red")
    # build loop
    f.box(120, 116, 672, 124, "muted", fill="none")
    f.text(132, 134, "Build loop, in an isolated dev area", "d-title")
    for i, (n, t, note) in enumerate([(4, "Develop", "write the change"),
                                      (5, "Test", "full suite vs. main"),
                                      (6, "Trial", "a real run, live setup")]):
        stage(f, 140 + i * 218, 146, 192, 52, n, "teal", t, [note])
        if i < 2:
            f.arrow(f"M{332 + i * 218},172 H{354 + i * 218}", "teal")
    f.arrow("M672,198 V216 H236 V202", "teal", dashed=True)
    f.text(454, 232, "fix and retry until every check passes", "d-dim", "middle")
    stage(f, 572, 272, 220, 52, 7, "blue", "Ship", ["merged and deployed"])
    stage(f, 300, 272, 180, 52, 0, "blue", "In the catalog", ["loadable from the next run"])
    f.arrow("M682,240 V268", "teal")
    f.arrow("M572,298 H484", "blue")
    f.arrow(f"M300,298 H64 V{8 + H + 4}", "blue", dashed=True)
    return f.svg(800, 332, "Sparky-toolbox self-extension: a missing ability goes to the builder, which plans it, "
                 "waits for approval, develops, tests and trials it until every check passes, and ships it "
                 "into the tool catalog", "loops-wide")


def fig2_narrow():
    f = Fig("f2n")
    x, w = 34, NARROW_W - 42
    cx = x + w / 2
    y = 8
    seq = [(1, "blue", "Needs an ability", ["a task needs a tool, task or subagent it lacks"]),
           (2, "blue", "Plan", ["the builder drafts what to build"]),
           (3, "red", "Approval", ["an approval card; nothing is built before a yes"])]
    for i, (n, c, t, note) in enumerate(seq):
        stage(f, x, y, w, 50, n, c, t, note)
        y += 50
        f.arrow(f"M{cx},{y} V{y + 20}", c)
        y += 22
    f.box(x, y, w, 236, "muted", fill="none")
    f.text(x + 12, y + 18, "Build loop, in an isolated dev area", "d-title")
    by = y + 30
    for i, (n, t, note) in enumerate([(4, "Develop", "write the change"),
                                      (5, "Test", "full suite vs. main"),
                                      (6, "Trial", "a real run, live setup")]):
        stage(f, x + 16, by, w - 48, 48, n, "teal", t, [note])
        by += 48
        if i < 2:
            f.arrow(f"M{cx - 16},{by} V{by + 14}", "teal")
            by += 16
    rx = x + w - 16
    f.arrow(f"M{x + w - 32},{by - 24} H{rx} V{y + 54} H{x + w - 28}", "teal", dashed=True)
    f.text(cx - 8, by + 18, "fix and retry until every check passes", "d-dim", "middle")
    y += 236
    f.arrow(f"M{cx},{y} V{y + 20}", "teal")
    y += 22
    stage(f, x, y, w, 50, 7, "blue", "Ship", ["merged and deployed"])
    y += 50
    f.arrow(f"M{cx},{y} V{y + 20}", "blue")
    y += 22
    stage(f, x, y, w, 50, 0, "blue", "In the catalog", ["loadable from the next run"])
    f.arrow(f"M{x},{y + 25} H16 V33 H{x - 4}", "blue", dashed=True)
    return f.svg(NARROW_W, y + 58, "Sparky-toolbox self-extension: a missing ability goes to the builder, which plans it, "
                 "waits for approval, develops, tests and trials it until every check passes, and ships it "
                 "into the tool catalog", "loops-narrow")


if __name__ == "__main__":
    out = sys.argv[1]
    for name, svg in [("fig1-wide", fig1("wide")), ("fig1-narrow", fig1("narrow")),
                      ("fig2-wide", fig2_wide()), ("fig2-narrow", fig2_narrow())]:
        open(f"{out}/{name}.svg", "w").write(svg)
