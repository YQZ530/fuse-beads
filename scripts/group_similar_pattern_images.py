#!/usr/bin/env python3
"""Group iPad Perler-bead screenshots into logical ImageN projects.

Key assumptions documented from the working batch:
- Screenshots are iPad captures, mostly two fixed orientations:
  landscape 2388x1668 and portrait 1668x2388.
- Export order is meaningful. Images from the same project usually appear near each
  other, so grouping first compares within DEFAULT_LOCAL_WINDOW = 5 positions.
- Page types are classified by CV first; Tesseract chi_sim+eng is tried first on the smallest title crop; PaddleOCR is
  loaded only as fallback when Tesseract returns no pairKey.
- detail_page / legend_page has a main image and a bottom legend. For pairKey OCR,
  first find the bottom white legend rectangle, then use orientation-aware title crops:
  landscape sample 2388x1668 -> rect=(0,1416,2388,252), crop=(21,1388,1307,86);
  portrait sample 1668x2388 -> rect=(0,2136,1668,252), crop=(10,2108,1224,86).
  The y formula is the same for both observed orientations (rect_y - 28 to rect_y + 58),
  but x/width are orientation-specific. The older fixed bottom crop was too low and
  could read the color circles/counts.
- summary_view has a main preview and a bottom summary card. Do not use the largest
  white rectangle because it can be the preview canvas; OCR the bottom summary band.
- color_modal has a dimmed background and a white modal; OCR the modal title band.
- pairKey is a candidate signal, not absolute truth. summary_view + color_modal
  can merge only when both already have the same pairKey. Missing pairKey becomes
  a manual review candidate; detail_page is never converted to summary_view.
- Multi-image outputs use ImageN/ImageN_1.ext; single-image outputs remain at root
  as ImageN.ext. groups.manifest.json preserves original source metadata.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
from datetime import datetime
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
DEFAULT_TESSERACT = Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe")
CACHE_VERSION = 5
DEFAULT_LOCAL_WINDOW = 5
SUMMARY_VIEW = "summary_view"
DETAIL_PAGE = "detail_page"
COLOR_MODAL = "color_modal"
UNKNOWN_VIEW = "unknown"
LEGACY_PATTERN_VIEW = "pattern_view"
LEGACY_PREVIEW_VIEW = "preview_view"
_PADDLE_OCR: Any | None = None


@dataclass
class ImageFeature:
    path: Path
    page_type: str
    pair_key: str | None
    crop_box: tuple[int, int, int, int]
    phash: np.ndarray
    dhash: np.ndarray
    color_hist: np.ndarray
    crop_thumb: np.ndarray
    detail_colors: list[dict[str, Any]]
    has_image: bool
    has_color_details: bool
    from_cache: bool = False


@dataclass
class Group:
    id: str
    items: list[ImageFeature]


def log(message: str) -> None:
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{timestamp}] {message}", flush=True)


def log_run_documentation(local_window: int) -> None:
    log("Assumptions: iPad screenshots; landscape=2388x1668, portrait=1668x2388; export order is meaningful.")
    log(f"Grouping assumption: compare nearby files first with local window N={local_window}, then use global fallback.")
    log("OCR crop assumption: detail_page uses orientation-aware CV legend crop: landscape rect_y-28..+58 x~21 w~1307; portrait rect_y-28..+58 x~10 w~1224.")
    log("OCR crop assumption: summary_view uses bottom summary band; color_modal uses modal title band.")
    log("Safety assumption: pairKey can be OCR-wrong; exact matching fingerprints may override pairKey conflict and leave a manifest review signal.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Group same-pattern screenshots by comparing only the main pattern area.")
    parser.add_argument("input_dir", help="Directory containing screenshots.")
    parser.add_argument("--out", default="", help="Output directory. Defaults to <input_dir>.")
    parser.add_argument("--action", choices=("copy", "move"), default="move", help="Copy or move images into group folders.")
    parser.add_argument("--dry-run", action="store_true", help="Only write JSON plan; do not copy/move files.")
    parser.add_argument("--recursive", action="store_true", help="Scan images recursively. Default only scans direct child files.")
    parser.add_argument("--top-ratio", type=float, default=0.08, help="Crop this ratio from the top before comparing.")
    parser.add_argument("--bottom-ratio", type=float, default=0.38, help="Crop this ratio from the bottom before comparing.")
    parser.add_argument("--side-ratio", type=float, default=0.02, help="Crop this ratio from left/right before comparing.")
    parser.add_argument("--phash-threshold", type=int, default=10, help="Max pHash Hamming distance for same-pattern match.")
    parser.add_argument("--local-window", type=int, default=DEFAULT_LOCAL_WINDOW, help="Prefer grouping images within +/- N filename positions before global fallback.")
    parser.add_argument("--tesseract", default=str(DEFAULT_TESSERACT), help="Path to tesseract.exe.")
    parser.add_argument("--manifest", default="", help="Manifest JSON path. Defaults to <out>/groups.manifest.json.")
    args = parser.parse_args()

    configure_tesseract(Path(args.tesseract))

    input_dir = Path(args.input_dir)
    if not input_dir.is_dir():
        raise SystemExit(f"Input is not a directory: {input_dir}")

    out_dir = Path(args.out) if args.out else input_dir
    manifest_path = Path(args.manifest) if args.manifest else input_dir / "groups.manifest.json"
    feature_cache = load_feature_cache(manifest_path)
    cache_stats = {"hit": 0, "miss": 0}

    log(f"Scanning input directory: {input_dir}")
    log_pruned_manifest_entries(manifest_path)
    image_paths = discover_images(input_dir, args.recursive, out_dir)
    if not image_paths:
        log_run_documentation(args.local_window)
        log("No new candidate images found; refreshing manifest from existing ImageN outputs.")
        manifest = build_manifest(input_dir, out_dir, [], [], args, {}, feature_cache, cache_stats, {}, [])
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print_skipped_summary([])
        print(f"cache hits: {cache_stats['hit']}, cache misses: {cache_stats['miss']}")
        print(str(manifest_path))
        return 0
    log(f"Found {len(image_paths)} candidate image(s). Local grouping window N={args.local_window}.")
    log_run_documentation(args.local_window)

    features: list[ImageFeature] = []
    skipped: list[dict[str, str]] = []
    pre_review_candidates: list[dict[str, Any]] = []
    for index, path in enumerate(image_paths, start=1):
        cached = get_cached_metadata(feature_cache, path)
        if cached:
            feature = build_cached_feature(path, cached)
            cache_stats["hit"] = cache_stats.get("hit", 0) + 1
            log(f"[{index}/{len(image_paths)}] cache hit: {path.name} pageType={feature.page_type} pairKey={feature.pair_key}")
        else:
            cache_stats["miss"] = cache_stats.get("miss", 0) + 1
            log(f"[{index}/{len(image_paths)}] analyzing: {path.name}")
            image = read_image(path)
            if image is None:
                skipped.append({"source": str(path), "filename": path.name, "reason": "could_not_read"})
                log(f"[{index}/{len(image_paths)}] skipped unreadable: {path.name}")
                continue
            feature = build_feature(image, path, args.top_ratio, args.bottom_ratio, args.side_ratio)
            log(f"[{index}/{len(image_paths)}] extracted: {path.name} pageType={feature.page_type} pairKey={feature.pair_key}")
        skip_reason = feature_skip_reason(feature)
        if skip_reason:
            skipped.append({
                "source": str(path),
                "filename": path.name,
                "reason": skip_reason,
                "pageType": feature.page_type,
                "pairKey": feature.pair_key,
            })
            if feature.page_type in {SUMMARY_VIEW, COLOR_MODAL} and not feature.pair_key:
                pre_review_candidates.append({
                    "reason": "missing_pairKey_uncertain_group",
                    "pairKey": None,
                    "images": [path.name],
                    "pageType": feature.page_type,
                    "decision": "manual",
                })
            log(f"[{index}/{len(image_paths)}] skipped: {path.name} reason={skip_reason}")
            continue
        features.append(feature)

    log(f"Grouping {len(features)} analyzed image(s).")
    groups, review_candidates = cluster_features(features, args.phash_threshold, args.local_window)
    review_candidates = pre_review_candidates + review_candidates
    log_group_summary(groups)
    output_names = assign_output_names(groups, out_dir)
    moved_paths: dict[str, Path] = {}
    if not args.dry_run:
        log(f"Writing groups with action={args.action} into {out_dir}")
        moved_paths = write_groups(groups, out_dir, action=args.action, output_names=output_names)
    else:
        log("Dry run enabled; no files moved or copied.")
    manifest = build_manifest(input_dir, out_dir, groups, skipped, args, output_names, feature_cache, cache_stats, moved_paths, review_candidates)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print_skipped_summary(skipped)
    print(f"cache hits: {cache_stats['hit']}, cache misses: {cache_stats['miss']}")
    print(str(manifest_path))
    return 0


def discover_images(input_dir: Path, recursive: bool, out_dir: Path) -> list[Path]:
    iterator = input_dir.rglob("*") if recursive else input_dir.iterdir()
    paths = []
    for path in iterator:
        if not path.is_file() or path.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        if is_group_artifact(path, input_dir, out_dir):
            continue
        paths.append(path)
    return sorted(paths, key=lambda path: natural_key(path.name))


def is_group_artifact(path: Path, input_dir: Path, out_dir: Path) -> bool:
    manifest_names = {"groups.manifest.json"}
    if path.name in manifest_names:
        return True
    relative_parts = path.relative_to(input_dir).parts if is_inside(safe_resolve(path), safe_resolve(input_dir)) else path.parts
    for part in relative_parts[:-1]:
        if re.fullmatch(r"Image\d+", part, flags=re.IGNORECASE):
            return True
        if re.fullmatch(r"G\d+", part, flags=re.IGNORECASE):
            return True
        if re.fullmatch(r"group_\d+", part, flags=re.IGNORECASE):
            return True
        if part == "grouped_patterns":
            return True
    if path.parent == input_dir and re.fullmatch(r"Image\d+", path.stem, flags=re.IGNORECASE):
        return True
    if out_dir != input_dir and is_inside(safe_resolve(path), safe_resolve(out_dir)):
        return True
    return False


def read_image(path: Path) -> np.ndarray | None:
    raw = np.fromfile(str(path), dtype=np.uint8)
    if raw.size == 0:
        return None
    return cv2.imdecode(raw, cv2.IMREAD_COLOR)


def configure_tesseract(tesseract_path: Path) -> None:
    if pytesseract is not None and tesseract_path.exists():
        pytesseract.pytesseract.tesseract_cmd = str(tesseract_path)


def log_pruned_manifest_entries(manifest_path: Path) -> None:
    payload = read_manifest_payload(manifest_path)
    if not payload:
        return

    pruned_groups = 0
    pruned_items = 0
    for group in payload.get("groups", []):
        group_name = str(group.get("groupName") or group.get("folderName") or group.get("id") or "unknown")
        items = group.get("items") or []
        missing_items = []
        existing_items = []
        for item in items:
            source = item.get("source")
            if not source:
                continue
            source_path = Path(source)
            if source_path.exists():
                existing_items.append(item)
            else:
                missing_items.append(item)
        if missing_items:
            pruned_items += len(missing_items)
            names = ", ".join(str(item.get("filename") or Path(str(item.get("source", ""))).name) for item in missing_items)
            log(f"manifest prune: removing missing item(s) from {group_name}: {names}")
        if items and not existing_items:
            pruned_groups += 1
            log(f"manifest prune: removing missing group {group_name}; no listed files still exist")

    if pruned_groups or pruned_items:
        log(f"manifest prune summary: {pruned_groups} group(s), {pruned_items} item(s) will be removed from refreshed manifest")


def read_manifest_payload(manifest_path: Path) -> dict[str, Any] | None:
    if not manifest_path.exists():
        return None
    try:
        return json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return None


def load_feature_cache(manifest_path: Path) -> dict[str, dict[str, Any]]:
    payload = read_manifest_payload(manifest_path)
    if not payload:
        return {}
    version = payload.get("analysisCache", {}).get("version", payload.get("cache", {}).get("version"))
    if version != CACHE_VERSION:
        return {}

    cache: dict[str, dict[str, Any]] = {}
    for group in payload.get("groups", []):
        for item in group.get("items", []):
            source = item.get("source")
            if not source or item.get("size") is None or item.get("mtimeNs") is None:
                continue
            source_path = Path(source)
            if not source_path.exists():
                continue
            cache[cache_key(source_path)] = item
    return cache


def get_cached_metadata(feature_cache: dict[str, dict[str, Any]], path: Path) -> dict[str, Any] | None:
    cached = feature_cache.get(cache_key(path))
    if not cached:
        return None
    try:
        stat = path.stat()
        cached_size = int(cached.get("size", -1))
        cached_mtime_ns = int(cached.get("mtimeNs", -1))
    except (OSError, TypeError, ValueError):
        return None
    if cached_size != stat.st_size or cached_mtime_ns != stat.st_mtime_ns:
        return None
    if cached.get("pageType") not in {DETAIL_PAGE, SUMMARY_VIEW, COLOR_MODAL, UNKNOWN_VIEW}:
        return None
    return cached


def build_cached_feature(path: Path, cached: dict[str, Any]) -> ImageFeature:
    fingerprint = cached.get("fingerprint") or {}
    crop_box_payload = cached.get("cropBox") or {}
    color_hist_values = fingerprint.get("colorHist") or []
    if len(color_hist_values) != 24:
        color_hist_values = [0.0] * 24
    crop_thumb_values = fingerprint.get("cropThumb") or []
    if len(crop_thumb_values) != 32 * 32:
        crop_thumb_values = [0.0] * (32 * 32)
    return ImageFeature(
        path=path,
        page_type=normalize_page_type(str(cached.get("pageType") or UNKNOWN_VIEW)),
        pair_key=cached.get("pairKey"),
        crop_box=(
            int(crop_box_payload.get("x", 0)),
            int(crop_box_payload.get("y", 0)),
            int(crop_box_payload.get("width", 0)),
            int(crop_box_payload.get("height", 0)),
        ),
        phash=string_to_bits(str(fingerprint.get("phash", ""))),
        dhash=string_to_bits(str(fingerprint.get("dhash", ""))),
        color_hist=np.array([float(value) for value in color_hist_values], dtype=np.float32),
        crop_thumb=np.array([float(value) for value in crop_thumb_values], dtype=np.float32).reshape((32, 32)),
        detail_colors=list(cached.get("detailColors") or []),
        has_image=bool(cached.get("hasImage", True)),
        has_color_details=bool(cached.get("hasColorDetails", False)),
        from_cache=True,
    )


def normalize_page_type(page_type: str) -> str:
    if page_type == LEGACY_PATTERN_VIEW:
        return DETAIL_PAGE
    if page_type == LEGACY_PREVIEW_VIEW:
        return SUMMARY_VIEW
    if page_type in {DETAIL_PAGE, SUMMARY_VIEW, COLOR_MODAL, UNKNOWN_VIEW}:
        return page_type
    return UNKNOWN_VIEW


def build_feature(
    image: np.ndarray,
    path: Path,
    top_ratio: float,
    bottom_ratio: float,
    side_ratio: float,
    feature_cache: dict[str, dict[str, Any]] | None = None,
    cache_stats: dict[str, int] | None = None,
) -> ImageFeature:
    cached = get_cached_metadata(feature_cache or {}, path)
    if cached:
        page_type = str(cached.get("pageType") or UNKNOWN_VIEW)
        pair_key = cached.get("pairKey")
        if cache_stats is not None:
            cache_stats["hit"] = cache_stats.get("hit", 0) + 1
    else:
        page_type = classify_page(image)
        pair_key = extract_pair_key(image, page_type)
        if cache_stats is not None:
            cache_stats["miss"] = cache_stats.get("miss", 0) + 1
    crop, box = crop_main_pattern(image, top_ratio, bottom_ratio, side_ratio)
    return ImageFeature(
        path=path,
        page_type=page_type,
        pair_key=pair_key,
        crop_box=box,
        phash=phash(crop),
        dhash=dhash(crop),
        color_hist=color_hist(crop),
        crop_thumb=crop_thumb(crop),
        detail_colors=[],
        has_image=page_type != COLOR_MODAL,
        has_color_details=page_type in {DETAIL_PAGE, COLOR_MODAL},
    )


def classify_page(image: np.ndarray) -> str:
    if looks_like_color_modal(image):
        return COLOR_MODAL
    if looks_like_summary_view(image):
        return SUMMARY_VIEW
    if count_bottom_circles(image) >= 3:
        return DETAIL_PAGE
    if looks_like_preview_view(image):
        return SUMMARY_VIEW
    return UNKNOWN_VIEW


def feature_skip_reason(feature: ImageFeature) -> str | None:
    if feature.page_type == UNKNOWN_VIEW:
        return "unrecognized_page_type"
    if feature.page_type in {SUMMARY_VIEW, COLOR_MODAL} and not feature.pair_key:
        return "missing_pair_key"
    return None


def print_skipped_summary(skipped: list[dict[str, str]]) -> None:
    count = len(skipped)
    print(f"{count} image{'s' if count != 1 else ''} are skipped.")
    for row in skipped:
        filename = row.get("filename") or Path(row.get("source", "")).name
        reason = row.get("reason", "")
        page_type = row.get("pageType", "")
        print(f"  skipped: {filename} reason={reason} pageType={page_type}")


def apply_adjacent_modal_pair_fallback(features: list[ImageFeature]) -> None:
    # Deprecated: do not overwrite pairKey/pageType from adjacent color_modal.
    # summary_view + color_modal is handled in group_match_score only when both
    # sides already have the same pairKey. detail_page is never converted.
    return None


def looks_like_color_modal(image: np.ndarray) -> bool:
    height, width = image.shape[:2]
    box = find_modal_box(image)
    if box is None:
        return False
    x, y, w, h = box
    area_ratio = (w * h) / max(1, height * width)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    outside_mask = np.ones(gray.shape, dtype=bool)
    outside_mask[y:y + h, x:x + w] = False
    outside = gray[outside_mask]
    outside_dark_ratio = float(np.mean(outside < 130)) if outside.size else 0.0
    return area_ratio > 0.20 and w > width * 0.45 and h > height * 0.30 and outside_dark_ratio > 0.35


def looks_like_preview_view(image: np.ndarray) -> bool:
    height, width = image.shape[:2]
    bottom = image[int(height * 0.84):int(height * 0.98), :]
    if bottom.size == 0:
        return False
    gray = cv2.cvtColor(bottom, cv2.COLOR_BGR2GRAY)
    white_ratio = float(np.mean(gray > 238))
    # Preview pages have one or two wide white option bars at the bottom.
    return white_ratio > 0.55


def looks_like_summary_view(image: np.ndarray) -> bool:
    if not looks_like_preview_view(image):
        return False
    height, width = image.shape[:2]
    rect = choose_bottom_legend_rect(image)
    if rect is None:
        return False
    _x, y, _w, h = rect
    # Summary/preview pages often expose a large lower white preview/summary region.
    # Detail pages have a short bottom legend strip near the bottom edge instead.
    return y < height * 0.70 and h > height * 0.30


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
        if page_area * 0.12 <= area <= page_area * 0.85:
            candidates.append((x, y, w, h))
    if not candidates:
        return None
    return max(candidates, key=lambda box: box[2] * box[3])


def count_bottom_circles(image: np.ndarray) -> int:
    height, width = image.shape[:2]
    legend_top = int(round(height * 0.58))
    legend = image[legend_top:, :]
    if legend.size == 0:
        return 0
    gray = cv2.cvtColor(legend, cv2.COLOR_BGR2GRAY)
    gray = cv2.medianBlur(gray, 5)
    min_radius = max(12, int(round(min(width, height) * 0.012)))
    max_radius = max(min_radius + 8, int(round(min(width, height) * 0.045)))
    circles = cv2.HoughCircles(
        gray,
        cv2.HOUGH_GRADIENT,
        dp=1.2,
        minDist=max(34, int(round(width * 0.038))),
        param1=85,
        param2=24,
        minRadius=min_radius,
        maxRadius=max_radius,
    )
    if circles is None:
        return 0
    merged = merge_circle_points([(int(x), int(y + legend_top), int(r)) for x, y, r in np.round(circles[0]).astype(int)])
    return len(merged)


def merge_circle_points(circles: list[tuple[int, int, int]]) -> list[tuple[int, int, int]]:
    merged: list[tuple[int, int, int]] = []
    for circle in sorted(circles, key=lambda item: (item[1], item[0])):
        x, y, radius = circle
        if any(math.hypot(x - mx, y - my) <= max(radius, mr) * 0.5 for mx, my, mr in merged):
            continue
        merged.append(circle)
    return merged


def extract_pair_key(image: np.ndarray, page_type: str) -> str | None:
    if page_type not in {DETAIL_PAGE, SUMMARY_VIEW, COLOR_MODAL}:
        return None
    numbers = ocr_numbers_for_key(image, page_type)
    if len(numbers) < 2:
        return None
    color_count, bead_count = choose_pair_numbers(numbers)
    if color_count is None or bead_count is None:
        return None
    return f"{color_count}_{bead_count}"


def ocr_numbers_for_key(image: np.ndarray, page_type: str) -> list[int]:
    pair = extract_pair_key_from_region(image, page_type)
    if pair:
        return [int(part) for part in pair.split("_", 1)]
    return []


def extract_pair_key_from_region(image: np.ndarray, page_type: str) -> str | None:
    tesseract_pair = extract_pair_key_with_tesseract(image, page_type)
    if tesseract_pair:
        return tesseract_pair

    return extract_pair_key_with_paddle(image, page_type)


def extract_pair_key_with_tesseract(image: np.ndarray, page_type: str) -> str | None:
    if pytesseract is None:
        return None

    for crop in pair_key_crops(image, page_type):
        if crop.size == 0:
            continue
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        for lang in ("chi_sim+eng", "eng"):
            try:
                text = pytesseract.image_to_string(Image.fromarray(rgb), lang=lang, config="--psm 7")
            except Exception:
                continue
            pair = parse_pair_key_text(text)
            if pair:
                return pair
    return None


def extract_pair_key_with_paddle(image: np.ndarray, page_type: str) -> str | None:
    ocr = get_paddle_ocr()
    if ocr is None:
        return None

    for crop in pair_key_crops(image, page_type):
        if crop.size == 0:
            continue
        try:
            results = ocr.predict(crop)
        except Exception:
            return None
        texts = paddle_texts(results)
        pair = parse_pair_key_from_texts(texts)
        if pair:
            return pair
    return None


def get_paddle_ocr() -> Any | None:
    global _PADDLE_OCR
    if _PADDLE_OCR is not None:
        return _PADDLE_OCR

    try:
        project_root = Path(__file__).resolve().parents[1]
        os.environ["USERPROFILE"] = str(project_root / ".ocr_home")
        os.environ["PADDLE_PDX_CACHE_HOME"] = str(project_root / ".paddlex_cache")
        os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
        from paddleocr import PaddleOCR

        _PADDLE_OCR = PaddleOCR(
            lang="ch",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
    except Exception:
        _PADDLE_OCR = None
    return _PADDLE_OCR


def pair_key_crops(image: np.ndarray, page_type: str) -> list[np.ndarray]:
    height, width = image.shape[:2]
    if page_type == COLOR_MODAL:
        box = find_modal_box(image)
        if box is None:
            return [image[int(height * 0.30):int(height * 0.48), int(width * 0.08):int(width * 0.92)]]
        x, y, w, h = box
        return [
            image[y + int(h * 0.02):y + int(h * 0.16), x + int(w * 0.02):x + int(w * 0.78)],
        ]

    if page_type == DETAIL_PAGE:
        crops = detail_page_pair_key_crops(image)
        if crops:
            return crops

    if page_type == SUMMARY_VIEW:
        return summary_view_pair_key_crops(image)

    return legacy_pair_key_crops(image)


def detail_page_pair_key_crops(image: np.ndarray) -> list[np.ndarray]:
    rect = choose_bottom_legend_rect(image)
    if rect is None:
        return legacy_pair_key_crops(image)
    height, width = image.shape[:2]
    x, y, w, h = rect
    left = clamp_int(x + round(w * 0.015) - 15, 0, width - 1)
    right = clamp_int(x + round(w * (0.64 if width > height else 0.86)) - 200, left + 1, width)
    # Best observed iPad crops:
    # landscape 2388x1668: rect=(0,1416,2388,252), crop=(21,1388,1307,86)
    # portrait  1668x2388: rect=(0,2136,1668,252), crop=(10,2108,1224,86)
    # The y band keeps the title line and removes the gray hint row; x/width are orientation-specific above.
    primary_top = clamp_int(y - 28, 0, height - 1)
    primary_bottom = clamp_int(y + 58, primary_top + 1, height)
    secondary_top = clamp_int(y - 20, 0, height - 1)
    secondary_bottom = clamp_int(y + 70, secondary_top + 1, height)
    return [
        image[primary_top:primary_bottom, left:right],
        image[secondary_top:secondary_bottom, left:right],
    ]


def summary_view_pair_key_crops(image: np.ndarray) -> list[np.ndarray]:
    height, width = image.shape[:2]
    left = int(width * 0.015)
    right = int(width * (0.86 if height > width else 0.64))
    # Summary pages can have a huge white preview canvas; use the bottom summary card instead.
    return [
        image[int(height * 0.91):int(height * 0.965), left:right],
        image[int(height * 0.875):int(height * 0.945), left:right],
    ]


def legacy_pair_key_crops(image: np.ndarray) -> list[np.ndarray]:
    height, width = image.shape[:2]
    return [
        image[int(height * 0.91):int(height * 0.965), int(width * 0.02):int(width * 0.58)],
    ]


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


def paddle_texts(results: Any) -> list[str]:
    texts: list[str] = []
    for item in results or []:
        data = dict(item) if hasattr(item, "keys") else item
        if isinstance(data, dict):
            values = data.get("rec_texts") or []
            texts.extend(str(value) for value in values if value is not None)
        else:
            texts.append(str(data))
    return texts


def parse_pair_key_from_texts(texts: list[str]) -> str | None:
    for text in texts:
        pair = parse_pair_key_text(text)
        if pair:
            return pair
    return parse_pair_key_text(" ".join(texts))


def parse_pair_key_text(text: str) -> str | None:
    compact = re.sub(r"\s+", "", text)
    match = re.search(r"(\d+)\u8272(?:\u53f7|\u5448)?.*?(\d+)\u8c46", compact)
    if match:
        return f"{int(match.group(1))}_{int(match.group(2))}"
    return None


def choose_pair_numbers(numbers: list[int]) -> tuple[int | None, int | None]:
    color_candidates = [value for value in numbers if 1 <= value <= 400]
    bead_candidates = [value for value in numbers if 100 <= value <= 20000]
    if not color_candidates or not bead_candidates:
        return None, None
    bead_count = max(bead_candidates)
    before_bead = [value for value in color_candidates if value != bead_count]
    color_count = before_bead[-1] if before_bead else color_candidates[-1]
    return color_count, bead_count


def crop_main_pattern(
    image: np.ndarray,
    top_ratio: float,
    bottom_ratio: float,
    side_ratio: float,
) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    height, width = image.shape[:2]
    left = clamp_int(round(width * side_ratio), 0, width - 2)
    right = clamp_int(round(width * (1.0 - side_ratio)), left + 1, width)
    top = clamp_int(round(height * top_ratio), 0, height - 2)
    bottom = clamp_int(round(height * (1.0 - bottom_ratio)), top + 1, height)

    crop = image[top:bottom, left:right]
    if crop.size == 0:
        crop = image
        left, top, right, bottom = 0, 0, width, height
    return crop, (left, top, right - left, bottom - top)


def phash(image: np.ndarray, hash_size: int = 8, highfreq_factor: int = 4) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    size = hash_size * highfreq_factor
    resized = cv2.resize(gray, (size, size), interpolation=cv2.INTER_AREA).astype(np.float32)
    dct = cv2.dct(resized)
    low = dct[:hash_size, :hash_size]
    median = np.median(low[1:, 1:])
    return (low > median).astype(np.uint8)


def dhash(image: np.ndarray, hash_size: int = 8) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    resized = cv2.resize(gray, (hash_size + 1, hash_size), interpolation=cv2.INTER_AREA)
    return (resized[:, 1:] > resized[:, :-1]).astype(np.uint8)


def color_hist(image: np.ndarray, bins: int = 8) -> np.ndarray:
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    channels = cv2.split(rgb)
    hist_parts: list[float] = []
    for channel in channels:
        hist = cv2.calcHist([channel], [0], None, [bins], [0, 256]).flatten().astype(np.float32)
        total = float(np.sum(hist)) or 1.0
        hist_parts.extend((hist / total).tolist())
    return np.array(hist_parts, dtype=np.float32)


def crop_thumb(image: np.ndarray, size: int = 32) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    thumb = cv2.resize(gray, (size, size), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    return thumb


def bits_to_string(bits: np.ndarray) -> str:
    return "".join("1" if int(value) else "0" for value in bits.flatten())


def string_to_bits(value: str, shape: tuple[int, int] = (8, 8)) -> np.ndarray:
    cleaned = "".join(ch for ch in value if ch in "01")
    if len(cleaned) != shape[0] * shape[1]:
        return np.zeros(shape, dtype=np.uint8)
    return np.array([1 if ch == "1" else 0 for ch in cleaned], dtype=np.uint8).reshape(shape)


def fingerprint_json(feature: ImageFeature) -> dict[str, Any]:
    return {
        "phash": bits_to_string(feature.phash),
        "dhash": bits_to_string(feature.dhash),
        "colorHist": [round(float(value), 6) for value in feature.color_hist.tolist()],
        "cropThumb": [round(float(value), 6) for value in feature.crop_thumb.flatten().tolist()],
    }


def cluster_features(
    features: list[ImageFeature],
    phash_threshold: int,
    local_window: int = DEFAULT_LOCAL_WINDOW,
) -> tuple[list[Group], list[dict[str, Any]]]:
    groups: list[Group] = []
    review_candidates: list[dict[str, Any]] = []
    feature_order = {cache_key(feature.path): index for index, feature in enumerate(features)}

    for feature in features:
        best = find_best_group(feature, groups, feature_order, phash_threshold, local_window, local_only=True, review_candidates=review_candidates)
        source = "local"
        if best is None:
            best = find_best_group(feature, groups, feature_order, phash_threshold, local_window, local_only=False, review_candidates=review_candidates)
            source = "global"
        if best is None:
            group = Group(id=f"group_{len(groups) + 1:03d}", items=[feature])
            groups.append(group)
            log(f"new group {group.id}: {feature.path.name} pageType={feature.page_type} pairKey={feature.pair_key}")
        else:
            score, group = best
            group.items.append(feature)
            names = ", ".join(item.path.name for item in group.items)
            log(f"merge {feature.path.name} -> {group.id} via {source} score={score:.3f}; group now: {names}")
    return groups, review_candidates


def find_best_group(
    feature: ImageFeature,
    groups: list[Group],
    feature_order: dict[str, int],
    phash_threshold: int,
    local_window: int,
    local_only: bool,
    review_candidates: list[dict[str, Any]],
) -> tuple[float, Group] | None:
    best: tuple[float, Group] | None = None
    for group in groups:
        if local_only and group_order_distance(feature, group, feature_order) > local_window:
            continue
        match = group_match_score(feature, group, phash_threshold, review_candidates, local_window, feature_order)
        if match is not None and (best is None or match < best[0]):
            best = (match, group)
    return best


def group_order_distance(feature: ImageFeature, group: Group, feature_order: dict[str, int]) -> int:
    current = feature_order.get(cache_key(feature.path), 10**9)
    return min(abs(current - feature_order.get(cache_key(item.path), 10**9)) for item in group.items)


def group_match_score(
    feature: ImageFeature,
    group: Group,
    phash_threshold: int,
    review_candidates: list[dict[str, Any]],
    local_window: int,
    feature_order: dict[str, int],
) -> float | None:
    group_keys = {item.pair_key for item in group.items if item.pair_key}
    same_key = bool(feature.pair_key and feature.pair_key in group_keys)
    local_distance = group_order_distance(feature, group, feature_order)

    if feature.pair_key and group_keys and not same_key:
        image_items = [item for item in group.items if item.has_image]
        if feature.has_image and any(exact_same_fingerprint(feature, item) for item in image_items):
            add_review_candidate(review_candidates, feature, group, "auto_merged_exact_fingerprint_pairKey_conflict")
            return 0.1
        return None

    if same_key:
        if feature.page_type == COLOR_MODAL and all(item.page_type == COLOR_MODAL for item in group.items):
            if detail_colors_overlap(feature, group):
                return 0.25
            if local_distance <= local_window:
                add_review_candidate(review_candidates, feature, group, "same_pairKey_no_detail_overlap")
            return None

        if feature.page_type == COLOR_MODAL or any(item.page_type == COLOR_MODAL for item in group.items):
            page_types = {item.page_type for item in group.items}
            if feature.page_type == SUMMARY_VIEW and COLOR_MODAL in page_types and local_distance <= local_window:
                return 0.5
            if feature.page_type == COLOR_MODAL and SUMMARY_VIEW in page_types and local_distance <= local_window:
                return 0.5
            # Do not merge detail_page with color_modal by pairKey/local order alone.
            return None

        if feature.has_image and any(item.has_image for item in group.items):
            distance = group_distance(feature, Group(group.id, [item for item in group.items if item.has_image]))
            if is_same_pattern(distance, phash_threshold):
                return distance_score(distance)
            if same_pair_visual_match(distance):
                return 1.25 + distance["thumbMae"] * 10.0
            if local_distance <= local_window and feature.page_type != DETAIL_PAGE:
                return 1.5

    if feature.has_image:
        image_items = [item for item in group.items if item.has_image]
        if image_items:
            distance = group_distance(feature, Group(group.id, image_items))
            if is_same_pattern(distance, phash_threshold):
                return distance_score(distance) + 2.0
    return None


def exact_same_fingerprint(a: ImageFeature, b: ImageFeature) -> bool:
    return (
        np.array_equal(a.phash, b.phash)
        and np.array_equal(a.dhash, b.dhash)
        and float(np.mean(np.abs(a.color_hist - b.color_hist))) <= 0.000001
    )


def detail_colors_overlap(feature: ImageFeature, group: Group) -> bool:
    current = detail_color_keys(feature.detail_colors)
    if not current:
        return False
    for item in group.items:
        other = detail_color_keys(item.detail_colors)
        if current & other:
            return True
    return False


def detail_color_keys(detail_colors: list[dict[str, Any]]) -> set[str]:
    keys: set[str] = set()
    for row in detail_colors:
        code = row.get("code") or row.get("colorCode") or row.get("label")
        if code:
            keys.add(str(code).strip().upper())
    return keys


def add_review_candidate(review_candidates: list[dict[str, Any]], feature: ImageFeature, group: Group, reason: str) -> None:
    images = [item.path.name for item in group.items] + [feature.path.name]
    key = (reason, feature.pair_key or "", tuple(sorted(images)))
    for candidate in review_candidates:
        existing_key = (candidate.get("reason"), candidate.get("pairKey") or "", tuple(sorted(candidate.get("images", []))))
        if existing_key == key:
            return
    review_candidates.append({
        "reason": reason,
        "pairKey": feature.pair_key,
        "images": images,
        "decision": "manual",
    })
    log(f"maybe group needs user decision: reason={reason} pairKey={feature.pair_key} images={', '.join(images)}")


def group_distance(feature: ImageFeature, group: Group) -> dict[str, float]:
    distances = [feature_distance(feature, item) for item in group.items]
    return {
        "phashDistance": min(distance["phashDistance"] for distance in distances),
        "dhashDistance": min(distance["dhashDistance"] for distance in distances),
        "colorHistDistance": min(distance["colorHistDistance"] for distance in distances),
        "thumbMae": min(distance["thumbMae"] for distance in distances),
        "thumbCorr": max(distance["thumbCorr"] for distance in distances),
    }


def feature_distance(a: ImageFeature, b: ImageFeature) -> dict[str, float]:
    return {
        "phashDistance": float(np.count_nonzero(a.phash != b.phash)),
        "dhashDistance": float(np.count_nonzero(a.dhash != b.dhash)),
        "colorHistDistance": float(np.mean(np.abs(a.color_hist - b.color_hist))),
        "thumbMae": float(np.mean(np.abs(a.crop_thumb - b.crop_thumb))),
        "thumbCorr": thumb_corr(a.crop_thumb, b.crop_thumb),
    }


def is_same_pattern(distance: dict[str, float], phash_threshold: int) -> bool:
    return (
        distance["phashDistance"] <= phash_threshold
        and distance["dhashDistance"] <= phash_threshold
        and distance["colorHistDistance"] <= 0.05
    )


def distance_score(distance: dict[str, float]) -> float:
    return distance["phashDistance"] + distance["dhashDistance"] + distance["colorHistDistance"] * 100.0


def thumb_corr(a: np.ndarray, b: np.ndarray) -> float:
    av = a.flatten().astype(np.float32)
    bv = b.flatten().astype(np.float32)
    av = av - float(np.mean(av))
    bv = bv - float(np.mean(bv))
    denom = float(np.linalg.norm(av) * np.linalg.norm(bv))
    if denom <= 1e-8:
        return 0.0
    return float(np.dot(av, bv) / denom)


def same_pair_visual_match(distance: dict[str, float]) -> bool:
    # Normal first-run grouping rule: same pairKey plus similar main crop should merge,
    # even when pHash/dHash differ because the screenshot position or visible region shifted.
    return (
        distance["thumbCorr"] >= 0.94
        and distance["thumbMae"] <= 0.08
        and distance["colorHistDistance"] <= 0.08
    )


def log_group_summary(groups: list[Group]) -> None:
    for index, group in enumerate(groups, start=1):
        names = ", ".join(item.path.name for item in group.items)
        keys = sorted({item.pair_key for item in group.items if item.pair_key})
        types = sorted({item.page_type for item in group.items})
        log(f"planned Image{index}: count={len(group.items)} types={types} pairKeys={keys} files={names}")


def assign_output_names(groups: list[Group], out_dir: Path) -> dict[str, str]:
    existing_numbers: set[int] = set()
    if out_dir.exists():
        for path in out_dir.iterdir():
            match = re.fullmatch(r"Image(\d+)(?:_\d+)?", path.stem if path.is_file() else path.name, flags=re.IGNORECASE)
            if match:
                existing_numbers.add(int(match.group(1)))

    output_names: dict[str, str] = {}
    next_number = 1
    for group in groups:
        while next_number in existing_numbers:
            next_number += 1
        output_names[group.id] = f"Image{next_number}"
        existing_numbers.add(next_number)
        next_number += 1
    return output_names


def write_groups(groups: list[Group], out_dir: Path, action: str, output_names: dict[str, str]) -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    used_names: set[Path] = set()
    moved_paths: dict[str, Path] = {}
    for group in groups:
        output_name = output_names[group.id]
        if len(group.items) == 1:
            item = group.items[0]
            destination = unique_root_destination(out_dir, output_name, item.path, used_names)
            move_or_copy(item.path, destination, action)
            moved_paths[cache_key(item.path)] = destination
            log(f"{action}: {item.path.name} -> {destination.name}")
            continue

        group_dir = out_dir / output_name
        group_dir.mkdir(parents=True, exist_ok=True)
        for index, item in enumerate(group.items, start=1):
            destination = unique_group_destination(group_dir, output_name, item.path, index, used_names)
            move_or_copy(item.path, destination, action)
            moved_paths[cache_key(item.path)] = destination
            log(f"{action}: {item.path.name} -> {output_name}\\{destination.name}")
    return moved_paths


def move_or_copy(source: Path, destination: Path, action: str) -> None:
    if safe_resolve(source) == safe_resolve(destination):
        return
    if action == "copy":
        shutil.copy2(source, destination)
    else:
        shutil.move(str(source), str(destination))


def unique_root_destination(out_dir: Path, output_name: str, source: Path, used_names: set[Path]) -> Path:
    destination = out_dir / f"{output_name}{source.suffix}"
    return avoid_collision(destination, used_names)


def unique_group_destination(group_dir: Path, output_name: str, source: Path, index: int, used_names: set[Path]) -> Path:
    destination = group_dir / f"{output_name}_{index}{source.suffix}"
    return avoid_collision(destination, used_names)


def avoid_collision(destination: Path, used_names: set[Path]) -> Path:
    if destination not in used_names and not destination.exists():
        used_names.add(destination)
        return destination
    stem = destination.stem
    suffix = destination.suffix
    parent = destination.parent
    counter = 2
    candidate = parent / f"{stem}_{counter}{suffix}"
    while candidate in used_names or candidate.exists():
        counter += 1
        candidate = parent / f"{stem}_{counter}{suffix}"
    used_names.add(candidate)
    return candidate


def build_manifest(
    input_dir: Path,
    out_dir: Path,
    groups: list[Group],
    skipped: list[dict[str, str]],
    args: argparse.Namespace,
    output_names: dict[str, str],
    feature_cache: dict[str, dict[str, Any]],
    cache_stats: dict[str, int],
    moved_paths: dict[str, Path],
    review_candidates: list[dict[str, Any]],
) -> dict[str, Any]:
    group_rows = []
    planned_names = set(output_names.values())
    group_rows.extend(existing_output_rows(input_dir, planned_names, feature_cache, cache_stats))

    for group in groups:
        group_name = output_names[group.id]
        rows = []
        for item in group.items:
            current_path = moved_paths.get(cache_key(item.path), item.path)
            rows.append(feature_manifest_row(item, current_path))
        folder_created = len(group.items) > 1
        group_rows.append({
            "id": group.id,
            "groupName": group_name,
            "count": len(group.items),
            "folderCreated": folder_created,
            "folderName": group_name if folder_created else None,
            "placement": "group_folder" if folder_created else "root_file",
            "items": rows,
        })

    print_review_candidates(review_candidates)
    return {
        "input": str(input_dir),
        "output": str(out_dir),
        "action": args.action,
        "dryRun": bool(args.dry_run),
        "recursive": bool(args.recursive),
        "analysisCache": {
            "version": CACHE_VERSION,
            "key": "source + size + mtimeNs",
            "fullFeatureCache": True,
            "hasFingerprint": True,
            "hasDetailColors": True,
        },
        "cache": {
            "version": CACHE_VERSION,
            "hits": cache_stats.get("hit", 0),
            "misses": cache_stats.get("miss", 0),
            "key": "source + size + mtimeNs",
        },
        "parameters": {
            "topRatio": args.top_ratio,
            "bottomRatio": args.bottom_ratio,
            "sideRatio": args.side_ratio,
            "phashThreshold": args.phash_threshold,
            "colorHistThreshold": 0.05,
            "localWindow": args.local_window,
        },
        "imageCount": sum(int(group["count"]) for group in group_rows),
        "groupCount": len(group_rows),
        "groups": group_rows,
        "skipped": skipped,
        "reviewCandidates": review_candidates,
    }


def feature_manifest_row(item: ImageFeature, current_path: Path) -> dict[str, Any]:
    stat = current_path.stat()
    row: dict[str, Any] = {
        "source": str(current_path),
        "filename": current_path.name,
        "size": stat.st_size,
        "mtimeNs": stat.st_mtime_ns,
        "pageType": item.page_type,
        "pairKey": item.pair_key,
        "detailColors": item.detail_colors,
        "hasImage": item.has_image,
        "hasColorDetails": item.has_color_details,
        "fromCache": item.from_cache,
        "fingerprint": fingerprint_json(item),
        "cropBox": {
            "x": item.crop_box[0],
            "y": item.crop_box[1],
            "width": item.crop_box[2],
            "height": item.crop_box[3],
        },
    }
    if current_path != item.path:
        row["originalSource"] = str(item.path)
        row["originalFilename"] = item.path.name
    return row


def existing_output_rows(
    input_dir: Path,
    planned_names: set[str],
    feature_cache: dict[str, dict[str, Any]],
    cache_stats: dict[str, int],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not input_dir.exists():
        return rows
    for entry in sorted(input_dir.iterdir(), key=lambda path: natural_key(path.name)):
        if entry.is_dir() and re.fullmatch(r"Image\d+", entry.name, flags=re.IGNORECASE):
            if entry.name in planned_names:
                continue
            items = [existing_feature_row(file_path, feature_cache, cache_stats) for file_path in sorted(entry.iterdir(), key=lambda path: natural_key(path.name)) if file_path.is_file() and file_path.suffix.lower() in IMAGE_EXTENSIONS]
            rows.append({
                "id": f"existing_{entry.name}",
                "groupName": entry.name,
                "count": len(items),
                "folderCreated": True,
                "folderName": entry.name,
                "placement": "group_folder",
                "items": items,
            })
        elif entry.is_file() and entry.suffix.lower() in IMAGE_EXTENSIONS and re.fullmatch(r"Image\d+", entry.stem, flags=re.IGNORECASE):
            if entry.stem in planned_names:
                continue
            rows.append({
                "id": f"existing_{entry.stem}",
                "groupName": entry.stem,
                "count": 1,
                "folderCreated": False,
                "folderName": None,
                "placement": "root_file",
                "items": [existing_feature_row(entry, feature_cache, cache_stats)],
            })
    return rows


def existing_feature_row(
    file_path: Path,
    feature_cache: dict[str, dict[str, Any]],
    cache_stats: dict[str, int],
) -> dict[str, Any]:
    cached = get_cached_metadata(feature_cache, file_path)
    if cached:
        cache_stats["hit"] = cache_stats.get("hit", 0) + 1
        return feature_manifest_row(build_cached_feature(file_path, cached), file_path)

    cache_stats["miss"] = cache_stats.get("miss", 0) + 1
    stat = file_path.stat()
    image = read_image(file_path)
    if image is None:
        return {
            "source": str(file_path),
            "filename": file_path.name,
            "size": stat.st_size,
            "mtimeNs": stat.st_mtime_ns,
            "pageType": "unreadable_existing_group",
            "pairKey": None,
            "cropBox": None,
        }
    feature = build_feature(image, file_path, top_ratio=0.08, bottom_ratio=0.38, side_ratio=0.02)
    return feature_manifest_row(feature, file_path)


def print_review_candidates(review_candidates: list[dict[str, Any]]) -> None:
    if not review_candidates:
        return
    log(f"{len(review_candidates)} maybe-group candidate(s) need user decision.")
    for candidate in review_candidates:
        log(f"maybe group: pairKey={candidate.get('pairKey')} reason={candidate.get('reason')} images={', '.join(candidate.get('images', []))}")


def natural_key(value: str) -> list[Any]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value)]


def safe_resolve(path: Path) -> Path:
    try:
        return path.resolve()
    except FileNotFoundError:
        return path.absolute()


def cache_key(path: Path) -> str:
    return str(safe_resolve(path)).casefold()


def is_inside(path: Path, directory: Path) -> bool:
    try:
        path.relative_to(directory)
        return True
    except ValueError:
        return False


def clamp_int(value: int, minimum: int, maximum: int) -> int:
    return min(maximum, max(minimum, value))


if __name__ == "__main__":
    raise SystemExit(main())
