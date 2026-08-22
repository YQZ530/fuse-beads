import argparse
import importlib.util
import json
import pathlib
import re
import sys
import time
from collections import Counter, defaultdict
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "analyze_color_legend.py"
MANIFEST = ROOT / "test_scr" / "groups.manifest.json"
OUT_DEBUG = ROOT / "test_scr" / "output" / "color_modal_grid_ocr.debug.json"
OUT_FINAL = ROOT / "test_scr" / "output" / "color_modal_grid_ocr.final.json"
OUT_COMPARE = ROOT / "test_scr" / "output" / "color_modal_grid_ocr.compare.json"

spec = importlib.util.spec_from_file_location("acl", SCRIPT)
acl = importlib.util.module_from_spec(spec)
sys.modules["acl"] = acl
spec.loader.exec_module(acl)
acl.configure_tesseract(acl.DEFAULT_TESSERACT)


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


def analyze_modal(path: pathlib.Path, palette: list[Any]) -> dict[str, Any]:
    image = acl.read_image(path)
    if image is None:
        return {"source": str(path), "error": "could_not_read", "items": [], "colorCounts": {}, "totalColorKeys": 0, "totalBeads": 0}
    box = acl.find_modal_box(image)
    if box is None:
        return {"source": str(path), "error": "modal_box_not_found", "items": [], "colorCounts": {}, "totalColorKeys": 0, "totalBeads": 0}

    raw_circles = acl.detect_modal_circles(image, box)
    circles = sort_circles_grid(raw_circles)
    number_tokens = acl.read_modal_number_tokens(image, box)
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
        if inside_key in palette_by_key:
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
                "sampledRgb": list(sampled_rgb),
                "distance": round(float(distance), 3),
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


def build_final(debug_payload: dict[str, Any]) -> dict[str, Any]:
    images = []
    conflicts = []
    for row in debug_payload["images"]:
        current = f"{row['totalColorKeys']}_{row['totalBeads']}"
        image = {
            "id": row["id"],
            "expected": row.get("expectedPairKey"),
            "current": current,
            "matchesExpected": row.get("matchesPairKey"),
            "totalColorKeys": row["totalColorKeys"],
            "totalBeads": row["totalBeads"],
            "colorCounts": row["colorCounts"],
        }
        images.append(image)
        if not row.get("matchesPairKey"):
            conflicts.append({"id": row["id"], "expected": row.get("expectedPairKey"), "current": current})
    return {"imageCount": len(images), "conflictCount": len(conflicts), "images": images, "conflictImages": conflicts}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="", help="Comma-separated Image ids, e.g. Image4,Image5.")
    args = parser.parse_args()

    only = {item.strip() for item in args.only.split(",") if item.strip()}
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
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
        results.append(page)

    payload = {
        "input": str(MANIFEST),
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
