#!/usr/bin/env python3
"""
Audit every rs_dashboard page against the dhan-page-theme standard.

Run from rs_dashboard/:   python3 ../.claude/skills/dhan-page-theme/scripts/audit_pages.py [--md] [--only FLAG]

For each route (app/**/page.tsx) it resolves the client component the page renders, finds that
component's sticky page header, and reports: tier, icon, accent, z-index and the deviations below.
Heuristic (regex, not a parser): treat a flagged row as "go look", not as proof. Read-only.

Flags
  NO_HEADER      component has no sticky <header> / title strip
  NO_NAVBAR      NavBar is not rendered anywhere in the component file
  Z_LOW / Z_HIGH header z-index <= 10 (loses to sticky table heads / chart overlays) or >= 40 (the
                 sidebar is fixed z-40; modals are z-50)
  TILE_WHITE     saturated gradient icon tile whose icon uses text-white (flips dark in light mode;
                 use text-oncolor)
  TEXT_500       header text uses a -500/-600 accent (only -200..-400 are themed, so it will not flip)
  NAVBAR_BARE    NavBar is the first child of the page root with no title header around it (a bare row of
                 buttons: no page title, icon or sticky header)
  NO_TILE        header has no icon tile
  NO_DATA_CHIP   file handles a data date but never renders `DATA:`
  NO_METADATA    page.tsx exports no metadata/generateMetadata (browser tab title falls to the default)
  DUP_ICON       the same lucide icon heads 3+ pages
"""
import glob, os, re, sys
from collections import Counter

NOT_ICONS = {"Link", "NavBar", "Tooltip", "TooltipTrigger", "TooltipContent", "HelpTooltip",
             "HelpTooltipTrigger", "HelpTooltipContent", "DayChangeChip", "Badge", "Image", "Fragment"}


def route_of(path):
    r = re.sub(r"\([^)]*\)/?", "", path[len("app/"):])
    r = "/" + re.sub(r"/?page\.tsx$", "", r)
    return r or "/"


CHROME = {"NavBar", "Sidebar", "ThemeToggle", "DataRefreshPanel", "UpdateAppPanel", "BrokerSelector"}


def components_of(page_src):
    """Default-imported components under @/components, in import order, minus shared chrome."""
    out = []
    for name, path in re.findall(r"import\s+(\w+)\s+from\s+'@/components/([\w/-]+)'", page_src):
        if name not in CHROME and path.split("/")[-1] not in CHROME:
            out.append(path)
    return out


def header_block(src):
    lines = src.split("\n")
    for i, l in enumerate(lines):
        if ("<header" in l or "sticky top-0" in l) and "<th" not in l and "thead" not in l and "TH" not in l.split("className")[0]:
            if re.search(r"z-\d+|backdrop|border-b", "\n".join(lines[i:i + 2])):
                return "\n".join(lines[i:i + 60]), lines[i]
    return None, None


