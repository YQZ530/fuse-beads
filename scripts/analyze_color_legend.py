#!/usr/bin/env python3
"""Read color keys/counts from the bottom legend of Perler bead screenshots."""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
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
DETAIL_PAGE = "detail_page"
COLOR_MODAL = "color_modal"


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
    inside_text: str = ""
    color_key_source: str = "palette_match"
    special_key: str = ""


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


def log(message: str) -> None:
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{timestamp}] {message}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze bottom legend color keys/counts from screenshots.")
    parser.add_argument("input", nargs="?", help="Image file or directory. Example: C:\\Users\\z5308\\Desktop\\batch_pic")
    parser.add_argument("--out", default="", help="Output JSON path.")
    parser.add_argument("--manifest", default="", help="groups.manifest.json from group_similar_pattern_images.py.")
    parser.add_argument("--palette", default="291", help="MARD palette set: 96, 144, 291, or all.")
    parser.add_argument("--legend-ratio", type=float, default=0.38, help="Bottom image ratio scanned for legend circles.")
    parser.add_argument("--tesseract", default=str(DEFAULT_TESSERACT), help="Path to tesseract.exe.")
    parser.add_argument("--max-distance", type=float, default=34.0, help="Lab distance above which a color match is uncertain.")
    parser.add_argument("--separate-images", action="store_true", help="Treat files in a folder as separate images instead of pages of one image.")
    parser.add_argument("--debug", action="store_true", help="Write debug images.")
    args = parser.parse_args()

    configure_tesseract(Path(args.tesseract))

    palette = load_mard_palette(DEFAULT_MAPPING_PATH, DEFAULT_PALETTE_SETS_PATH, args.palette)

    if args.manifest:
        manifest_path = Path(args.manifest)
        out_path = Path(args.out) if args.out else default_output_path(manifest_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        payload = analyze_manifest_groups(manifest_path, palette, args.max_distance)
        out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        log(f"Wrote grouped color analysis: {out_path}")
        print(str(out_path))
        return 0

    if not args.input:
        raise SystemExit("Input image/directory is required unless --manifest is provided.")

    input_path = Path(args.input)
    images = discover_images(input_path)
    if not images:
        raise SystemExit(f"No image files found: {input_path}")

    palette_keys = {color.key for color in palette}
    out_path = Path(args.out) if args.out else default_output_path(input_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    page_results = []
    for index, image_path in enumerate(images, start=1):
        image_id = f"p{index}"
        log(f"[{index}/{len(images)}] analyzing legend: {image_path}")
        image = read_image(image_path)
        if image is None:
            page_results.append(error_result(image_id, image_path, "Could not read image"))
            log(f"[{index}/{len(images)}] ERROR could not read: {image_path}")
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
    legend_box = choose_bottom_legend_rect(image)
    if legend_box is None:
        legend_top = int(round(height * (1.0 - clamp(legend_ratio, 0.12, 0.7))))
        log("WARNING detail_page legend rectangle not found; falling back to bottom-ratio crop")
        raw_circles = detect_circles(image, legend_top)
        number_tokens = read_number_tokens(image, legend_top)
    else:
        legend_top = legend_box[1]
        raw_circles = detect_circles_in_box(image, legend_box)
        number_tokens = read_number_tokens_in_box(image, legend_box)
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
        ocr_key = ""
        inside_text = ""
        special_key = ""
        mosaic_stat_circle = looks_like_mosaic_stat_circle(image, x, y, radius)
        if mosaic_stat_circle or distance > 4.0:
            ocr_key, inside_text = read_circle_key(image, x, y, radius, set(palette_by_key))
            if ocr_key not in palette_by_key:
                if mosaic_stat_circle:
                    continue
        if distance > 4.0:
            special_key = special_circle_key(inside_text)
            if special_key:
                continue
            if ocr_key in palette_by_key:
                matched_key = ocr_key
                matched_hex = palette_by_key[ocr_key].hex
        count_text = read_count_below_circle(image, x, y, radius) or token.text
        circles.append(
            LegendCircle(
                x=x,
                y=y,
                radius=radius,
                sampled_rgb=sampled_rgb,
                matched_key=matched_key,
                matched_hex=matched_hex,
                match_distance=distance,
                count=int(count_text),
                count_text=count_text,
                inside_text=inside_text or ocr_key,
                special_key=special_key,
            )
        )

    return LegendAnalysis(
        circles=sort_circles_reading_order(circles),
        legend_top=legend_top,
        expected_total=expected_total,
        transparent_count=int(transparent_token.text) if transparent_token else None,
        transparent_token=transparent_token,
    )


def analyze_manifest_groups(
    manifest_path: Path,
    palette: list[PaletteColor],
    max_distance: float,
) -> dict[str, Any]:
    if not manifest_path.exists():
        raise SystemExit(f"Manifest not found: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    groups = manifest.get("groups", [])
    if not isinstance(groups, list):
        raise SystemExit(f"Manifest has no groups array: {manifest_path}")

    log(f"Loaded manifest: {manifest_path}")
    log(f"Found {len(groups)} grouped image(s).")

    results = []
    analyzed_count = 0
    error_count = 0
    for index, group in enumerate(groups, start=1):
        result = analyze_manifest_group(index, len(groups), group, palette, max_distance)
        results.append(result)
        if result.get("error"):
            error_count += 1
        else:
            analyzed_count += 1

    if analyzed_count == 0:
        raise SystemExit("No groups contained detail_page or color_modal images to analyze.")

    return {
        "input": str(manifest_path),
        "palette": "manifest",
        "mode": "grouped_manifest_color_legend_analysis",
        "sourceManifest": {
            "input": manifest.get("input"),
            "output": manifest.get("output"),
            "groupCount": manifest.get("groupCount"),
            "imageCount": manifest.get("imageCount"),
        },
        "groupCount": len(groups),
        "analyzedGroupCount": analyzed_count,
        "errorGroupCount": error_count,
        "images": results,
    }


def analyze_manifest_group(
    index: int,
    total: int,
    group: dict[str, Any],
    palette: list[PaletteColor],
    max_distance: float,
) -> dict[str, Any]:
    group_name = str(group.get("groupName") or group.get("folderName") or group.get("id") or f"group_{index}")
    items = [item for item in group.get("items", []) if isinstance(item, dict)]
    available_types = sorted({str(item.get("pageType") or "") for item in items if item.get("pageType")})
    detail_items = [item for item in items if item.get("pageType") == DETAIL_PAGE]
    modal_items = [item for item in items if item.get("pageType") == COLOR_MODAL]
    selected_items = detail_items if detail_items else modal_items
    source_type = DETAIL_PAGE if detail_items else COLOR_MODAL if modal_items else ""

    log(f"[{index}/{total}] group {group_name}: available pageTypes={available_types or ['none']}")
    if not selected_items:
        message = f"group {group_name} has no detail_page or color_modal image"
        log(f"[{index}/{total}] ERROR {message}")
        return {
            "id": group_name,
            "source": group_name,
            "groupName": group_name,
            "analysisMethod": "grouped_manifest_color_legend_analysis",
            "analysisStatus": "error_no_detail_or_color_modal",
            "availablePageTypes": available_types,
            "error": message,
            "totalColorKeys": 0,
            "totalBeads": 0,
            "colorCounts": {},
            "colors": [],
            "legendItems": [],
            "pages": [],
        }

    log(f"[{index}/{total}] group {group_name}: using {len(selected_items)} {source_type} image(s).")
    page_results = []
    for page_index, item in enumerate(selected_items, start=1):
        source = Path(str(item.get("source") or ""))
        image_id = f"{group_name}_p{page_index}"
        log(f"[{index}/{total}] group {group_name}: analyzing {source_type} {source.name}")
        image = read_image(source)
        if image is None:
            log(f"[{index}/{total}] ERROR group {group_name}: could not read {source}")
            page_results.append(error_result(image_id, source, "Could not read image"))
            continue
        if source_type == COLOR_MODAL:
            analysis = analyze_color_modal(image, palette)
            result = build_result(image_id, source, image, analysis, max_distance)
            result["analysisMethod"] = "color_modal_circle_key_plus_count_ocr"
        else:
            analysis = analyze_image_legend(image, palette, legend_ratio=0.38)
            if len(selected_items) > 1:
                removed = drop_incomplete_detail_edge_circles(analysis, image, page_index)
                if removed:
                    edge = "right" if page_index == 1 else "left"
                    log(f"[{index}/{total}] group {group_name}: dropped {removed} incomplete {edge}-edge circle(s) from {source.name}")
            result = build_result(image_id, source, image, analysis, max_distance)
        result["groupName"] = group_name
        result["sourcePageType"] = source_type
        page_results.append(result)

    merged = build_merged_group_result(group_name, group, page_results)
    merged["analysisStatus"] = f"analyzed_from_{source_type}"
    merged["sourcePageType"] = source_type
    merged["availablePageTypes"] = available_types
    if int(merged.get("totalColorKeys") or 0) == 0:
        message = f"group {group_name} produced no color entries from {source_type}"
        log(f"[{index}/{total}] ERROR {message}")
        merged["analysisStatus"] = "error_no_colors_extracted"
        merged["error"] = message
    return merged


def drop_incomplete_detail_edge_circles(analysis: LegendAnalysis, image: np.ndarray, page_index: int) -> int:
    box = choose_bottom_legend_rect(image)
    if box is None:
        return 0
    x, _y, w, _h = box
    margin = max(4, int(round(w * 0.004)))
    before = len(analysis.circles)
    if page_index == 1:
        right_edge = x + w
        analysis.circles = [
            circle for circle in analysis.circles
            if circle.x + circle.radius < right_edge - margin
        ]
    else:
        left_edge = x
        analysis.circles = [
            circle for circle in analysis.circles
            if circle.x - circle.radius > left_edge + margin
        ]
    return before - len(analysis.circles)


def build_merged_group_result(group_name: str, group: dict[str, Any], page_results: list[dict[str, Any]]) -> dict[str, Any]:
    merged = build_merged_folder_result(Path(group_name), page_results)
    merged["id"] = group_name
    merged["source"] = group_name
    merged["groupName"] = group_name
    merged["groupCount"] = group.get("count")
    merged["analysisMethod"] = "grouped_manifest_color_legend_analysis"
    return merged


def analyze_color_modal(image: np.ndarray, palette: list[PaletteColor]) -> LegendAnalysis:
    box = find_modal_box(image)
    if box is None:
        log("ERROR color_modal parser could not locate modal panel")
        return LegendAnalysis(circles=[], legend_top=0, expected_total=None, transparent_count=None, transparent_token=None)

    raw_circles = detect_modal_circles(image, box)
    number_tokens = read_modal_number_tokens(image, box)
    palette_by_key = {color.key: color for color in palette}
    circles: list[LegendCircle] = []

    for x, y, radius in raw_circles:
        sampled_rgb = sample_circle_rgb(image, x, y, radius)
        if sampled_rgb is None:
            continue
        matched, distance = match_palette(sampled_rgb, palette)
        matched_key = matched.key
        matched_hex = matched.hex
        inside_key, inside_text = read_circle_key(image, x, y, radius, set(palette_by_key))
        special_key = special_circle_key(inside_text)
        if special_key:
            continue
        color_key_source = "palette_match"
        if inside_key in palette_by_key:
            matched_key = inside_key
            matched_hex = palette_by_key[inside_key].hex
            color_key_source = "inside_ocr"
        token = find_count_below_circle(number_tokens, (x, y, radius))
        count_text = token.text if token else read_count_below_circle(image, x, y, radius)
        circles.append(
            LegendCircle(
                x=x,
                y=y,
                radius=radius,
                sampled_rgb=sampled_rgb,
                matched_key=matched_key,
                matched_hex=matched_hex,
                match_distance=distance,
                count=int(count_text) if count_text else None,
                count_text=count_text,
                inside_text=inside_text or inside_key,
                color_key_source=color_key_source,
                special_key=special_key,
            )
        )

    expected_total = sum(circle.count or 0 for circle in circles) if circles else None
    return LegendAnalysis(
        circles=sort_circles_reading_order(circles),
        legend_top=box[1],
        expected_total=expected_total,
        transparent_count=None,
        transparent_token=None,
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


def choose_bottom_legend_rect(image: np.ndarray) -> tuple[int, int, int, int] | None:
    rects = bottom_white_rects(image)
    if not rects:
        return None
    height, width = image.shape[:2]
    for x, y, w, h, _area in rects:
        if w > width * 0.45 and y > height * 0.62:
            return (x, y, w, h)
    x, y, w, h, _area = max(rects, key=lambda rect: rect[4])
    return (x, y, w, h)


def bottom_white_rects(image: np.ndarray) -> list[tuple[int, int, int, int, int]]:
    height, width = image.shape[:2]
    search_top = int(height * (0.50 if height > width else 0.55))
    roi = image[search_top:height, :]
    if roi.size == 0:
        return []
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    mask = (gray > 242).astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(35, width // 35), max(11, height // 150)))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    rects: list[tuple[int, int, int, int, int]] = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        y += search_top
        area = w * h
        if w > width * 0.18 and h > height * 0.012 and area > width * height * 0.004:
            rects.append((x, y, w, h, area))
    return sorted(rects, key=lambda rect: (rect[1], -rect[4]))


def detect_circles_in_box(image: np.ndarray, box: tuple[int, int, int, int]) -> list[tuple[int, int, int]]:
    x, y, w, h = box
    crop = image[y:y + h, x:x + w]
    if crop.size == 0:
        return []
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    gray = cv2.medianBlur(gray, 5)

    height, width = image.shape[:2]
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
        for cx, cy, radius in np.round(circles[0]).astype(int):
            absolute_x = int(cx + x)
            absolute_y = int(cy + y)
            if absolute_y < y + min_radius:
                continue
            detected.append((absolute_x, absolute_y, int(radius)))

    return merge_duplicate_circles(detected)


def find_modal_box(image: np.ndarray) -> tuple[int, int, int, int] | None:
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    mask = (gray > 245).astype(np.uint8) * 255
    kernel = np.ones((15, 15), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates: list[tuple[int, int, int, int]] = []
    page_area = height * width
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = w * h
        if page_area * 0.12 <= area <= page_area * 0.85 and w > width * 0.45 and h > height * 0.25:
            candidates.append((x, y, w, h))
    if not candidates:
        return None
    return max(candidates, key=lambda item: item[2] * item[3])


def detect_modal_circles(image: np.ndarray, box: tuple[int, int, int, int]) -> list[tuple[int, int, int]]:
    x, y, w, h = box
    content_top = y + int(h * 0.12)
    content_bottom = y + int(h * 0.72)
    content = image[content_top:content_bottom, x:x + w]
    if content.size == 0:
        return []

    gray = cv2.cvtColor(content, cv2.COLOR_BGR2GRAY)
    gray = cv2.medianBlur(gray, 5)
    min_radius = max(20, int(round(min(w, h) * 0.018)))
    max_radius = max(min_radius + 8, int(round(min(w, h) * 0.045)))
    min_dist = max(70, int(round(w * 0.10)))
    detected: list[tuple[int, int, int]] = []

    for param2 in (18, 22, 26, 30):
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
        for cx, cy, radius in np.round(circles[0]).astype(int):
            absolute_x = int(cx + x)
            absolute_y = int(cy + content_top)
            if absolute_x < x + radius or absolute_x > x + w - radius:
                continue
            if absolute_y < content_top + radius or absolute_y > content_bottom - radius:
                continue
            detected.append((absolute_x, absolute_y, int(radius)))

    return merge_duplicate_circles(detected)


def read_modal_number_tokens(image: np.ndarray, box: tuple[int, int, int, int]) -> list[NumberToken]:
    x, y, w, h = box
    content_top = y + int(h * 0.12)
    content_bottom = y + int(h * 0.72)
    crop = image[content_top:content_bottom, x:x + w]
    if crop.size == 0:
        return []

    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
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
        left = int(round(data["left"][index] / 2)) + x
        top = int(round(data["top"][index] / 2)) + content_top
        width = int(round(data["width"][index] / 2))
        height = int(round(data["height"][index] / 2))
        if len(text) > 4 or height < 8 or width < 3:
            continue
        tokens.append(NumberToken(left, top, width, height, text))
    return tokens


def find_count_below_circle(tokens: list[NumberToken], circle: tuple[int, int, int]) -> NumberToken | None:
    x, y, radius = circle
    candidates: list[tuple[float, NumberToken]] = []
    for token in tokens:
        token_cx = token.x + token.width / 2
        token_cy = token.y + token.height / 2
        dx = abs(token_cx - x)
        dy = token_cy - y
        if dx > max(radius * 1.35, 44):
            continue
        if dy < radius * 0.75 or dy > radius * 2.35:
            continue
        score = dx + abs(dy - radius * 1.55) * 0.5
        candidates.append((score, token))
    if not candidates:
        return None
    return min(candidates, key=lambda item: item[0])[1]


def read_count_below_circle(image: np.ndarray, x: int, y: int, radius: int) -> str:
    crop = crop_box(image, x, y + int(radius * 1.55), int(radius * 1.55), int(radius * 0.55))
    if crop.size == 0:
        return ""
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
    variants = [
        cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1],
        cv2.threshold(gray, 185, 255, cv2.THRESH_BINARY)[1],
        cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1],
    ]
    config = "--psm 7 -c tessedit_char_whitelist=0123456789"
    candidates: list[str] = []
    for variant in variants:
        try:
            text = pytesseract.image_to_string(Image.fromarray(variant), config=config)
        except Exception:
            continue
        digits = digits_only(text)
        if 1 <= len(digits) <= 4:
            candidates.append(digits)
    if not candidates:
        return ""
    return max(candidates, key=lambda value: (len(value), int(value)))


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


def looks_like_mosaic_stat_circle(image: np.ndarray, x: int, y: int, radius: int) -> bool:
    crop = crop_box(image, x, y, int(radius * 0.86), int(radius * 0.86))
    if crop.size == 0:
        return False
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape[:2]
    yy, xx = np.ogrid[:height, :width]
    cx = (width - 1) / 2.0
    cy = (height - 1) / 2.0
    mask_radius = min(width, height) * 0.46
    mask = (xx - cx) ** 2 + (yy - cy) ** 2 <= mask_radius ** 2
    pixels = gray[mask]
    if pixels.size < 50:
        return False

    white_ratio = float(np.mean(pixels > 245))
    light_gray_ratio = float(np.mean((pixels >= 185) & (pixels <= 238)))
    dark_ratio = float(np.mean(pixels < 90))
    stddev = float(np.std(pixels))

    edges = cv2.Canny(gray, 60, 140)
    edge_ratio = float(np.mean(edges[mask] > 0))
    return (
        white_ratio >= 0.18
        and light_gray_ratio >= 0.18
        and stddev >= 22.0
        and edge_ratio >= 0.035
        and dark_ratio <= 0.22
    )


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


def read_number_tokens_in_box(image: np.ndarray, box: tuple[int, int, int, int]) -> list[NumberToken]:
    x, y, w, h = box
    crop = image[y:y + h, x:x + w]
    if crop.size == 0:
        return []
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
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
        left = int(round(data["left"][index] / 2)) + x
        top = int(round(data["top"][index] / 2)) + y
        width = int(round(data["width"][index] / 2))
        height = int(round(data["height"][index] / 2))
        if len(text) > 4 or height < 8 or width < 3:
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


def read_circle_key(image: np.ndarray, x: int, y: int, radius: int, palette_keys: set[str]) -> tuple[str, str]:
    crop = crop_box(image, x, y, int(radius * 1.2), int(radius * 0.95))
    if crop.size == 0:
        return "", ""
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
    variants = [
        cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1],
        cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1],
    ]
    config = "--psm 8 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    first_text = ""
    for variant in variants:
        try:
            text = pytesseract.image_to_string(Image.fromarray(variant), config=config)
        except Exception:
            continue
        cleaned_text = text.strip()
        if cleaned_text and not first_text:
            first_text = cleaned_text
        key = normalize_key_text(text)
        if key in palette_keys:
            return key, cleaned_text
    return "", first_text


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


def special_circle_key(text: str) -> str:
    compact = re.sub(r"\s+", "", text)
    if "空" in compact:
        return "transparent"
    if "全" in compact:
        return "full"
    return ""


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
                "insideText": circle.inside_text,
                "colorKeySource": circle.color_key_source,
                "specialKey": circle.special_key,
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
