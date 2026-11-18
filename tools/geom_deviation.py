"""How far apart is the geometry of two DXFs? (complements IFC2DXF/tests/compare_dxf.py, which only says
identical / different).

For every modelspace LWPOLYLINE of A, the polyline of B on the same layer with the smallest Hausdorff distance is
matched; the same for block references (insertion points) and block definitions (all their polylines together).
Prints the maximum and mean deviation in millimetres per layer.

Usage: python tools/geom_deviation.py A.dxf B.dxf [--tolerance-mm 10]
Exit code 0 when every deviation is within the tolerance.
"""
import argparse
import collections
import math
import sys

import ezdxf
from shapely import STRtree
from shapely.geometry import LineString, MultiLineString, Point


def polylines(entities):
    out = collections.defaultdict(list)
    for e in entities:
        if e.dxftype() == "LWPOLYLINE":
            pts = [(p[0], p[1]) for p in e.get_points("xy")]
            if e.closed and len(pts) > 2:
                pts.append(pts[0])
            if len(pts) >= 2:
                out[e.dxf.layer].append(LineString(pts))
    return out


def match(ga, gb):
    """Hausdorff distance of each A geometry to its best match in B (and vice versa), in metres."""
    if not ga or not gb:
        return [math.inf] * max(len(ga), len(gb))
    res = []
    for src, dst in ((ga, gb), (gb, ga)):
        tree = STRtree(dst)
        for g in src:
            cand = tree.query(g.buffer(1.0))
            if len(cand) == 0:
                cand = range(len(dst))
            res.append(min(g.hausdorff_distance(dst[i]) for i in cand))
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("a")
    ap.add_argument("b")
    ap.add_argument("--tolerance-mm", type=float, default=10.0)
    a = ap.parse_args()
    A, B = ezdxf.readfile(a.a), ezdxf.readfile(a.b)
    worst = 0.0
    rows = []
    pa, pb = polylines(A.modelspace()), polylines(B.modelspace())
    for layer in sorted(set(pa) | set(pb)):
        d = match(pa.get(layer, []), pb.get(layer, []))
        rows.append((f"polylines on {layer}", len(pa.get(layer, [])), len(pb.get(layer, [])), d))
    ia = [e for e in A.modelspace() if e.dxftype() == "INSERT"]
    ib = [e for e in B.modelspace() if e.dxftype() == "INSERT"]
    d = match([Point(e.dxf.insert.x, e.dxf.insert.y).buffer(1e-6) for e in ia],
              [Point(e.dxf.insert.x, e.dxf.insert.y).buffer(1e-6) for e in ib])
    rows.append(("block reference insertion points", len(ia), len(ib), d))
    names = sorted({b.name for b in A.blocks if b.name.startswith("MANHOLE_")} |
                   {b.name for b in B.blocks if b.name.startswith("MANHOLE_")})
    bd = []
    for n in names:
        la = [g for gs in polylines(A.blocks.get(n)).values() for g in gs] if n in A.blocks else []
        lb = [g for gs in polylines(B.blocks.get(n)).values() for g in gs] if n in B.blocks else []
        bd.append(MultiLineString(la).hausdorff_distance(MultiLineString(lb)) if la and lb else math.inf)
    rows.append(("manhole block definitions (per block)", len(names), len(names), bd))
    print(f"{'what':55s} {'A':>5s} {'B':>5s} {'max mm':>10s} {'mean mm':>10s} {'> tol':>6s}")
    for what, na, nb, d in rows:
        if not d:
            continue
        mx = max(d)
        worst = max(worst, mx)
        over = sum(x * 1000 > a.tolerance_mm for x in d)
        mean = sum(d) / len(d)
        print(f"{what[:55]:55s} {na:5d} {nb:5d} {mx * 1000:10.2f} {mean * 1000:10.3f} {over:6d}")
    ok = worst * 1000 <= a.tolerance_mm
    print(f"\nlargest deviation {worst * 1000:.2f} mm; tolerance {a.tolerance_mm} mm -> {'PASS' if ok else 'FAIL'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
