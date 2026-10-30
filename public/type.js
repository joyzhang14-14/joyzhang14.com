// Types out every paragraph in <main> (except headings and diagrams) at the same time,
// each behind its own block cursor.
// Untyped text stays in place (transparent) so the layout never jumps.
// Click or press any key to show everything at once.
(() => {
  const main = document.querySelector("main");
  if (!main || matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const nodes = [];
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode()); ) {
    if (n.data.trim() && !n.parentElement.closest("h1, h2, h3, svg")) nodes.push(n);
  }
  if (!nodes.length) return;

  // One line per paragraph (block element); its text nodes are typed in order.
  const lines = [];
  let line = null;
  let block = null;
  nodes.forEach((node) => {
    const b = node.parentElement.closest("p, li, figcaption") || node.parentElement;
    if (b !== block) {
      block = b;
      line = { parts: [], i: 0, j: 0, cursor: null };
      lines.push(line);
    }
    node.parentElement.closest("a")?.classList.add("untyped");
    const text = node.data.replace(/\s+/g, " ");
    const rest = document.createElement("span");
    rest.className = "pending";
    rest.textContent = text;
    node.data = "";
    node.after(rest);
    line.parts.push({ node, rest, text });
  });

  const CHARS_PER_TICK = 1;
  let timer;

  const reveal = (line, p) => {
    if (!line.cursor) {
      line.cursor = document.createElement("span");
      line.cursor.className = "cursor";
      line.cursor.setAttribute("aria-hidden", "true");
    }
    p.node.after(line.cursor);
    p.node.parentElement.closest("a")?.classList.remove("untyped");
  };

  // Advance one line by up to n characters; returns true when it is finished.
  const advance = (line, n) => {
    for (let k = 0; k < n && line.i < line.parts.length; k++) {
      const p = line.parts[line.i];
      if (line.j === 0) reveal(line, p);
      line.j++;
      p.node.data = p.text.slice(0, line.j);
      p.rest.textContent = p.text.slice(line.j);
      if (line.j >= p.text.length) {
        p.rest.remove();
        line.i++;
        line.j = 0;
      }
    }
    return line.i >= line.parts.length;
  };

  const all = lines;
  const last = all[all.length - 1];

  const done = () => {
    all.forEach((line) => line !== last && line.cursor?.remove());
    last.cursor.classList.add("blink");
    removeEventListener("click", finish);
    removeEventListener("keydown", onKey);
  };

  function finish() {
    clearTimeout(timer);
    all.forEach((line) => advance(line, Infinity));
    done();
  }

  const step = () => {
    let busy = false;
    all.forEach((line) => {
      if (advance(line, CHARS_PER_TICK)) {
        if (line !== last) line.cursor?.remove();
      } else busy = true;
    });
    if (busy) timer = setTimeout(step, 16);
    else done();
  };

  addEventListener("click", finish);
  // Modifier keys (e.g. Cmd+Shift for screenshots) don't skip the animation.
  function onKey(e) {
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key !== "Shift") finish();
  }
  addEventListener("keydown", onKey);
  timer = setTimeout(step, 250);
})();
