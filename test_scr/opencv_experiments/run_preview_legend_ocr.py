import csv
import argparse
import importlib.util
import json
import pathlib
import re
import sys
from collections import defaultdict
from typing import Any

import cv2
import numpy as np
from PIL import Image


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "analyze_color_legend.py"
PREVIEW_DIR = ROOT / "test_scr" / "output" / "ocr_crop_preview"
IMAGE_INFO = ROOT / "test_scr" / "output" / "image_info.json"
OUT_JSON = PREVIEW_DIR / "opencv_preview_legend_ocr.json"
OUT_CSV = PREVIEW_DIR / "opencv_preview_legend_ocr_items.csv"
OUT_COMPARE = PREVIEW_DIR / "opencv_preview_legend_ocr_compare_to_image_info.json"

spec = importlib.util.spec_from_file_location("acl", SCRIPT)
acl = importlib.util.module_from_spec(spec)
sys.modules["acl"] = acl
spec.loader.exec_module(acl)
acl.configure_tesseract(acl.DEFAULT_TESSERACT)


def image_id_from_crop(path: pathlib.Path) -> str:
    match = re.match(r"(Image\d+)_crop\d+\.png$", path.name, re.IGNORECASE)
    return match.group(1) if match else path.stem


def read_image(path: pathlib.Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read image: {path}")
    return image


def merge_circles(circles: list[tuple[int, int, int]]) -> list[tuple[int, int, int]]:
    return acl.merge_duplicate_circles(circles)


def detect_preview_circles(image: np.ndarray) -> list[tuple[int, int, int]]:
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.medianBlur(gray, 5)
    detected: list[tuple[int, int, int]] = []

    if height <= 360:
        min_radius = max(16, int(round(height * 0.085)))
        max_radius = max(min_radius + 8, int(round(height * 0.18)))
        min_dist = max(48, int(round(width * 0.032)))
        search_regions = [(0, image)]
    else:
        min_radius = max(20, int(round(min(width, height) * 0.018)))
        max_radius = max(min_radius + 10, int(round(min(width, height) * 0.045)))
        min_dist = max(70, int(round(width * 0.09)))
        top = int(round(height * 0.10))
        bottom = int(round(height * 0.78))
        search_regions = [(top, image[top:bottom, :])]

    for y_offset, crop in search_regions:
        crop_gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        crop_gray = cv2.medianBlur(crop_gray, 5)
        for param2 in (18, 22, 26, 30, 34):
            circles = cv2.HoughCircles(
                crop_gray,
                cv2.HOUGH_GRADIENT,
                dp=1.2,
                minDist=min_dist,
                param1=85,
                param2=param2,
                minRadius=min_radius,
                maxRadius=max_radius,
            )
            if circles is None:
                continue
            for cx, cy, radius in np.round(circles[0]).astype(int):
                x = int(cx)
                y = int(cy + y_offset)
                if x < radius or x > width - radius:
                    continue
                if y < radius or y > height - radius:
                    continue
                detected.append((x, y, int(radius)))

    return sort_circles(merge_circles(detected))


def sort_circles(circles: list[tuple[int, int, int]]) -> list[tuple[int, int, int]]:
    if not circles:
        return []
    radii = [r for _x, _y, r in circles]
    tolerance = max(26, int(round(float(np.median(radii)) * 1.45)))
    rows: list[list[tuple[int, int, int]]] = []
    for circle in sorted(circles, key=lambda item: item[1]):
        for row in rows:
            if abs(circle[1] - float(np.median([item[1] for item in row]))) <= tolerance:
                row.append(circle)
                break
        else:
            rows.append([circle])
    ordered: list[tuple[int, int, int]] = []
    for row in sorted(rows, key=lambda items: float(np.median([item[1] for item in items]))):
        ordered.extend(sorted(row, key=lambda item: item[0]))
    return ordered


def clamp_box(image: np.ndarray, x1: int, y1: int, x2: int, y2: int) -> tuple[int, int, int, int]:
    height, width = image.shape[:2]
    x1 = max(0, min(width - 1, x1))
    y1 = max(0, min(height - 1, y1))
    x2 = max(x1 + 1, min(width, x2))
    y2 = max(y1 + 1, min(height, y2))
    return x1, y1, x2 - x1, y2 - y1


def circle_union_box(
    image: np.ndarray,
    circles: list[tuple[int, int, int]],
    x_pad_factor: float,
    y_top_factor: float,
    y_bottom_factor: float,
) -> tuple[int, int, int, int]:
    if not circles:
        return 0, 0, image.shape[1], image.shape[0]
    x1 = min(int(round(x - r * x_pad_factor)) for x, _y, r in circles)
    x2 = max(int(round(x + r * x_pad_factor)) for x, _y, r in circles)
    y1 = min(int(round(y - r * y_top_factor)) for _x, y, r in circles)
    y2 = max(int(round(y + r * y_bottom_factor)) for _x, y, r in circles)
    return clamp_box(image, x1, y1, x2, y2)


def read_number_tokens(image: np.ndarray, box: tuple[int, int, int, int]) -> list[Any]:
    x, y, w, h = box
    crop = image[y : y + h, x : x + w]
    if crop.size == 0:
        return []
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    gray = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    config = "--psm 6 -c tessedit_char_whitelist=0123456789"
    try:
        data = acl.pytesseract.image_to_data(Image.fromarray(gray), config=config, output_type=acl.pytesseract.Output.DICT, timeout=8)
    except Exception:
        return []
    tokens = []
    for index, raw_text in enumerate(data.get("text", [])):
        text = acl.digits_only(raw_text)
        if not text:
            continue
        left = int(round(data["left"][index] / 2)) + x
        top = int(round(data["top"][index] / 2)) + y
        width = int(round(data["width"][index] / 2))
        height = int(round(data["height"][index] / 2))
        if len(text) > 4 or height < 7 or width < 3:
            continue
        tokens.append(acl.NumberToken(left, top, width, height, text))
    return tokens


def read_key_tokens(image: np.ndarray, box: tuple[int, int, int, int]) -> list[dict[str, Any]]:
    x0, y0, width0, height0 = box
    roi = image[y0 : y0 + height0, x0 : x0 + width0]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    variants = [
        cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1],
        cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1],
    ]
    config = "--psm 6 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    tokens: list[dict[str, Any]] = []
    seen: set[tuple[int, int, str]] = set()
    for variant_index, variant in enumerate(variants):
        scale = 2
        scaled = cv2.resize(variant, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        try:
            data = acl.pytesseract.image_to_data(Image.fromarray(scaled), config=config, output_type=acl.pytesseract.Output.DICT, timeout=8)
        except Exception:
            continue
        for index, raw_text in enumerate(data.get("text", [])):
            clean = str(raw_text or "").strip()
            normalized = acl.normalize_key_text(clean)
            if not normalized:
                continue
            left = int(round(data["left"][index] / scale)) + x0
            top = int(round(data["top"][index] / scale)) + y0
            width = int(round(data["width"][index] / scale))
            height = int(round(data["height"][index] / scale))
            if width < 3 or height < 5:
                continue
            dedupe_key = (round(left / 3), round(top / 3), normalized)
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            tokens.append(
                {
                    "x": left,
                    "y": top,
                    "w": width,
                    "h": height,
                    "text": clean,
                    "key": normalized,
                    "variant": variant_index,
                }
            )
    return tokens


def digit_components(image: np.ndarray) -> list[dict[str, Any]]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    mask = cv2.inRange(gray, 80, 235)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((1, 1), np.uint8))
    n, _labels, stats, _centroids = cv2.connectedComponentsWithStats(mask, 8)
    comps: list[dict[str, Any]] = []
    for idx in range(1, n):
        x, y, width, height, area = stats[idx]
        if 3 <= width <= 32 and 7 <= height <= 30 and 8 <= area <= 260:
            comps.append(
                {
                    "x": int(x),
                    "y": int(y),
                    "w": int(width),
                    "h": int(height),
                    "area": int(area),
                    "img": mask[y : y + height, x : x + width],
                }
            )
    return comps


