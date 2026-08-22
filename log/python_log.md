# Python Log

Last updated: 2026-08-21

This log records the current Python pipeline for grouping Perler bead screenshots and extracting color legends. It is meant as a developer handoff note, not as raw runtime output.

## Important Scripts

### `scripts/group_similar_pattern_images.py`

Purpose: group raw iPad screenshots into logical `ImageN` projects and write a manifest for later analysis.

Typical command:

```powershell
python scripts/group_similar_pattern_images.py C:\Users\z5308\Desktop\batch_pic --out C:\Users\z5308\Desktop\batch_pic --manifest results\grouping\groups.manifest.json
```

Important behavior:

- Classifies screenshots into `detail_page`, `summary_view`, `color_modal`, or `unknown`.
- Uses CV layout signals first, then OCR for `pairKey` such as `52_2955`.
- `detail_page` pairKey OCR uses the bottom legend rectangle and an orientation-aware title crop.
- `summary_view` OCR uses the bottom summary band, not the largest white rectangle.
- `color_modal` OCR uses the modal title band.
- Groups images by main-pattern similarity, using pHash/dHash/color histogram/crop thumb signals.
- Export order matters: nearby images are compared first with `DEFAULT_LOCAL_WINDOW = 5`.
- `pairKey` is treated as a useful signal, not absolute truth.
- `summary_view` and `color_modal` can merge by pairKey only when both already have the same pairKey.
- `detail_page` is not converted into `summary_view`.
- Missing or conflicting pairKey cases are preserved as review candidates.
- Multi-image groups are written as `ImageN/ImageN_1.ext`, `ImageN/ImageN_2.ext`, etc.
- Single-image groups remain as root files such as `ImageN.png`.
- `groups.manifest.json` preserves each item source, copied/moved path, `pageType`, `pairKey`, and grouping metadata.

Main output:

```text
results/grouping/groups.manifest.json
```

or whatever path is passed with `--manifest`.

The manifest is the input to `scripts/analyze_color_legend.py`.

## `scripts/analyze_color_legend.py`

Purpose: main color legend analyzer. It reads `groups.manifest.json`, prefers `detail_page` images, falls back to `color_modal` images, and outputs both debug and final JSON.

Batch command currently documented at top of script:

```powershell
python scripts/analyze_color_legend.py --manifest results/grouping/groups.manifest.json --out results/batch_pic/analyze_color_legend.debug.json
```

For the current tested local manifest, we ran:

```powershell
python scripts/analyze_color_legend.py --manifest results/grouping/groups.manifest.json --out results/batch_pic/analyze_color_legend.debug.json
```

Main outputs:

```text
results/batch_pic/analyze_color_legend.debug.json
results/batch_pic/analyze_color_legend.main.json
results/batch_pic/analyze_color_legend.debug.combine.json
results/batch_pic/analyze_color_legend.main.combine.json
```

Current final/combine status after manual review:

```text
imageCount=32
conflictCount=0
remainingReviewImages=0
```

Important new final JSON behavior:

- Each final image now includes `sourceImages`.
- `sourceImages` is copied from the debug merged group, so multi-page images like `Image1` show all page files.
- `needsReview` and `needsReviewCount` are included in final.
- Confirmed review items can be cleared after human review.
- `conflictImages` also includes `sourceImages` when conflicts exist.

### Detail Page Logic

For `detail_page`, the main script uses the bottom legend area.

Key extraction:

- Detects legend circles in the bottom legend rectangle.
- Samples circle RGB and matches to the MARD palette in Lab color space.
- Normal behavior is palette-match first.
- Circle-inside OCR is only used as a fallback when the sampled color distance is high or the circle looks like a non-color/stat circle.
- For multi-page detail groups, incomplete left/right edge circles can be dropped:
  - page 1 can drop incomplete right-edge circles;
  - later pages can drop incomplete left-edge circles.

Count extraction:

- Uses multiple count candidates:
  - preprocessing vote OCR;
  - OpenCV component/template count;
  - Tesseract token under the circle.
- `choose_count_text()` performs count voting.
- Conflicts are preserved in debug fields:
  - `countCandidates`
  - `countVoteSources`
  - `countConflict`
  - `preprocessingVoteObservations`
  - `opencvScores`

Group merge/reconcile:

- Repeated color keys across pages are merged.
- Count candidates and expected `pairKey` totals are used for reconciliation.
- The expected total is taken from group-level `pairKey`, not from a per-page fake total.
- Multi-page detail groups keep page-level evidence in `pages`.

