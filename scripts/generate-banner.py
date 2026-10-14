"""Generates docs/assets/banner-{dark,light}.svg (README banner, Graphite and Paper themes).

Text is outlined from the bundled Inter font so the SVG renders the same everywhere, without
fonts or scripts. One-off tool, not a project dependency:

    python3 -m venv /tmp/fonttools && /tmp/fonttools/bin/pip install fonttools brotli
    /tmp/fonttools/bin/python scripts/generate-banner.py
"""
import re
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

ROOT = Path(__file__).resolve().parent.parent
FONT = ROOT / 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'
OUT = ROOT / 'docs/assets'

def instance(wght):
    f = TTFont(str(FONT))
    return instantiateVariableFont(f, {'wght': wght})

def text_path(font, text, x, y, size, tracking=0.0):
    """SVG path data for `text`, baseline at y, laid out with advance widths only (no kerning)."""
    upm = font['head'].unitsPerEm
    s = size / upm
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    hmtx = font['hmtx']
    pen = SVGPathPen(gs)
    cx = x
    for ch in text:
        g = cmap[ord(ch)]
        tp = TransformPen(pen, (s, 0, 0, -s, cx, y))
        gs[g].draw(tp)
        cx += hmtx[g][0] * s + tracking * size
    d = re.sub(r'-?\d+\.\d+', lambda m: r(round(float(m.group()), 1)), pen.getCommands())
    return d, cx - x

def r(v): return f'{v:.1f}'.rstrip('0').rstrip('.')

THEMES = {
  'dark': dict(bg='#0f1115', panel='#14161b', border='#23262e', fg='#e6e8ee', fg2='#a3a9b6', muted='#8c919c',
               accent='#8b7cf6', lanes=['#8b7cf6', '#22d3ee', '#f59e0b', '#f472b6', '#34d399', '#60a5fa'], glow=0.22),
  'light': dict(bg='#f6f5f2', panel='#ffffff', border='#e6e4de', fg='#1f2328', fg2='#57606a', muted='#666d74',
                accent='#2563eb', lanes=['#2563eb', '#0891b2', '#d97706', '#db2777', '#16a34a', '#7c3aed'], glow=0.14),
}

W, H = 1280, 400

def curve(x0, y0, x1, y1):
    mx = (x0 + x1) / 2
    return f'M{r(x0)} {r(y0)}C{r(mx)} {r(y0)} {r(mx)} {r(y1)} {r(x1)} {r(y1)}'

# Lanes (y), all flowing left → right toward the present on the right edge.
Y = [208, 150, 266, 96, 318, 150]
END = W + 20
# (lane, path pieces as (kind, ...)), nodes as (lane, x, kind)
def graph(t):
    L = t['lanes']
    edges = []  # (color, d, width)
    def line(l, x0, x1, y=None):
        edges.append((L[l], f'M{r(x0)} {r(Y[l] if y is None else y)}H{r(x1)}'))
    def fork(l_from, l_to, x0, x1):
        edges.append((L[l_to], curve(x0, Y[l_from], x1, Y[l_to])))
    def merge(l_from, l_to, x0, x1):
        edges.append((L[l_from], curve(x0, Y[l_from], x1, Y[l_to])))
    line(0, 560, END)
    fork(0, 1, 620, 680); line(1, 680, 900); merge(1, 0, 900, 960)
    fork(1, 3, 730, 790); line(3, 790, 1040); merge(3, 0, 1040, 1100)
    fork(0, 2, 780, 840); line(2, 840, END)
    fork(2, 4, 1000, 1060); line(4, 1060, END)
    fork(0, 5, 1150, 1210); line(5, 1210, END)
    nodes = [  # (lane, x, kind) kind: c=commit, m=merge, h=head
        (0, 600, 'c'), (1, 720, 'c'), (1, 800, 'c'), (1, 870, 'c'), (0, 700, 'c'), (0, 960, 'm'),
        (3, 830, 'c'), (3, 930, 'c'), (3, 1010, 'c'), (0, 1100, 'm'), (2, 880, 'c'), (2, 960, 'c'),
        (2, 1040, 'c'), (2, 1150, 'c'), (4, 1100, 'c'), (4, 1180, 'c'), (0, 1040, 'c'), (5, 1245, 'c'),
        (0, 1240, 'h'),
    ]
    out = []
    for col, d in edges:
        out.append(f'<path d="{d}" stroke="{col}"/>')
    edge_svg = '\n    '.join(out)
    node_svg = []
    for l, x, k in nodes:
        col, y = L[l], Y[l]
        if k == 'c':
            node_svg.append(f'<circle cx="{x}" cy="{y}" r="7" fill="{t["bg"]}" stroke="{col}" stroke-width="3"/>')
        elif k == 'm':
            node_svg.append(f'<circle cx="{x}" cy="{y}" r="8" fill="{col}"/>')
        else:
            node_svg.append(f'<circle cx="{x}" cy="{y}" r="17" fill="{col}" opacity="{t["glow"]}"/>'
                            f'<circle cx="{x}" cy="{y}" r="9" fill="{col}"/>'
                            f'<circle cx="{x}" cy="{y}" r="3.5" fill="{t["bg"]}"/>')
    return edge_svg, '\n    '.join(node_svg)