def token_components(token: Any, comps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    inside = [
        comp
        for comp in comps
        if comp["x"] >= token.x - 4
        and comp["x"] + comp["w"] <= token.x + token.width + 4
        and comp["y"] >= token.y - 7
        and comp["y"] + comp["h"] <= token.y + token.height + 9
    ]
    return sorted(inside, key=lambda comp: comp["x"])


def build_templates(crops: list[dict[str, Any]]) -> dict[str, list[np.ndarray]]:
    templates: dict[str, list[np.ndarray]] = defaultdict(list)
    for crop in crops:
        comps = crop["components"]
        for token in crop["tokens"]:
            text = token.text
            inside = token_components(token, comps)
            if len(text) != len(inside):
                continue
            for digit, comp in zip(text, inside):
                templates[digit].append(normalize_component(comp))
    return dict(templates)


def normalize_component(comp: dict[str, Any]) -> np.ndarray:
    return cv2.resize(comp["img"], (24, 32), interpolation=cv2.INTER_NEAREST)


def classify_component(comp: dict[str, Any], templates: dict[str, list[np.ndarray]]) -> tuple[str, float]:
    if not templates:
        return "", 0.0
    char = normalize_component(comp)
    best_digit = ""
    best_score = -1.0
    for digit, digit_templates in templates.items():
        score = max(float(cv2.matchTemplate(char, tmpl, cv2.TM_CCOEFF_NORMED)[0][0]) for tmpl in digit_templates)
        if score > best_score:
            best_digit = digit
            best_score = score
    return best_digit, best_score


def components_below_circle(
    circle: tuple[int, int, int],
    comps: list[dict[str, Any]],
    image_shape: tuple[int, int, int],
) -> list[dict[str, Any]]:
    cx, cy, radius = circle
    height, _width = image_shape[:2]
    max_dx = max(radius * 1.25, 36)
    min_dy = radius * 0.60
    max_dy = radius * (2.50 if height > 360 else 2.15)
    candidates = []
    for comp in comps:
        comp_cx = comp["x"] + comp["w"] / 2
        comp_cy = comp["y"] + comp["h"] / 2
        dx = abs(comp_cx - cx)
        dy = comp_cy - cy
        if dx <= max_dx and min_dy <= dy <= max_dy:
            candidates.append(comp)
    return sorted(candidates, key=lambda comp: comp["x"])


def opencv_count_for_circle(
    circle: tuple[int, int, int],
    comps: list[dict[str, Any]],
    templates: dict[str, list[np.ndarray]],
    image_shape: tuple[int, int, int],
) -> tuple[str, list[float]]:
    candidates = components_below_circle(circle, comps, image_shape)
    if not candidates:
        return "", []
    recognized = [classify_component(comp, templates) for comp in candidates]
    if any(not digit or score < 0.35 for digit, score in recognized):
        return "", [round(score, 3) for _digit, score in recognized]
    return "".join(digit for digit, _score in recognized), [round(score, 3) for _digit, score in recognized]


def tesseract_count_for_circle(image: np.ndarray, circle: tuple[int, int, int], tokens: list[Any]) -> str:
    token = acl.find_count_below_circle(tokens, circle)
    return token.text if token else ""


def read_color_key_from_tokens(key_tokens: list[dict[str, Any]], circle: tuple[int, int, int], palette_keys: set[str]) -> tuple[str, str]:
    x, y, radius = circle
    candidates = []
    for token in key_tokens:
        token_cx = token["x"] + token["w"] / 2
        token_cy = token["y"] + token["h"] / 2
        dx = token_cx - x
        dy = token_cy - y
        if dx * dx + dy * dy > (radius * 0.95) ** 2:
            continue
        if token["key"] not in palette_keys:
            continue
        score = abs(dx) + abs(dy) + token["variant"] * 2
        candidates.append((score, token))
    if not candidates:
        return "", ""
    token = min(candidates, key=lambda item: item[0])[1]
    return token["key"], token["text"]


def analyze_crop(crop: dict[str, Any], templates: dict[str, list[np.ndarray]], palette_keys: set[str]) -> dict[str, Any]:
    image = crop["image"]
    tokens = crop["tokens"]
    key_tokens = crop["keyTokens"]
    comps = crop["components"]
    items = []
    skipped = []
    for index, circle in enumerate(crop["circles"], start=1):
        x, y, radius = circle
        color_key, inside_text = read_color_key_from_tokens(key_tokens, circle, palette_keys)
        is_empty = False
        if not color_key and acl.looks_like_mosaic_stat_circle(image, x, y, radius):
            is_empty = True
            skipped.append({"index": index, "reason": "empty_or_stat_circle", "insideText": inside_text, "circle": circle})
            continue
        cv_count, scores = opencv_count_for_circle(circle, comps, templates, image.shape)
        tess_count = tesseract_count_for_circle(image, circle, tokens)
        count_text = cv_count or tess_count
        items.append(
            {
                "index": index,
                "colorKey": color_key,
                "insideText": inside_text,
                "colorKeySource": "circle_inner_tesseract" if color_key else "missing",
                "count": int(count_text) if count_text.isdigit() else None,
                "countText": count_text,
                "countSource": "opencv_components" if cv_count else ("tesseract_fallback" if tess_count else "missing"),
                "opencvCountText": cv_count,
                "tesseractCountText": tess_count,
                "opencvScores": scores,
                "bbox": {"x": x - radius, "y": y - radius, "width": radius * 2, "height": radius * 2},
                "emptyLike": is_empty,
            }
        )
    valid_items = [item for item in items if item["colorKey"] and item["count"] is not None]
    counts: dict[str, int] = defaultdict(int)
    for item in valid_items:
        counts[item["colorKey"]] += int(item["count"])
    return {
        "crop": crop["path"].name,
        "imageId": image_id_from_crop(crop["path"]),
        "imageSize": {"width": int(image.shape[1]), "height": int(image.shape[0])},
        "circleCount": len(crop["circles"]),
        "itemCount": len(valid_items),
        "totalBeads": int(sum(counts.values())),
        "colorCounts": dict(sorted(counts.items(), key=lambda kv: acl.color_key_sort(kv[0]))),
        "items": items,
        "skipped": skipped,
    }


def merge_group(crops: list[dict[str, Any]]) -> dict[str, Any]:
    image_id = crops[0]["imageId"]
    best: dict[str, dict[str, Any]] = {}
    sources: dict[str, list[str]] = defaultdict(list)
    for crop in crops:
        for item in crop["items"]:
            key = item.get("colorKey")
            count = item.get("count")
            if not key or count is None:
                continue
            if key not in best or int(count) > int(best[key]["count"]):
                best[key] = dict(item)
            if crop["crop"] not in sources[key]:
                sources[key].append(crop["crop"])
    for key, item in best.items():
        item["sources"] = sources[key]
    color_counts = {key: int(item["count"]) for key, item in best.items()}
    color_counts = dict(sorted(color_counts.items(), key=lambda kv: acl.color_key_sort(kv[0])))
    return {
        "id": image_id,
        "cropCount": len(crops),
        "totalColorKeys": len(color_counts),
        "totalBeads": int(sum(color_counts.values())),
        "colorCounts": color_counts,
        "items": sorted(best.values(), key=lambda item: acl.color_key_sort(item["colorKey"])),
        "crops": [{"crop": crop["crop"], "itemCount": crop["itemCount"], "totalBeads": crop["totalBeads"]} for crop in crops],
    }


def compare_to_image_info(groups: list[dict[str, Any]]) -> dict[str, Any]:
    if not IMAGE_INFO.exists():
        return {"error": f"Missing {IMAGE_INFO}"}
    old_payload = json.loads(IMAGE_INFO.read_text(encoding="utf-8"))
    old_by_id = {image.get("id"): image for image in old_payload.get("images", []) if isinstance(image, dict)}
    new_by_id = {group["id"]: group for group in groups}
    rows = []
    for image_id in sorted(set(old_by_id) | set(new_by_id), key=acl.natural_key):
        old = old_by_id.get(image_id, {})
        new = new_by_id.get(image_id, {})
        old_counts = old.get("colorCounts", {}) or {}
        new_counts = new.get("colorCounts", {}) or {}
        missing = sorted(set(old_counts) - set(new_counts), key=acl.color_key_sort)
        extra = sorted(set(new_counts) - set(old_counts), key=acl.color_key_sort)
        count_diff = []
        for key in sorted(set(old_counts) & set(new_counts), key=acl.color_key_sort):
            if int(old_counts[key]) != int(new_counts[key]):
                count_diff.append({"colorKey": key, "old": int(old_counts[key]), "new": int(new_counts[key]), "delta": int(new_counts[key]) - int(old_counts[key])})
        rows.append(
            {
                "id": image_id,
                "oldTotalColorKeys": old.get("totalColorKeys"),
                "newTotalColorKeys": new.get("totalColorKeys"),
                "oldTotalBeads": old.get("totalBeads"),
                "newTotalBeads": new.get("totalBeads"),
                "expectedTotalBeads": old.get("expectedTotalBeads"),
                "colorKeyDelta": (new.get("totalColorKeys") or 0) - (old.get("totalColorKeys") or 0),
                "beadDelta": (new.get("totalBeads") or 0) - (old.get("totalBeads") or 0),
                "missingColorKeys": missing,
                "extraColorKeys": extra,
                "countDiffs": count_diff,
                "status": "same" if not missing and not extra and not count_diff else "different",
            }
        )
    return {
        "baseline": str(IMAGE_INFO),
        "newResult": str(OUT_JSON),
        "summary": {
            "same": sum(1 for row in rows if row["status"] == "same"),
            "different": sum(1 for row in rows if row["status"] != "same"),
        },
        "groups": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="", help="Comma-separated Image ids to run, e.g. Image1,Image4.")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    palette = acl.load_mard_palette(acl.DEFAULT_MAPPING_PATH, acl.DEFAULT_PALETTE_SETS_PATH, "291")
    palette_keys = {color.key for color in palette}
    paths = sorted(PREVIEW_DIR.glob("Image*_crop*.png"), key=lambda path: acl.natural_key(path.name))
    if args.only:
        allowed = {part.strip() for part in args.only.split(",") if part.strip()}
        paths = [path for path in paths if image_id_from_crop(path) in allowed]
    if args.limit:
        paths = paths[: args.limit]
    crops = []
    for index, path in enumerate(paths, start=1):
        print(f"[{index}/{len(paths)}] {path.name}", flush=True)
        image = read_image(path)
        circles = detect_preview_circles(image)
        key_box = circle_union_box(image, circles, x_pad_factor=1.25, y_top_factor=1.05, y_bottom_factor=1.05)
        number_box = circle_union_box(image, circles, x_pad_factor=1.45, y_top_factor=0.05, y_bottom_factor=2.65)
        crops.append(
            {
                "path": path,
                "image": image,
                "circles": circles,
                "tokens": read_number_tokens(image, number_box),
                "keyTokens": read_key_tokens(image, key_box),
                "components": digit_components(image),
            }
        )

    templates = build_templates(crops)
    crop_results = [analyze_crop(crop, templates, palette_keys) for crop in crops]
    by_group: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for crop_result in crop_results:
        by_group[crop_result["imageId"]].append(crop_result)
    groups = [merge_group(by_group[image_id]) for image_id in sorted(by_group, key=acl.natural_key)]
    payload = {
        "input": str(PREVIEW_DIR),
        "algorithm": "circle_inner_tesseract_color_key_plus_opencv_component_count",
        "notes": [
            "No circle color matching is used.",
            "Circle color is only consulted by the imported empty/stat-circle heuristic when color-key OCR is missing.",
        ],
        "templateDigits": {digit: len(samples) for digit, samples in sorted(templates.items())},
        "cropCount": len(crop_results),
        "groupCount": len(groups),
        "groups": groups,
        "crops": crop_results,
    }
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    with OUT_CSV.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=["imageId", "crop", "index", "colorKey", "count", "countSource", "opencvCountText", "tesseractCountText", "insideText"])
        writer.writeheader()
        for crop in crop_results:
            for item in crop["items"]:
                writer.writerow(
                    {
                        "imageId": crop["imageId"],
                        "crop": crop["crop"],
                        "index": item["index"],
                        "colorKey": item["colorKey"],
                        "count": item["count"],
                        "countSource": item["countSource"],
                        "opencvCountText": item["opencvCountText"],
                        "tesseractCountText": item["tesseractCountText"],
                        "insideText": item["insideText"],
                    }
                )

    comparison = compare_to_image_info(groups)
    OUT_COMPARE.write_text(json.dumps(comparison, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(OUT_JSON)
    print(OUT_CSV)
    print(OUT_COMPARE)
    print(json.dumps(comparison.get("summary", {}), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