### Color Modal Integration

The main script now imports:

```python
import analyze_color_modal_legend
```

When a manifest group has no `detail_page` but has `color_modal`, main script calls:

```python
analyze_color_modal_legend.analyze_modal(source, palette, sys.modules[__name__])
```

This keeps the color modal parser separate while reusing the main script helpers and palette.

Color modal page results are merged into the same debug/final JSON shape as detail pages.

## `scripts/analyze_color_modal_legend.py`

Purpose: specialized parser for `color_modal` pages. This came from the experiment script and is now in the main scripts folder.

Standalone command:

```powershell
python scripts/analyze_color_modal_legend.py --manifest results/grouping/groups.manifest.json --only Image4
```

For current local test data:

```powershell
python scripts/analyze_color_modal_legend.py --manifest results/grouping/groups.manifest.json --only Image4,Image5,Image24,Image26,Image28
```

Standalone outputs:

```text
test_scr/output/color_modal_grid_ocr.debug.json
test_scr/output/color_modal_grid_ocr.final.json
test_scr/output/color_modal_grid_ocr.compare.json
```

Core modal assumptions:

- A color modal has a large white modal panel.
- Inside the panel, color circles are laid out as a grid with 6 circles per row.
- The modal can have more rows than the old parser scanned.

Circle detection:

- Finds the modal box with the main analyzer helper.
- Scans nearly the whole modal content:
  - top: `box_y + 8%`
  - bottom: `box_y + 96%`
- Uses Hough circle detection with several `param2` thresholds.
- Sorts circles by grid row, then x order.
- Keeps at most 6 circles per row.
- This fixed Image4, where the old modal logic only found 36 circles and missed the lower rows.

Color key decision:

- Samples circle color and palette-matches first.
- Reads circle-inside text as extra evidence.
- Important rule:

```text
if distance <= 2.0:
    keep palette match
else if inside OCR is a valid palette key:
    use inside OCR
```

This prevents clean palette matches from being overwritten by bad inside OCR.

Confirmed examples:

```text
Image4 E5:
  inside OCR read C5J/C5
  palette match was E5
  distance=0.0
  final key kept E5

Image4 E16:
  inside OCR read B16
  palette match was E16
  distance=0.0
  final key kept E16
```

Count decision:

- Reads count under each modal circle using:
  - `preprocessing_vote_count_crop`
  - legacy count OCR
  - Tesseract token OCR
- Preserves all candidates in JSON.
- If count candidates disagree, the item is added to `needsReview`.

Human review/suggested correction:

- `count_review_items()` builds `needsReview`.
- If a candidate count would make the image total match expected `pairKey`, it adds:

```json
"suggestedCorrection": {
  "count": 58,
  "reason": "candidate_matches_expected_total",
  "currentTotalBeads": 2995,
  "expectedTotalBeads": 2955,
  "correctedTotalBeads": 2955
}
```

Confirmed modal corrections:

```text
Image4 A8:
  selected 98
  human confirmed 58
  final colorCounts A8=58

Image5 H2:
  selected 93
  human confirmed 53
  final colorCounts H2=53
```

Confirmed modal review items that were already correct:

```text
Image5 A20=532
Image5 G6=1
Image24 F21=53
```

After confirming these, final JSON has:

```text
remainingReviewImages=0
conflictCount=0
```

## Current Known Good Color Modal Results

After main-script combine output and manual review:

```text
Image4   52_2955  PASS
Image5   31_2652  PASS
Image24  27_1426  PASS
Image26  30_2356  PASS
Image28  5_893    PASS
```

## Current Output Files

The main files to inspect are:

```text
results/batch_pic/analyze_color_legend.debug.json
results/batch_pic/analyze_color_legend.main.json
```

The combine copies currently contain the same all-image result:

```text
results/batch_pic/analyze_color_legend.debug.combine.json
results/batch_pic/analyze_color_legend.main.combine.json
```

The combine files include all 32 grouped images, not only color modal pages.

## Notes For Future Changes

- Keep `analyze_color_modal_legend.py` as the separate color modal implementation.
- Do not mix modal experiments directly into the detail page path.
- Detail page behavior is currently the stable main path.
- Color modal behavior should be tested through the standalone modal script first, then integrated through the main script.
- When manual fixes are made to JSON, keep `debug`, `main`, `debug.combine`, and `main.combine` consistent.
- If new review cases appear, prefer preserving candidates and adding `suggestedCorrection` instead of silently changing counts.

