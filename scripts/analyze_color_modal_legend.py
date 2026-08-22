#!/usr/bin/env python3
"""Analyze color modal pages with the modal-specific 6-column circle grid.

Standalone test run:
    python scripts/analyze_color_modal_legend.py --manifest results/grouping/groups.manifest.json --only Image4
"""

import argparse
import importlib.util
import json
import pathlib
import re
import sys
import time
from collections import Counter, defaultdict
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "analyze_color_legend.py"
MANIFEST = ROOT / "results" / "grouping" / "groups.manifest.json"
OUT_DEBUG = ROOT / "test_scr" / "output" / "color_modal_grid_ocr.debug.json"
OUT_FINAL = ROOT / "test_scr" / "output" / "color_modal_grid_ocr.final.json"
OUT_COMPARE = ROOT / "test_scr" / "output" / "color_modal_grid_ocr.compare.json"

acl: Any = None


def configure_acl(module: Any | None = None) -> Any:
    global acl
    if module is not None:
        acl = module
        return acl
    if acl is not None:
        return acl
    spec = importlib.util.spec_from_file_location("acl", SCRIPT)
    loaded = importlib.util.module_from_spec(spec)
    sys.modules["acl"] = loaded
    if spec.loader is None:
        raise RuntimeError(f"Could not load {SCRIPT}")
    spec.loader.exec_module(loaded)
    loaded.configure_tesseract(loaded.DEFAULT_TESSERACT)
    acl = loaded
    return acl


def pair_key_from_group(group: dict[str, Any]) -> str:
    keys = [
        item.get("pairKey")
        for item in group.get("items", [])
        if isinstance(item, dict) and isinstance(item.get("pairKey"), str) and re.match(r"^\d+_\d+$", item["pairKey"])
    ]
    return Counter(keys).most_common(1)[0][0] if keys else ""


def sort_circles_grid(circles: list[tuple[int, int, int]]) -> list[tuple[int, int, int]]:
    if not circles:
        return []
    radii = [r for _x, _y, r in circles]
    tolerance = max(24, int(round(float(acl.np.median(radii)) * 1.35)))
    rows: list[list[tuple[int, int, int]]] = []
    for circle in sorted(circles, key=lambda item: item[1]):
        for row in rows:
            if abs(circle[1] - float(acl.np.median([item[1] for item in row]))) <= tolerance:
                row.append(circle)
                break
        else:
            rows.append([circle])
    ordered = []
    for row in sorted(rows, key=lambda items: float(acl.np.median([item[1] for item in items]))):
        ordered.extend(sorted(row, key=lambda item: item[0])[:6])
    return ordered


def detect_modal_circles_full(image: Any, box: tuple[int, int, int, int]) -> list[tuple[int, int, int]]:
    x, y, w, h = box
    content_top = y + int(h * 0.08)
    content_bottom = y + int(h * 0.96)
    content = image[content_top:content_bottom, x:x + w]
    if content.size == 0:
        return []
    gray = acl.cv2.cvtColor(content, acl.cv2.COLOR_BGR2GRAY)
    gray = acl.cv2.medianBlur(gray, 5)
    min_radius = max(20, int(round(min(w, h) * 0.018)))
    max_radius = max(min_radius + 8, int(round(min(w, h) * 0.045)))
    min_dist = max(70, int(round(w * 0.10)))
    detected: list[tuple[int, int, int]] = []
    for param2 in (14, 18, 22, 26, 30):
        circles = acl.cv2.HoughCircles(
            gray,
            acl.cv2.HOUGH_GRADIENT,
            dp=1.2,
            minDist=min_dist,
            param1=85,
            param2=param2,
            minRadius=min_radius,
            maxRadius=max_radius,
        )
        if circles is None:
            continue
        for cx, cy, radius in acl.np.round(circles[0]).astype(int):
            absolute_x = int(cx + x)
            absolute_y = int(cy + content_top)
            if absolute_x < x + radius or absolute_x > x + w - radius:
                continue
            if absolute_y < content_top + radius or absolute_y > content_bottom - radius:
                continue
            detected.append((absolute_x, absolute_y, int(radius)))
    return acl.merge_duplicate_circles(detected)