def audit():
    rows, icons = [], Counter()
    for page in sorted(glob.glob("app/**/page.tsx", recursive=True)):
        if "/api/" in page or page == "app/login/page.tsx":
            continue
        psrc = open(page).read()
        route = route_of(page)
        comp_paths = components_of(psrc)
        row = dict(route=route, comp="-", tier="-", icon="-", accent="-", z="-", flags=[])
        if not re.search(r"\bmetadata\b|generateMetadata", psrc):
            row["flags"].append("NO_METADATA")
        chosen = None
        blk, first = header_block(psrc)              # fat pages keep the UI (and header) inline
        if blk:
            chosen = ("(inline page.tsx)", psrc, blk, first)
        for cp in ([] if chosen else comp_paths):
            f = f"components/{cp}.tsx"
            if not os.path.exists(f):
                continue
            src = open(f).read()
            blk, first = header_block(src)
            if blk:
                chosen = (cp, src, blk, first)
                break
            chosen = chosen or (cp, src, None, None)
        bare = re.compile(r'<div className="[^"]*min-h-screen[^"]*">\s*<NavBar />')
        if not chosen or not chosen[2]:              # no titled header found: is NavBar floating bare?
            srcs = [psrc] + [open(f"components/{c}.tsx").read() for c in comp_paths if os.path.exists(f"components/{c}.tsx")]
            if any(bare.search(t) for t in srcs):
                row["flags"].append("NAVBAR_BARE")
        if not chosen:
            row["flags"].append("NO_HEADER"); rows.append(row); continue
        cp, src, blk, first = chosen
        row["comp"] = cp if cp.startswith("(") else cp.split("/")[-1]
        if not blk:
            row["flags"].append("NO_HEADER"); rows.append(row); continue
        z = re.search(r"\bz-(\d+)\b", first + blk[:400])
        row["z"] = z.group(1) if z else "?"
        if z and int(z.group(1)) <= 10: row["flags"].append("Z_LOW")
        if z and int(z.group(1)) >= 40: row["flags"].append("Z_HIGH")
        if "NavBar" not in src: row["flags"].append("NO_NAVBAR")
        tile = re.search(r"(?:h|w)-(\d+) (?:w|h)-\d+[^\"]*rounded-[\w]+[^\"]*(bg-gradient-to-\w+ from-(\w+)-\d+|bg-(\w+)-500/\d+|bg-zinc-\d+)", blk)
        if tile:
            grad, gcol, flat = tile.group(2).startswith("bg-gradient"), tile.group(3), tile.group(4)
            row["tier"] = "gradient" if grad else ("flat" if flat else "neutral")
            row["accent"] = gcol or flat or "zinc"
            tile_i = blk.find(tile.group(0))
            near = blk[tile_i:tile_i + 400]
            if grad and re.search(r"text-white", near.split("</div>")[0] if "</div>" in near else near):
                row["flags"].append("TILE_WHITE")
        else:
            row["tier"] = "no-tile"; row["flags"].append("NO_TILE")
        scope = blk[blk.find(tile.group(0)):][:500] if tile else ""
        ic = [i for i in re.findall(r"<([A-Z][A-Za-z0-9]+)\s+className=\"[^\"]*(?:h|w)-\d", scope) if i not in NOT_ICONS]
        if ic: row["icon"] = ic[0]; icons[ic[0]] += 1
        if re.search(r"text-(?:emerald|amber|sky|indigo|violet|cyan|blue|purple|rose|red|green)-(?:500|600)", blk):
            row["flags"].append("TEXT_500")
        if re.search(r"dataDate|data_date|lastSession", src) and "DATA:" not in src:
            row["flags"].append("NO_DATA_CHIP")
        rows.append(row)
    for r in rows:
        if r["icon"] != "-" and icons[r["icon"]] >= 3:
            r["flags"].append("DUP_ICON")
    return rows, icons


def main():
    md = "--md" in sys.argv
    only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None
    if not os.path.isdir("app"):
        sys.exit("Run from rs_dashboard/ (needs ./app and ./components).")
    rows, icons = audit()
    if only:
        rows = [r for r in rows if only in r["flags"]]
    cols = ["route", "comp", "tier", "icon", "accent", "z", "flags"]
    if md:
        print("| " + " | ".join(cols) + " |\n|" + "---|" * len(cols))
        for r in rows:
            print("| " + " | ".join(f"`{r[c]}`" if c in ("route",) else (" ".join(r[c]) if c == "flags" else str(r[c])) for c in cols) + " |")
    else:
        w = {c: max(len(c), max((len(" ".join(r[c]) if c == "flags" else str(r[c])) for r in rows), default=0)) for c in cols}
        print("  ".join(c.ljust(w[c]) for c in cols))
        for r in rows:
            print("  ".join((" ".join(r[c]) if c == "flags" else str(r[c])).ljust(w[c]) for c in cols))
    tot = Counter(f for r in rows for f in r["flags"])
    print(f"\n{len(rows)} pages | " + " ".join(f"{k}={v}" for k, v in sorted(tot.items())), file=sys.stderr)
    print("top icons: " + ", ".join(f"{k}x{v}" for k, v in icons.most_common(8)), file=sys.stderr)


if __name__ == "__main__":
    main()
