#!/usr/bin/env python3
"""Verify exported DST files with an INDEPENDENT reader.

Spec section 8 requires reopening exports with an independent reader and
comparing against the intended stitch plan. Our own readDst agreeing with our
own writeDst only proves self-consistency: a mirrored axis or an inverted bit
would round-trip perfectly and still sew backwards.

pyembroidery is a separate implementation by other authors. If it agrees with
us on stitch count, every needle position, the bounding box and the colour
changes, the encoder is right in a way our own tests cannot establish.

    python3 scripts/independent-check.py
"""

import json
import math
import os
import re
import sys

try:
    import pyembroidery
except ImportError:
    sys.exit("pyembroidery not installed:  pip3 install pyembroidery")

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(os.path.dirname(HERE), "fixtures")

# DST quantises to 0.1 mm, so half a unit is the best any encoder can do.
TOL_MM = 0.051

failures = 0
checked = 0


def check(label, ok, detail=""):
    global failures
    if not ok:
        failures += 1
    print(f"    {'ok  ' if ok else 'FAIL'} {label:<34} {detail}")


index_path = os.path.join(FIX, "index.json")
if not os.path.exists(index_path):
    sys.exit("No fixtures. Run:  npx tsx scripts/fixtures.mts")

for entry in json.load(open(index_path)):
    name = entry["name"]
    dst_path = os.path.join(FIX, name + ".dst")
    intended = json.load(open(os.path.join(FIX, name + ".intended.json")))

    print(f"\n=== {name} — {intended['note']}")
    pattern = pyembroidery.read_dst(dst_path)

    # pyembroidery reports positions in 0.1 mm, accumulated from the origin,
    # exactly as the file stores them.
    stitches = [(x / 10.0, y / 10.0) for x, y, cmd in pattern.stitches
                if cmd == pyembroidery.STITCH]
    changes = sum(1 for _, _, cmd in pattern.stitches
                  if cmd in (pyembroidery.COLOR_CHANGE, pyembroidery.STOP))

    want = intended["penetrations"]
    checked += 1

    check("needle penetration count",
          len(stitches) == len(want),
          f"{len(stitches)} read / {len(want)} intended")

    # Orientation is a property of the format, not a free parameter, so decide
    # it ONCE by measurement and then report it — never silently try both and
    # keep whichever passes.
    if stitches and want:
        n = min(len(stitches), len(want))
        # Orientation is asserted, not discovered. Taking min(same, flipped)
        # would pass a codec that writes every design upside down — which is
        # precisely the defect an independent reader exists to catch.
        err = max(max(abs(stitches[i][0] - want[i][0]),
                      abs(stitches[i][1] - want[i][1])) for i in range(n))
        err_flip = max(max(abs(stitches[i][0] - want[i][0]),
                           abs(-stitches[i][1] - want[i][1])) for i in range(n))
        check("every needle position", err <= TOL_MM,
              f"max deviation {err:.4f} mm")
        check("not vertically mirrored", err <= err_flip or err <= TOL_MM,
              f"upright {err:.3f} mm vs mirrored {err_flip:.3f} mm")

        ys = [p[1] for p in stitches]
        xs = [p[0] for p in stitches]
        w = max(xs) - min(xs)
        h = max(ys) - min(ys)
        check("width preserved", abs(w - intended["widthMm"]) <= 2 * TOL_MM,
              f"{w:.2f} mm read / {intended['widthMm']:.2f} mm intended")
        check("height preserved", abs(h - intended["heightMm"]) <= 2 * TOL_MM,
              f"{h:.2f} mm read / {intended['heightMm']:.2f} mm intended")

    check("colour changes", changes == intended["colorChanges"],
          f"{changes} read / {intended['colorChanges']} intended")

    last = pattern.stitches[-1][2] if pattern.stitches else None
    check("file terminated", last == pyembroidery.END,
          f"last command {last}")

    # Colour sidecars, read back by the same independent library. DST carries
    # no colour, so these are the only way the operator's software knows what
    # to put in each needle.
    want_colors = [c.lstrip("#").lower() for c in intended.get("colors", [])]
    for ext, reader, text_mode in (
        ("col", pyembroidery.ColReader, True),
        ("edr", pyembroidery.EdrReader, False),
    ):
        path = os.path.join(FIX, name + "." + ext)
        if not os.path.exists(path):
            check(f".{ext} sidecar present", False, "missing")
            continue
        side = pyembroidery.EmbPattern()
        with open(path, "r" if text_mode else "rb") as fh:
            reader.read(fh, side)
        got = ["%02x%02x%02x" % (t.get_red(), t.get_green(), t.get_blue())
               for t in side.threadlist]
        check(f".{ext} thread count", len(got) == len(want_colors),
              f"{len(got)} read / {len(want_colors)} intended")
        check(f".{ext} colours match", got == want_colors,
              f"{','.join(got)} vs {','.join(want_colors)}")

    # -------------------------------------------------------------------
    # MACHINE-SAFETY GATE.
    #
    # Everything above checks that the file says what we meant. These checks
    # ask a different question: is what we meant SAFE TO SEW? Two full review
    # rounds passed a design that sewed a 9.5 mm approach leg from hoop centre
    # and restarted every trim with nothing anchoring the thread, because no
    # verifier asserted a single machine-safety property. These are asserted
    # on the decoded BYTES, not on our own plan.
    # -------------------------------------------------------------------
    raw = open(dst_path, "rb").read()
    body = raw[512:]
    if body.endswith(b"\x1a"):
        body = body[:-1]
    recs = [body[i:i + 3] for i in range(0, len(body) - 2, 3)]

    def kind(r):
        b2 = r[2]
        if b2 == 0xF3:
            return "end"
        if (b2 & 0xC0) == 0xC0:
            return "stop"
        return "jump" if (b2 & 0x80) else "stitch"

    kinds = [kind(r) for r in recs]
    deltas = []
    for r in recs:
        b0, b1, b2 = r[0], r[1], r[2]
        dx = (b0 & 1) - ((b0 >> 1) & 1) + 9 * ((b0 >> 2) & 1) - 9 * ((b0 >> 3) & 1)
        dx += 3 * (b1 & 1) - 3 * ((b1 >> 1) & 1) + 27 * ((b1 >> 2) & 1) - 27 * ((b1 >> 3) & 1)
        dx += 81 * ((b2 >> 2) & 1) - 81 * ((b2 >> 3) & 1)
        dy = ((b0 >> 7) & 1) - ((b0 >> 6) & 1) + 9 * ((b0 >> 5) & 1) - 9 * ((b0 >> 4) & 1)
        dy += 3 * ((b1 >> 7) & 1) - 3 * ((b1 >> 6) & 1) + 27 * ((b1 >> 5) & 1) - 27 * ((b1 >> 4) & 1)
        dy += 81 * ((b2 >> 5) & 1) - 81 * ((b2 >> 4) & 1)
        deltas.append((dx, dy))

    first_stitch = next((i for i, k in enumerate(kinds) if k == "stitch"), None)
    check("approach is needle-UP",
          first_stitch is not None and all(k == "jump" for k in kinds[:first_stitch]),
          f"{first_stitch} lead-in record(s), all jumps"
          if first_stitch is not None else "no stitches at all")

    after_stop = [i + 1 for i, k in enumerate(kinds) if k == "stop" and i + 1 < len(kinds)]
    check("every colour change is followed by a jump",
          all(kinds[i] == "jump" for i in after_stop),
          f"{len(after_stop)} checked")

    # No zero-displacement jumps: an optimiser that strips no-op records would
    # otherwise delete our trims and leave an uncut float across the garment.
    zero_jumps = sum(1 for i, k in enumerate(kinds) if k == "jump" and deltas[i] == (0, 0))
    check("no zero-displacement jump records", zero_jumps == 0, f"{zero_jumps} found")

    # Jump runs are either a single hop or a trim (>=3). A 2-run is ambiguous.
    runs, run = [], 0
    for k in kinds:
        if k == "jump":
            run += 1
        else:
            if run:
                runs.append(run)
            run = 0
    if run:
        runs.append(run)
    check("jump runs are 1 or >=3 (never an ambiguous 2)",
          all(n == 1 or n >= 3 for n in runs), f"runs: {runs}")

    # Sewn stitch length, measured post-quantisation from the bytes.
    sewn = [math.hypot(deltas[i][0], deltas[i][1]) / 10.0
            for i, k in enumerate(kinds) if k == "stitch"]
    if sewn:
        check("no sewn stitch over 10 mm", max(sewn) <= 10.0 + 1e-9, f"longest {max(sewn):.2f} mm")
        check("no sewn stitch under 0.1 mm", min(sewn) >= 0.1 - 1e-9, f"shortest {min(sewn):.2f} mm")

    # Every trim must be bracketed by short lock stitches on BOTH sides, or
    # the machine cuts and restarts with nothing holding the thread end.
    def locks_around(run_start, run_end):
        before = [sewn_i for sewn_i in range(run_start - 1, max(-1, run_start - 4), -1)
                  if kinds[sewn_i] == "stitch"]
        after = [sewn_i for sewn_i in range(run_end, min(len(kinds), run_end + 4))
                 if kinds[sewn_i] == "stitch"]
        ok_b = before and all(math.hypot(*deltas[i]) / 10.0 <= 2.0 for i in before)
        ok_a = after and all(math.hypot(*deltas[i]) / 10.0 <= 2.0 for i in after)
        return bool(ok_b and ok_a)

    trims, untied = 0, 0
    i = 0
    while i < len(kinds):
        if kinds[i] == "jump":
            j = i
            while j < len(kinds) and kinds[j] == "jump":
                j += 1
            # The opening lead-in has no thread to anchor yet, and the final
            # return-to-origin has nothing following it to tie into.
            tail_only = all(k == "end" for k in kinds[j:])
            if j - i >= 3 and i > 0 and not tail_only:
                trims += 1
                if not locks_around(i, j):
                    untied += 1
            i = j
        else:
            i += 1
    check("every mid-design trim is tied off AND tied in",
          untied == 0, f"{trims} trim(s), {untied} untied")

    check("file ends 512 + 3n + 1 with an EOF marker",
          (len(raw) - 512 - 1) % 3 == 0 and raw[-1] == 0x1A,
          f"{len(raw)} bytes, last 0x{raw[-1]:02x}")

    hdr = {}
    for field in raw[:512].decode("latin-1").split("\r"):
        m = re.match(r"^([+\-A-Z]{2}):(.*)$", field.strip())
        if m:
            hdr[m.group(1)] = m.group(2).strip()
    check("header ST counts every record incl. terminator",
          int(hdr.get("ST", -1)) == len(recs), f"{hdr.get('ST')} vs {len(recs)}")
    check("design returns to origin (AX/AY zero)",
          int(hdr.get("AX", "1")) == 0 and int(hdr.get("AY", "1")) == 0,
          f"AX={hdr.get('AX')} AY={hdr.get('AY')}")

print(f"\n{checked} fixture(s) checked against pyembroidery — "
      f"{'ALL PASS' if not failures else str(failures) + ' CHECK(S) FAILED'}")
sys.exit(1 if failures else 0)
