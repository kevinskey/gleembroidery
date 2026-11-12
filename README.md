# gleEmbroidery

Embroidery digitizing: vector art in, machine stitch files out. Built for the
BAI commercial machine, which reads **Tajima DST**.

The document is a list of **vector objects**, each assigned a **stitch type**
(run / bean / satin / fill). Stitches are never the document — they are
regenerated from the objects on every parameter change, so nothing is
destructive until export.

```
npm install
npm run dev                 # http://localhost:5173
npm test                    # engine self-test, headless (76 assertions)
npm run verify:independent  # export fixtures, check them with pyembroidery
npm run verify:dst -- f.dst # validate third-party DST files
npm run build               # typecheck + production build
```

## What it does today

- **Save and reopen projects** (`.gleemb`) with every parameter intact — the
  object model, not a rendered preview. The schema version is an explicit
  gate: a file from a newer build is refused rather than half-read and
  silently stripped on the next save. Work in progress also autosaves.
- **Import SVG** — every geometry element is flattened to millimetre polylines
  using the browser's own path engine, so transforms, nested groups, viewBox
  scaling and units are resolved with the real CTM. Closed shapes are nested
  into regions, so a letter counter stays a hole.
- **Stitch types** — running, bean (triple), satin column, tatami fill, plus
  per-object underlay, pull compensation and an optional satin border.
- **Open DST** — reads any existing design (the whole Embrilliance library)
  and draws it as a grey reference behind the work.
- **Export the production package** — the `.dst`, `.col`/`.edr` colour
  sidecars, a printable run sheet (thread codes, stitch counts, trims,
  estimated run time) and a 1:1 placement template with centre crosshairs and
  a 50 mm scale-check bar. A bare `.dst` carries no colour at all, so on its
  own it hands the operator unlabelled blocks.
- **Machine-correct output** — approach legs jump rather than sew, travel past
  6 mm is tied off, trimmed and tied back in, and stitches are held between a
  minimum and maximum length.
- **Background generation** — stitches are produced in a worker keyed to the
  document revision, so a slow result can never overwrite a newer edit. 28,656
  stitches generate in about 95 ms.
- **Hoop + stitch-out preview** — inch rulers, centre-origin canvas, a slider
  that plays the design back stitch by stitch, and a warning when the design
  outgrows the selected hoop.

## Verification

The two things that can ruin a garment are a wrong file format and bad stitch
geometry, so both are tested rather than eyeballed.

**`npm run verify:dst -- <file.dst>`** decodes real files and checks the
numbers it computes against the header the originating software wrote. Run
against seven third-party files (Embrilliance, Quick Digitizing and vendor
output, 3.4k–22.9k stitches), every one matches exactly on stitch count,
colour-change count and all four extents, and re-encodes bit-identically.
That is what confirms the record bit table, the axis signs and the 0.1 mm
scale — not a spec read off a web page.

**`npm run verify:independent`** exports the spec §11 fixtures and reads them
back with **pyembroidery** — a separate implementation by other authors —
asserting every needle position, the bounding box, the colour changes, the
terminator, that the file is *not* vertically mirrored, and that the `.col`
and `.edr` sidecars carry the right colours. One fixture is deliberately
off-centre and asymmetric so `+X != -X` and `+Y != -Y` are actually testable.

**`npm test`** covers the engine: resampling exactness, fill row count and
coverage, stagger (with a control that proves the test can fail), holes
(nothing may land in or be dragged across a counter), satin width/pitch/
curvature correction, colour-block merging, the stitch-length ceiling, and a
full digitize → DST → re-parse round trip asserting every needle penetration
survives within DST's 0.05 mm quantisation. It also asserts the things that
once silently broke: a hole touching its outline stays a hole at all four
vertex rotations; overlapping subpaths union instead of double-stitching;
insetting a region shrinks the outline and *grows* the hole; the first record
of every design and every colour block lifts the needle; trims appear as runs
of three jumps; generation is byte-identical across runs; and a reopened
project re-digitises byte-identically.

## Layout

| file | role |
| --- | --- |
| `model.ts` | document, objects, stitch parameters, hoops |
| `vector.ts` | SVG → millimetre polylines (needs the DOM) |
| `geometry.ts` | resampling, regions/holes, scanline spans |
| `boolean.ts`, `offset.ts` | polygon booleans and offsetting |
| `fill.ts` | tatami fill, edge and zigzag underlay |
| `satin.ts` | satin columns, running and bean stitch |
| `digitize.ts` | objects → stitch plan: order, locks, trims, colour blocks |
| `dst.ts` | Tajima DST reader and writer |
| `project.ts` | native `.gleemb` save/reopen, versioned |
| `package.ts` | colour sidecars, run sheet, 1:1 placement template |
| `worker.ts` / `useStitchPlan.ts` | background generation, revision-keyed |
| `render.ts` | hoop, rulers, artwork and stitches on canvas |
| `App.tsx` | the editor |

`geometry`, `fill`, `satin`, `digitize` and `dst` are DOM-free, which is why
the test suite runs headless under node. Only `vector.ts` and `render.ts`
need a browser.

## Notes on the stitch engine

Three things separate this from naive scanline output:

- **Stagger.** Fill rows split their long runs on one global lattice whose
  phase advances per row. Without it the needle holes line up and a visible
  valley runs down the fill.
- **Column ordering.** Consecutive rows with the same span count are sewn as
  columns, so a ring is filled down one side and back up the other instead of
  jumping across the hole on every row. On the sample that is 19 jumps rather
  than 44.
- **Curvature-corrected satin.** The step along the spine shortens with local
  curvature, so the outer rail of a bend keeps the requested density instead
  of fanning open.

## Known limits

- **Satin is a centreline plus a width**, not a true two-rail column with
  angle guides. It refuses geometry it cannot sew (fold-through, over-width,
  under-width) rather than producing something unsewable, but a rail pair is
  what real satin lettering needs.
- **Travel routing is straight-line-or-jump.** It does not yet walk around an
  obstacle along the boundary.
- **The offset fast path is a bisector offset**, guarded by an area-magnitude
  check and a self-intersection test, with the Minkowski clipper as fallback.
  It is correct for the small deltas embroidery uses and about 300x faster,
  which is what took generation from seconds to milliseconds.
- **Nothing has been sewn.** Every claim here is software verification.

## Not built yet

- Raster (PNG/JPG) auto-tracing. StoneCut already has a colour-layer tracer
  (`src/image.ts`, `imageToColorLayers`) that produces exactly the contour +
  grid shape this engine wants; porting it needs `marchingSquares` and `Grid`
  lifted out of StoneCut's `fill.ts`.
- Lettering. `opentype.js` is already a dependency; StoneCut's `text.ts` and
  `fontstore.ts` are the model to follow, and satin columns are already the
  right generator for letters.
- Writing PES/JEF/EXP. DST covers the BAI and every commercial machine; the
  home-machine formats carry thread colours and would need a colour table.
- Drawing and node editing on canvas. Objects currently come from SVG only.
- Automatic satin detection for thin regions (needs a medial axis).