def read_modal_number_tokens_full(image: Any, box: tuple[int, int, int, int]) -> list[Any]:
    x, y, w, h = box
    content_top = y + int(h * 0.08)
    content_bottom = y + int(h * 0.96)
    crop = image[content_top:content_bottom, x:x + w]
    if crop.size == 0:
        return []
    gray = acl.cv2.cvtColor(crop, acl.cv2.COLOR_BGR2GRAY)
    gray = acl.cv2.resize(gray, None, fx=2, fy=2, interpolation=acl.cv2.INTER_CUBIC)
    gray = acl.cv2.threshold(gray, 0, 255, acl.cv2.THRESH_BINARY + acl.cv2.THRESH_OTSU)[1]
    config = "--psm 6 -c tessedit_char_whitelist=0123456789"
    try:
        data = acl.pytesseract.image_to_data(
            acl.Image.fromarray(gray),
            config=config,
            output_type=acl.pytesseract.Output.DICT,
            timeout=8,
        )
    except Exception:
        return []
    tokens = []
    for index, raw_text in enumerate(data.get("text", [])):
        text = acl.digits_only(raw_text)
        if not text:
            continue
        left = int(round(data["left"][index] / 2)) + x
        top = int(round(data["top"][index] / 2)) + content_top
        width = int(round(data["width"][index] / 2))
        height = int(round(data["height"][index] / 2))
        if len(text) > 4 or height < 8 or width < 3:
            continue
        tokens.append(acl.NumberToken(left, top, width, height, text))
    return tokens


def analyze_modal(path: pathlib.Path, palette: list[Any], acl_module: Any | None = None) -> dict[str, Any]:
    configure_acl(acl_module)
    image = acl.read_image(path)
    if image is None:
        return {"source": str(path), "error": "could_not_read", "items": [], "colorCounts": {}, "totalColorKeys": 0, "totalBeads": 0}
    box = acl.find_modal_box(image)
    if box is None:
        return {"source": str(path), "error": "modal_box_not_found", "items": [], "colorCounts": {}, "totalColorKeys": 0, "totalBeads": 0}

    raw_circles = detect_modal_circles_full(image, box)
    circles = sort_circles_grid(raw_circles)
    number_tokens = read_modal_number_tokens_full(image, box)
    palette_by_key = {color.key: color for color in palette}
    palette_keys = set(palette_by_key)
    items = []
    skipped = []

    for index, circle in enumerate(circles, start=1):
        x, y, radius = circle
        sampled_rgb = acl.sample_circle_rgb(image, x, y, radius)
        if sampled_rgb is None:
            skipped.append({"index": index, "reason": "no_sample", "circle": circle})
            continue
        matched, distance = acl.match_palette(sampled_rgb, palette)
        inside_key, inside_text = acl.read_circle_key(image, x, y, radius, palette_keys)
        special_key = acl.special_circle_key(inside_text)
        if special_key:
            skipped.append({"index": index, "reason": special_key, "insideText": inside_text, "circle": circle})
            continue
        color_key = matched.key
        color_hex = matched.hex
        color_key_source = "palette_match"
        if inside_key in palette_by_key and float(distance) > 2.0:
            color_key = inside_key
            color_hex = palette_by_key[inside_key].hex
            color_key_source = "inside_ocr"

        token = acl.find_count_below_circle(number_tokens, circle)
        token_text = token.text if token else ""
        preprocess_text, preprocess_observations = acl.preprocessing_vote_count_crop(image, x, y, radius)
        legacy_text = acl.read_count_below_circle(image, x, y, radius)
        count_text, count_source, vote_sources = acl.choose_count_text(preprocess_text, legacy_text, token_text)
        if not count_text:
            count_text = legacy_text or token_text
            count_source = "legacy_count_ocr" if legacy_text else ("tesseract_token" if token_text else "missing")
            vote_sources = [count_source] if count_text else []
        if not count_text:
            skipped.append({"index": index, "reason": "missing_count", "insideText": inside_text, "circle": circle})
            continue

        candidates = [preprocess_text, legacy_text, token_text]
        items.append(
            {
                "index": index,
                "colorKey": color_key,
                "count": int(count_text),
                "countText": count_text,
                "countSource": count_source,
                "countVoteSources": vote_sources,
                "colorKeySource": color_key_source,
                "insideKey": inside_key,
                "insideText": inside_text,
                "matchedKey": matched.key,
                "matchedHex": color_hex,
                "hex": color_hex,
                "sampledRgb": list(sampled_rgb),
                "distance": round(float(distance), 3),
                "uncertain": float(distance) > 34.0,
                "preprocessingVoteText": preprocess_text,
                "preprocessingVoteObservations": preprocess_observations,
                "legacyCountText": legacy_text,
                "tesseractCountText": token_text,
                "countCandidates": [
                    {"source": "preprocessing_vote", "text": preprocess_text},
                    {"source": "legacy_count_ocr", "text": legacy_text},
                    {"source": "tesseract_token", "text": token_text},
                ],
                "countConflict": len({value for value in candidates if value}) > 1,
                "bbox": {"x": x - radius, "y": y - radius, "width": radius * 2, "height": radius * 2},
            }
        )

    best: dict[str, dict[str, Any]] = {}
    duplicates: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in items:
        key = item["colorKey"]
        duplicates[key].append(item)
        if key not in best or int(item["count"]) > int(best[key]["count"]):
            best[key] = item

    rows = []
    for key, item in best.items():
        row = dict(item)
        row["duplicateDetections"] = duplicates[key]
        rows.append(row)
    rows.sort(key=lambda row: acl.color_key_sort(row["colorKey"]))
    color_counts = {row["colorKey"]: int(row["count"]) for row in rows}
    return {
        "source": str(path),
        "imageSize": {"width": int(image.shape[1]), "height": int(image.shape[0])},
        "modalBox": {"x": box[0], "y": box[1], "width": box[2], "height": box[3]},
        "rawCircleCount": len(raw_circles),
        "gridCircleCount": len(circles),
        "itemCount": len(rows),
        "totalColorKeys": len(color_counts),
        "totalBeads": int(sum(color_counts.values())),
        "colorCounts": color_counts,
        "colors": rows,
        "skipped": skipped,
    }


