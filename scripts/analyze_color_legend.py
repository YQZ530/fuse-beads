#!/usr/bin/env python3
"""Read color keys/counts from the bottom legend of Perler bead screenshots."""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image

try:
    import pytesseract
except ImportError:  # pragma: no cover
    pytesseract = None


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
DEFAULT_OUTPUT_DIR = Path("results") / "color-legend"
DEFAULT_MAPPING_PATH = Path("src") / "app" / "colorSystemMapping.json"
DEFAULT_PALETTE_SETS_PATH = Path("src") / "data" / "mardPaletteSets.csv"
DEFAULT_TESSERACT = Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe")


@dataclass
class PaletteColor:
    key: str
    hex: str
    rgb: tuple[int, int, int]
    lab: np.ndarray


@dataclass
class LegendCircle:
    x: int
    y: int
    radius: int
    sampled_rgb: tuple[int, int, int]
    matched_key: str
    matched_hex: str
    match_distance: float
    count: int | None
    count_text: str


@dataclass
class NumberToken:
    x: int
    y: int
    width: int
    height: int
    text: str


@dataclass
class LegendAnalysis:
    circles: list[LegendCircle]
    legend_top: int
    expected_total: int | None
    transparent_count: int | None
    transparent_token: NumberToken | None


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze bottom legend color keys/counts from screenshots.")
    parser.add_argument("input", help="Image file or directory. Example: C:\\Users\\z5308\\Desktop\\batch_pic")
    parser.add_argument("--out", default="", help="Output JSON path.")
    parser.add_argument("--palette", default="291", help="MARD palette set: 96, 144, 291, or all.")
    parser.add_argument("--legend-ratio", type=float, default=0.38, help="Bottom image ratio scanned for legend circles.")
    parser.add_argument("--tesseract", default=str(DEFAULT_TESSERACT), help="Path to tesseract.exe.")
    parser.add_argument("--max-distance", type=float, default=34.0, help="Lab distance above which a color match is uncertain.")
    parser.add_argument("--separate-images", action="store_true", help="Treat files in a folder as separate images instead of pages of one image.")
    parser.add_argument("--debug", action="store_true", help="Write debug images.")
    args = parser.parse_args()

    configure_tesseract(Path(args.tesseract))

    input_path = Path(args.input)
    images = discover_images(input_path)
    if not images:
        raise SystemExit(f"No image files found: {input_path}")

    palette = load_mard_palette(DEFAULT_MAPPING_PATH, DEFAULT_PALETTE_SETS_PATH, args.palette)
    palette_keys = {color.key for color in palette}
    out_path = Path(args.out) if args.out else default_output_path(input_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    page_results = []
    for index, image_path in enumerate(images, start=1):
        image_id = f"p{index}"
        image = read_image(image_path)
        if image is None:
            page_results.append(error_result(image_id, image_path, "Could not read image"))
            continue

        analysis = analyze_image_legend(
            image=image,
            palette=palette,
            legend_ratio=args.legend_ratio,
        )
        result = build_result(image_id, image_path, image, analysis, args.max_distance)
        page_results.append(result)

        if args.debug:
            debug_path = out_path.with_name(f"{out_path.stem}.{image_id}.debug.png")
            write_debug_image(image, analysis.circles, result["legendTop"], debug_path)

    if input_path.is_dir() and not args.separate_images:
        results = [build_merged_folder_result(input_path, page_results)]
        mode = "bottom_legend_multi_page_folder_merge"
    else:
        results = page_results
        mode = "bottom_legend_circle_color_match_plus_count_ocr"

    payload = {
        "input": str(input_path),
        "palette": args.palette,
        "mode": mode,
        "pageCount": len(page_results),
        "imageCount": len(results),
        "images": results,
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(str(out_path))
    return 0


def configure_tesseract(tesseract_path: Path) -> None:
    if pytesseract is None:
        raise SystemExit("pytesseract is not installed. Install it with: python -m pip install pytesseract")
    if tesseract_path.exists():
        pytesseract.pytesseract.tesseract_cmd = str(tesseract_path)


def discover_images(input_path: Path) -> list[Path]:
    if input_path.is_file():
        return [input_path] if input_path.suffix.lower() in IMAGE_EXTENSIONS else []
    return sorted(
        (path for path in input_path.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS),
        key=lambda path: natural_key(path.name),
    )


def default_output_path(input_path: Path) -> Path:
    name = input_path.stem if input_path.is_file() else input_path.name
    return DEFAULT_OUTPUT_DIR / f"{name}.legend.json"


def read_image(path: Path) -> np.ndarray | None:
    raw = np.fromfile(str(path), dtype=np.uint8)
    if raw.size == 0:
        return None
    return cv2.imdecode(raw, cv2.IMREAD_COLOR)


def analyze_image_legend(
    image: np.ndarray,
    palette: list[PaletteColor],
    legend_ratio: float,
) -> LegendAnalysis:
    height, width = image.shape[:2]
    legend_top = int(round(height * (1.0 - clamp(legend_ratio, 0.12, 0.7))))
    raw_circles = detect_circles(image, legend_top)
    number_tokens = read_number_tokens(image, legend_top)
    count_tokens, expected_total, transparent_token = select_legend_count_tokens(number_tokens)
    palette_by_key = {color.key: color for color in palette}
    circles: list[LegendCircle] = []

    for token in count_tokens:
        circle = find_circle_above_token(raw_circles, token)
        if circle is None:
            continue
        x, y, radius = circle
        sampled_rgb = sample_circle_rgb(image, x, y, radius)
        if sampled_rgb is None:
            continue

        matched, distance = match_palette(sampled_rgb, palette)
        matched_key = matched.key
        matched_hex = matched.hex
        if distance > 4.0:
            ocr_key = read_circle_key(image, x, y, radius, set(palette_by_key))
            if ocr_key in palette_by_key:
                matched_key = ocr_key
                matched_hex = palette_by_key[ocr_key].hex
        circles.append(
            LegendCircle(
                x=x,
                y=y,
                radius=radius,
                sampled_rgb=sampled_rgb,
                matched_key=matched_key,
                matched_hex=matched_hex,
                match_distance=distance,
                count=int(token.text),
                count_text=token.text,
            )
        )

    return LegendAnalysis(
        circles=sort_circles_reading_order(circles),
        legend_top=legend_top,
        expected_total=expected_total,
        transparent_count=int(transparent_token.text) if transparent_token else None,
        transparent_token=transparent_token,
    )


def detect_circles(image: np.ndarray, legend_top: int) -> list[tuple[int, int, int]]:
    height, width = image.shape[:2]
    legend = image[legend_top:, :]
    gray = cv2.cvtColor(legend, cv2.COLOR_BGR2GRAY)
    gray = cv2.medianBlur(gray, 5)

    min_radius = max(12, int(round(min(width, height) * 0.012)))
    max_radius = max(min_radius + 8, int(round(min(width, height) * 0.045)))
    min_dist = max(34, int(round(width * 0.038)))
    detected: list[tuple[int, int, int]] = []

    for param2 in (20, 24, 28, 32):
        circles = cv2.HoughCircles(
            gray,
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
        for x, y, radius in np.round(circles[0]).astype(int):
            absolute_y = int(y + legend_top)
            if absolute_y < legend_top + min_radius:
                continue
            if x < radius or x > width - radius:
                continue
            detected.append((int(x), absolute_y, int(radius)))

    return merge_duplicate_circles(detected)


def merge_duplicate_circles(circles: list[tuple[int, int, int]]) -> list[tuple[int, int, int]]:
    merged: list[tuple[int, int, int]] = []
    for circle in sorted(circles, key=lambda item: (item[1], item[0], item[2])):
        x, y, radius = circle
        duplicate_index = None
        for index, (mx, my, mr) in enumerate(merged):
            if math.hypot(x - mx, y - my) <= max(radius, mr) * 0.45:
                duplicate_index = index
                break
        if duplicate_index is None:
            merged.append(circle)
        else:
            mx, my, mr = merged[duplicate_index]
            merged[duplicate_index] = (
                int(round((mx + x) / 2)),
                int(round((my + y) / 2)),
                int(round((mr + radius) / 2)),
            )
    return merged


def sample_circle_rgb(image: np.ndarray, x: int, y: int, radius: int) -> tuple[int, int, int] | None:
    height, width = image.shape[:2]
    samples: list[np.ndarray] = []
    patch = max(3, int(round(radius * 0.18)))
    ring_radius = radius * 0.56

    for angle in np.linspace(0, 2 * math.pi, 16, endpoint=False):
        cx = int(round(x + math.cos(angle) * ring_radius))
        cy = int(round(y + math.sin(angle) * ring_radius))
        x1 = clamp_int(cx - patch, 0, width - 1)
        y1 = clamp_int(cy - patch, 0, height - 1)
        x2 = clamp_int(cx + patch + 1, x1 + 1, width)
        y2 = clamp_int(cy + patch + 1, y1 + 1, height)
        crop = image[y1:y2, x1:x2]
        if crop.size:
            samples.append(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB).reshape(-1, 3))

    if not samples:
        return None

    rgb_pixels = np.concatenate(samples, axis=0)
    median = np.median(rgb_pixels, axis=0)
    return tuple(int(round(value)) for value in median)


def is_non_color_stat_circle(rgb: tuple[int, int, int]) -> bool:
    hsv = cv2.cvtColor(np.array([[list(rgb)]], dtype=np.uint8), cv2.COLOR_RGB2HSV)[0, 0]
    saturation = int(hsv[1])
    value = int(hsv[2])
    return saturation < 16 and value > 210


def read_number_tokens(image: np.ndarray, legend_top: int) -> list[NumberToken]:
    legend = image[legend_top:, :]
    gray = cv2.cvtColor(legend, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    gray = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    config = "--psm 6 -c tessedit_char_whitelist=0123456789"
    try:
        data = pytesseract.image_to_data(Image.fromarray(gray), config=config, output_type=pytesseract.Output.DICT)
    except Exception:
        return []

    tokens: list[NumberToken] = []
    for index, raw_text in enumerate(data.get("text", [])):
        text = digits_only(raw_text)
        if not text:
            continue
        left = int(round(data["left"][index] / 2))
        top = int(round(data["top"][index] / 2)) + legend_top
        width = int(round(data["width"][index] / 2))
        height = int(round(data["height"][index] / 2))
        if len(text) > 4 or height < 10 or width < 3:
            continue
        tokens.append(NumberToken(left, top, width, height, text))
    return tokens


def select_legend_count_tokens(tokens: list[NumberToken]) -> tuple[list[NumberToken], int | None, NumberToken | None]:
    rows = group_number_rows(tokens)
    if not rows:
        return [], None, None

    bottom_row = rows[-1]
    total_token = max(bottom_row, key=lambda token: token.x)
    expected_total = int(total_token.text)
    transparent_token = find_transparent_token(bottom_row, total_token, expected_total)
    selected: list[NumberToken] = []
    running_total = 0

    for row_index in range(len(rows) - 1, -1, -1):
        row = sorted(rows[row_index], key=lambda token: token.x)
        row_candidates: list[NumberToken] = []
        for token in row:
            if token is total_token:
                continue
            if token is transparent_token:
                continue
            value = int(token.text)
            if value > expected_total:
                continue
            row_candidates.append(token)

        row_sum = sum(int(token.text) for token in row_candidates)
        if running_total + row_sum <= expected_total:
            selected.extend(row_candidates)
            running_total += row_sum
        else:
            remaining = expected_total - running_total
            selected.extend(select_row_subset(row_candidates, remaining))
            running_total = expected_total

        if running_total == expected_total:
            break

    if len(selected) < 2:
        fallback, fallback_transparent = select_single_row_fallback(rows)
        if fallback:
            selected = fallback
            expected_total = sum(int(token.text) for token in selected)
            transparent_token = fallback_transparent

    selected.sort(key=lambda token: (token.y, token.x))
    return selected, expected_total, transparent_token


def find_transparent_token(row: list[NumberToken], total_token: NumberToken, expected_total: int) -> NumberToken | None:
    left_tokens = [token for token in row if token is not total_token and token.x < total_token.x]
    if not left_tokens:
        return None
    candidate = max(left_tokens, key=lambda token: token.x)
    value = int(candidate.text)
    if value > expected_total:
        return candidate
    return None


def select_single_row_fallback(rows: list[list[NumberToken]]) -> tuple[list[NumberToken], NumberToken | None]:
    for row in reversed(rows):
        candidates = [token for token in row if 0 < int(token.text) <= 999]
        if len(candidates) >= 3:
            transparent_candidates = [token for token in row if int(token.text) > 999]
            transparent_token = max(transparent_candidates, key=lambda token: int(token.text), default=None)
            return candidates, transparent_token
    return [], None


def group_number_rows(tokens: list[NumberToken]) -> list[list[NumberToken]]:
    rows: list[list[NumberToken]] = []
    for token in sorted(tokens, key=lambda item: item.y):
        for row in rows:
            if abs(token.y - np.median([item.y for item in row])) <= 24:
                row.append(token)
                break
        else:
            rows.append([token])
    return [sorted(row, key=lambda item: item.x) for row in rows if row]


def select_row_subset(tokens: list[NumberToken], target: int) -> list[NumberToken]:
    if target <= 0:
        return []
    dp: dict[int, tuple[int, list[NumberToken]]] = {0: (0, [])}
    for token in tokens:
        value = int(token.text)
        for current_sum, (count, subset) in list(dp.items()):
            next_sum = current_sum + value
            if next_sum > target:
                continue
            next_subset = subset + [token]
            current = dp.get(next_sum)
            if current is None or count + 1 > current[0]:
                dp[next_sum] = (count + 1, next_subset)
    return dp.get(target, (0, []))[1]


def find_circle_above_token(circles: list[tuple[int, int, int]], token: NumberToken) -> tuple[int, int, int] | None:
    token_cx = token.x + token.width / 2
    token_cy = token.y + token.height / 2
    candidates: list[tuple[float, tuple[int, int, int]]] = []
    for x, y, radius in circles:
        dx = abs(token_cx - x)
        dy = token_cy - y
        if dx > max(radius * 1.7, 46):
            continue
        if dy < radius * 0.75 or dy > radius * 2.15:
            continue
        if radius < 20 or radius > 48:
            continue
        score = dx + abs(dy - radius * 1.35) * 0.5
        candidates.append((score, (x, y, radius)))
    if not candidates:
        return None
    return min(candidates, key=lambda item: item[0])[1]


def read_circle_key(image: np.ndarray, x: int, y: int, radius: int, palette_keys: set[str]) -> str:
    crop = crop_box(image, x, y, int(radius * 1.2), int(radius * 0.95))
    if crop.size == 0:
        return ""
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
    variants = [
        cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1],
        cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1],
    ]
    config = "--psm 8 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    for variant in variants:
        try:
            text = pytesseract.image_to_string(Image.fromarray(variant), config=config)
        except Exception:
            continue
        key = normalize_key_text(text)
        if key in palette_keys:
            return key
    return ""


def crop_box(image: np.ndarray, x: int, y: int, half_width: int, half_height: int) -> np.ndarray:
    height, width = image.shape[:2]
    return image[
        clamp_int(y - half_height, 0, height - 1):clamp_int(y + half_height + 1, 1, height),
        clamp_int(x - half_width, 0, width - 1):clamp_int(x + half_width + 1, 1, width),
    ]


def normalize_key_text(text: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9]", "", text).upper()
    match = re.search(r"([A-Z]{1,3})(\d{1,2})", clean)
    return match.group(1) + match.group(2) if match else clean


def digits_only(text: str) -> str:
    return re.sub(r"\D", "", text)


def sort_circles_reading_order(circles: list[LegendCircle]) -> list[LegendCircle]:
    if not circles:
        return []
    radii = [circle.radius for circle in circles]
    row_tolerance = max(18, int(round(np.median(radii) * 1.35)))
    rows: list[list[LegendCircle]] = []
    for circle in sorted(circles, key=lambda item: item.y):
        for row in rows:
            if abs(circle.y - np.median([item.y for item in row])) <= row_tolerance:
                row.append(circle)
                break
        else:
            rows.append([circle])
    ordered: list[LegendCircle] = []
    for row in sorted(rows, key=lambda items: np.median([item.y for item in items])):
        ordered.extend(sorted(row, key=lambda item: item.x))
    return ordered


def build_result(
    image_id: str,
    image_path: Path,
    image: np.ndarray,
    analysis: LegendAnalysis,
    max_distance: float,
) -> dict[str, Any]:
    circles = analysis.circles
    grouped: dict[str, list[LegendCircle]] = defaultdict(list)
    for circle in circles:
        if circle.count is None:
            continue
        grouped[circle.matched_key].append(circle)

    rows: list[dict[str, Any]] = []
    for key, items in grouped.items():
        count = sum(item.count or 0 for item in items)
        best = min(items, key=lambda item: item.match_distance)
        rows.append(
            {
                "colorKey": key,
                "count": count,
                "hex": best.matched_hex,
                "sampledRgb": list(best.sampled_rgb),
                "distance": round(best.match_distance, 3),
                "uncertain": best.match_distance > max_distance,
                "countSource": "ocr",
            }
        )

    rows.sort(key=lambda row: (-int(row["count"]), color_key_sort(str(row["colorKey"]))))
    color_counts = {row["colorKey"]: row["count"] for row in rows}
    color_total = sum(int(row["count"]) for row in rows)
    transparent_count = analysis.transparent_count
    counts_with_transparent = dict(color_counts)
    entries_with_transparent = list(rows)
    if transparent_count is not None:
        counts_with_transparent["transparent"] = transparent_count
        entries_with_transparent.append(
            {
                "colorKey": "transparent",
                "count": transparent_count,
                "hex": None,
                "sampledRgb": None,
                "distance": None,
                "uncertain": False,
                "countSource": "ocr",
            }
        )
    entries_with_transparent.sort(key=lambda row: (-int(row["count"]), color_key_sort(str(row["colorKey"]))))

    return {
        "id": image_id,
        "source": str(image_path),
        "analysisMethod": "bottom_legend_circle_color_match_plus_count_ocr",
        "imageSize": {"width": int(image.shape[1]), "height": int(image.shape[0])},
        "legendTop": analysis.legend_top,
        "totalColorKeys": len(rows),
        "totalBeads": color_total,
        "expectedTotalBeads": analysis.expected_total,
        "transparentCount": transparent_count,
        "totalCellsWithTransparent": color_total + transparent_count if transparent_count is not None else None,
        "validation": {
            "colorCountsEqualFullTotal": analysis.expected_total is not None and color_total == analysis.expected_total,
            "colorTotal": color_total,
            "fullTotalFromLegend": analysis.expected_total,
            "transparentCount": transparent_count,
            "colorPlusTransparent": color_total + transparent_count if transparent_count is not None else None,
        },
        "colorCounts": color_counts,
        "countsWithTransparent": counts_with_transparent,
        "colors": rows,
        "entriesWithTransparent": entries_with_transparent,
        "legendItems": [
            {
                "colorKey": circle.matched_key,
                "count": circle.count,
                "countText": circle.count_text,
                "matchedHex": circle.matched_hex,
                "sampledRgb": list(circle.sampled_rgb),
                "distance": round(circle.match_distance, 3),
                "bbox": {
                    "x": circle.x - circle.radius,
                    "y": circle.y - circle.radius,
                    "width": circle.radius * 2,
                    "height": circle.radius * 2,
                },
            }
            for circle in circles
        ],
        "specialItems": {
            "transparent": {
                "count": transparent_count,
                "countText": analysis.transparent_token.text if analysis.transparent_token else "",
                "source": "ocr" if analysis.transparent_token else "missing",
                "bbox": {
                    "x": analysis.transparent_token.x,
                    "y": analysis.transparent_token.y,
                    "width": analysis.transparent_token.width,
                    "height": analysis.transparent_token.height,
                } if analysis.transparent_token else None,
            },
            "full": {
                "count": analysis.expected_total,
                "source": "ocr_or_fallback",
            },
        },
    }


def build_merged_folder_result(input_path: Path, page_results: list[dict[str, Any]]) -> dict[str, Any]:
    best_colors: dict[str, dict[str, Any]] = {}
    sources_by_key: dict[str, list[str]] = defaultdict(list)
    pages: list[dict[str, Any]] = []

    for page in page_results:
        pages.append({
            "id": page.get("id"),
            "source": page.get("source"),
            "totalColorKeys": page.get("totalColorKeys", 0),
            "totalBeads": page.get("totalBeads", 0),
            "expectedTotalBeads": page.get("expectedTotalBeads"),
            "transparentCount": page.get("transparentCount"),
            "validation": page.get("validation", {}),
        })
        for row in page.get("colors", []):
            key = str(row.get("colorKey", ""))
            if not key:
                continue
            count = int(row.get("count") or 0)
            current = best_colors.get(key)
            if current is None or count > int(current.get("count") or 0):
                best_colors[key] = dict(row)
            source = str(page.get("source", ""))
            if source and source not in sources_by_key[key]:
                sources_by_key[key].append(source)

    rows = list(best_colors.values())
    rows.sort(key=lambda row: (-int(row["count"]), color_key_sort(str(row["colorKey"]))))
    for row in rows:
        row["sources"] = sources_by_key.get(str(row["colorKey"]), [])

    color_counts = {row["colorKey"]: row["count"] for row in rows}
    color_total = sum(int(row["count"]) for row in rows)
    expected_total = max(
        (int(page["expectedTotalBeads"]) for page in page_results if page.get("expectedTotalBeads") is not None),
        default=None,
    )
    transparent_count = max(
        (int(page["transparentCount"]) for page in page_results if page.get("transparentCount") is not None),
        default=None,
    )

    counts_with_transparent = dict(color_counts)
    entries_with_transparent = list(rows)
    if transparent_count is not None:
        counts_with_transparent["transparent"] = transparent_count
        entries_with_transparent.append({
            "colorKey": "transparent",
            "count": transparent_count,
            "hex": None,
            "sampledRgb": None,
            "distance": None,
            "uncertain": False,
            "countSource": "ocr",
            "sources": [page["source"] for page in pages if page.get("transparentCount") == transparent_count],
        })
    entries_with_transparent.sort(key=lambda row: (-int(row["count"]), color_key_sort(str(row["colorKey"]))))

    return {
        "id": input_path.name or "merged",
        "source": str(input_path),
        "analysisMethod": "bottom_legend_multi_page_folder_merge",
        "pageCount": len(page_results),
        "sourceImages": [str(page.get("source", "")) for page in page_results],
        "totalColorKeys": len(rows),
        "totalBeads": color_total,
        "expectedTotalBeads": expected_total,
        "transparentCount": transparent_count,
        "totalCellsWithTransparent": color_total + transparent_count if transparent_count is not None else None,
        "validation": {
            "colorCountsEqualFullTotal": expected_total is not None and color_total == expected_total,
            "colorTotal": color_total,
            "fullTotalFromLegend": expected_total,
            "transparentCount": transparent_count,
            "colorPlusTransparent": color_total + transparent_count if transparent_count is not None else None,
            "dedupeRule": "same colorKey across pages keeps the largest count",
        },
        "colorCounts": color_counts,
        "countsWithTransparent": counts_with_transparent,
        "colors": rows,
        "entriesWithTransparent": entries_with_transparent,
        "pages": page_results,
    }


def error_result(image_id: str, image_path: Path, error: str) -> dict[str, Any]:
    return {
        "id": image_id,
        "source": str(image_path),
        "error": error,
        "totalColorKeys": 0,
        "totalBeads": 0,
        "colorCounts": {},
        "colors": [],
        "legendItems": [],
    }


def write_debug_image(image: np.ndarray, circles: list[LegendCircle], legend_top: int, path: Path) -> None:
    debug = image.copy()
    cv2.line(debug, (0, legend_top), (image.shape[1] - 1, legend_top), (255, 0, 255), 2)
    for circle in circles:
        color = (0, 255, 0) if circle.count is not None else (0, 180, 255)
        cv2.circle(debug, (circle.x, circle.y), circle.radius, color, 2)
        label = f"{circle.matched_key}:{circle.count_text or '?'}"
        cv2.putText(debug, label, (circle.x - circle.radius, max(16, circle.y - circle.radius - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 255), 2, cv2.LINE_AA)
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imencode(".png", debug)[1].tofile(str(path))


def match_palette(rgb: tuple[int, int, int], palette: list[PaletteColor]) -> tuple[PaletteColor, float]:
    lab = rgb_to_lab(rgb)
    best = min(palette, key=lambda color: float(np.linalg.norm(lab - color.lab)))
    return best, float(np.linalg.norm(lab - best.lab))


def load_mard_palette(mapping_path: Path, palette_sets_path: Path, palette_name: str) -> list[PaletteColor]:
    mapping = json.loads(mapping_path.read_text(encoding="utf-8-sig"))
    allowed_keys = None
    if palette_name.lower() != "all":
        allowed_keys = read_palette_keys(palette_sets_path, "MARD", palette_name)

    colors: list[PaletteColor] = []
    for hex_value, systems in mapping.items():
        key = systems.get("MARD") if isinstance(systems, dict) else None
        if not key:
            continue
        if allowed_keys is not None and key not in allowed_keys:
            continue
        rgb = hex_to_rgb(hex_value)
        colors.append(PaletteColor(key=key, hex=hex_value.upper(), rgb=rgb, lab=rgb_to_lab(rgb)))

    if not colors:
        raise SystemExit(f"No MARD colors loaded for palette {palette_name}")
    return colors


def read_palette_keys(path: Path, brand: str, palette_name: str) -> set[str]:
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    header = parse_csv_line(lines[0])
    brand_index = header.index("brand")
    palette_index = header.index("paletteName")
    codes_index = header.index("colorCodes")
    for line in lines[1:]:
        cells = parse_csv_line(line)
        if cells[brand_index] == brand and cells[palette_index] == palette_name:
            return set(cells[codes_index].strip().split())
    raise SystemExit(f"Palette set not found: {brand} {palette_name}")


def parse_csv_line(line: str) -> list[str]:
    values: list[str] = []
    current = []
    in_quotes = False
    for char in line:
        if char == '"':
            in_quotes = not in_quotes
        elif char == "," and not in_quotes:
            values.append("".join(current))
            current = []
        else:
            current.append(char)
    values.append("".join(current))
    return values


def hex_to_rgb(hex_value: str) -> tuple[int, int, int]:
    clean = hex_value.strip().lstrip("#")
    return int(clean[0:2], 16), int(clean[2:4], 16), int(clean[4:6], 16)


def rgb_to_lab(rgb: tuple[int, int, int]) -> np.ndarray:
    sample = np.array([[list(rgb)]], dtype=np.uint8)
    return cv2.cvtColor(sample, cv2.COLOR_RGB2LAB).astype(np.float32)[0, 0]


def natural_key(value: str) -> list[Any]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value)]


def color_key_sort(key: str) -> tuple[str, int, str]:
    match = re.match(r"([A-Za-z]+)\s*0*(\d+)", key)
    if not match:
        return key.upper(), math.inf, key
    return match.group(1).upper(), int(match.group(2)), key


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def clamp_int(value: int, minimum: int, maximum: int) -> int:
    return min(maximum, max(minimum, value))


if __name__ == "__main__":
    raise SystemExit(main())