bold, regular, medium = instance(700), instance(400), instance(500)

def build(name, t):
    title, _ = text_path(bold, 'yaggui', 236, 205, 92, tracking=-0.03)
    sub, _ = text_path(regular, 'yet another git graphical user interface', 240, 252, 23)
    tag, _ = text_path(medium, 'Fast, native and cross-platform. Built with Tauri and Rust.', 240, 290, 17)
    edges, nodes = graph(t)
    L = t['lanes']
    # App icon (src-tauri/icons/icon.svg) scaled into a 128 px tile.
    icon = (f'<g transform="translate(80 132) scale(0.140625)">'
            f'<rect x="64" y="64" width="896" height="896" rx="200" fill="#14161b"'
            f'{" stroke=\"#2f333d\" stroke-width=\"12\"" if name == "dark" else ""}/>'
            f'<g fill="none" stroke-linecap="round" stroke-width="56">'
            f'<path d="M400 800V224" stroke="#8b7cf6"/><path d="M400 640c0-140 224-120 224-260V300" stroke="#22d3ee"/></g>'
            f'<circle cx="400" cy="800" r="64" fill="#8b7cf6"/><circle cx="400" cy="224" r="64" fill="#8b7cf6"/>'
            f'<circle cx="624" cy="300" r="64" fill="#22d3ee"/></g>')
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="t d">
  <title id="t">yaggui</title>
  <desc id="d">yet another git graphical user interface</desc>
  <defs>
    <linearGradient id="fadeX" gradientUnits="userSpaceOnUse" x1="560" y1="0" x2="900" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#fff" stop-opacity="1"/>
    </linearGradient>
    <mask id="graphMask" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}">
      <rect width="{W}" height="{H}" fill="url(#fadeX)"/>
    </mask>
    <clipPath id="frame"><rect width="{W}" height="{H}" rx="24"/></clipPath>
  </defs>
  <g clip-path="url(#frame)">
    <rect width="{W}" height="{H}" fill="{t['bg']}"/>
    <g mask="url(#graphMask)">
    <g fill="none" stroke-width="3" stroke-linecap="round">
    {edges}
    </g>
    {nodes}
    </g>
  </g>
  <rect x="0.75" y="0.75" width="{W - 1.5}" height="{H - 1.5}" rx="23.25" fill="none" stroke="{t['border']}" stroke-width="1.5"/>
  {icon}
  <path d="{title}" fill="{t['fg']}"/>
  <path d="{sub}" fill="{t['fg2']}"/>
  <path d="{tag}" fill="{t['muted']}"/>
</svg>
'''
    svg = svg.replace('''''', '')
    open(f'{OUT}/banner-{name}.svg', 'w').write(svg)

for n, t in THEMES.items():
    build(n, t)