def count_review_items(row: dict[str, Any]) -> list[dict[str, Any]]:
    review = []
    expected_total = None
    expected_pair_key = str(row.get("expectedPairKey") or "")
    match = re.match(r"^\d+_(\d+)$", expected_pair_key)
    if match:
        expected_total = int(match.group(1))
    current_total = int(row.get("totalBeads") or 0)
    for item in row.get("colors", []):
        if not item.get("countConflict"):
            continue
        observations = [
            {
                "source": f"preprocessing_{obs.get('variant')}",
                "text": obs.get("digits", ""),
                "raw": obs.get("raw", ""),
            }
            for obs in item.get("preprocessingVoteObservations", [])
            if obs.get("digits")
        ]
        candidates = observations + [
            candidate
            for candidate in item.get("countCandidates", [])
            if candidate.get("text")
        ]
        selected_count = int(item.get("count") or 0)
        review_item = {
            "index": item.get("index"),
            "colorKey": item.get("colorKey"),
            "selectedCount": selected_count,
            "selectedText": item.get("countText"),
            "selectedSource": item.get("countSource"),
            "candidates": candidates,
            "bbox": item.get("bbox"),
        }
        if expected_total is not None:
            candidate_values = sorted({
                int(candidate.get("text"))
                for candidate in candidates
                if str(candidate.get("text") or "").isdigit()
            })
            for candidate_value in candidate_values:
                corrected_total = current_total - selected_count + candidate_value
                if candidate_value != selected_count and corrected_total == expected_total:
                    review_item["suggestedCorrection"] = {
                        "count": candidate_value,
                        "reason": "candidate_matches_expected_total",
                        "currentTotalBeads": current_total,
                        "expectedTotalBeads": expected_total,
                        "correctedTotalBeads": corrected_total,
                    }
                    break
        review.append(review_item)
    return review


def build_final(debug_payload: dict[str, Any]) -> dict[str, Any]:
    images = []
    conflicts = []
    for row in debug_payload["images"]:
        current = f"{row['totalColorKeys']}_{row['totalBeads']}"
        needs_review = count_review_items(row)
        image = {
            "id": row["id"],
            "expected": row.get("expectedPairKey"),
            "current": current,
            "matchesExpected": row.get("matchesPairKey"),
            "totalColorKeys": row["totalColorKeys"],
            "totalBeads": row["totalBeads"],
            "colorCounts": row["colorCounts"],
            "needsReviewCount": len(needs_review),
            "needsReview": needs_review,
        }
        images.append(image)
        if not row.get("matchesPairKey"):
            conflicts.append(
                {
                    "id": row["id"],
                    "expected": row.get("expectedPairKey"),
                    "current": current,
                    "needsReviewCount": len(needs_review),
                    "needsReview": needs_review,
                }
            )
    return {"imageCount": len(images), "conflictCount": len(conflicts), "images": images, "conflictImages": conflicts}


def print_review_items(row: dict[str, Any]) -> None:
    review = count_review_items(row)
    if not review:
        return
    print(f"{row['id']}: count conflicts needing human review:", flush=True)
    for item in review:
        candidates = ", ".join(
            f"{candidate.get('source')}={candidate.get('text')}"
            for candidate in item.get("candidates", [])
            if candidate.get("text")
        )
        print(
            f"  {item.get('colorKey')} selected={item.get('selectedText')} "
            f"source={item.get('selectedSource')} candidates=[{candidates}]",
            flush=True,
        )
        if item.get("suggestedCorrection"):
            correction = item["suggestedCorrection"]
            print(
                f"    suggestedCorrection={correction.get('count')} "
                f"reason={correction.get('reason')}",
                flush=True,
            )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", default=str(MANIFEST), help="groups.manifest.json path.")
    parser.add_argument("--only", default="", help="Comma-separated Image ids, e.g. Image4,Image5.")
    args = parser.parse_args()

    configure_acl()
    only = {item.strip() for item in args.only.split(",") if item.strip()}
    manifest_path = pathlib.Path(args.manifest)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    palette = acl.load_mard_palette(acl.DEFAULT_MAPPING_PATH, acl.DEFAULT_PALETTE_SETS_PATH, "291")
    results = []
    for group in manifest.get("groups", []):
        group_name = group.get("groupName") or group.get("folderName") or group.get("id") or "unknown"
        if only and group_name not in only:
            continue
        modal_items = [item for item in group.get("items", []) if item.get("pageType") == "color_modal"]
        if not modal_items:
            continue
        start = time.perf_counter()
        print(f"{group_name}: color_modal {len(modal_items)}", flush=True)
        page = analyze_modal(pathlib.Path(str(modal_items[0].get("source"))), palette)
        expected_pair_key = pair_key_from_group(group)
        page["id"] = group_name
        page["expectedPairKey"] = expected_pair_key
        page["matchesPairKey"] = expected_pair_key == f"{page['totalColorKeys']}_{page['totalBeads']}" if expected_pair_key else None
        page["elapsedSeconds"] = round(time.perf_counter() - start, 3)
        print_review_items(page)
        results.append(page)

    payload = {
        "input": str(manifest_path),
        "algorithm": "color_modal_grid_6_per_row_circle_key_count_ocr",
        "imageCount": len(results),
        "images": results,
    }
    OUT_DEBUG.parent.mkdir(parents=True, exist_ok=True)
    OUT_DEBUG.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    OUT_FINAL.write_text(json.dumps(build_final(payload), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    comparison = {
        "summary": {
            "matchedPairKey": sum(1 for row in results if row.get("matchesPairKey") is True),
            "mismatchedPairKey": sum(1 for row in results if row.get("matchesPairKey") is False),
            "unknownPairKey": sum(1 for row in results if row.get("matchesPairKey") is None),
        },
        "groups": [
            {
                "id": row["id"],
                "expectedPairKey": row.get("expectedPairKey"),
                "gotPairKey": f"{row['totalColorKeys']}_{row['totalBeads']}",
                "matchesPairKey": row.get("matchesPairKey"),
                "elapsedSeconds": row.get("elapsedSeconds"),
            }
            for row in results
        ],
    }
    OUT_COMPARE.write_text(json.dumps(comparison, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(OUT_DEBUG)
    print(OUT_FINAL)
    print(OUT_COMPARE)
    print(json.dumps(comparison["summary"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
