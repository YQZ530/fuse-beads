#!/usr/bin/env python3
"""Group screenshots that show the same pattern but different bottom legends."""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
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
PATTERN_VIEW = "pattern_view"
PREVIEW_VIEW = "preview_view"
COLOR_MODAL = "color_modal"
UNKNOWN_VIEW = "unknown"


@dataclass
class ImageFeature:
    path: Path
    page_type: str
    pair_key: str | None
    crop_box: tuple[int, int, int, int]
    phash: np.ndarray
    thumb: np.ndarray


@dataclass
class Group:
    id: str
    items: list[ImageFeature]


def main() -> int:
    parser = argparse.ArgumentParser(description="Group same-pattern screenshots by comparing only the main pattern area.")
    parser.add_argument("input_dir", help="Directory containing screenshots.")
    parser.add_argument("--out", default="", help="Output directory. Defaults to <input_dir>.")
    parser.add_argument("--action", choices=("copy", "move"), default="move", help="Copy or move images into group folders.")
    parser.add_argument("--dry-run", action="store_true", help="Only write JSON plan; do not copy/move files.")
    parser.add_argument("--include-singletons", action="store_true", help="Also create folders for groups that contain only one image.")
    parser.add_argument("--recursive", action="store_true", help="Scan images recursively. Default only scans direct child files.")
    parser.add_argument("--top-ratio", type=float, default=0.08, help="Crop this ratio from the top before comparing.")
    parser.add_argument("--bottom-ratio", type=float, default=0.38, help="Crop this ratio from the bottom before comparing.")
    parser.add_argument("--side-ratio", type=float, default=0.02, help="Crop this ratio from left/right before comparing.")
    parser.add_argument("--phash-threshold", type=int, default=10, help="Max pHash Hamming distance for same-pattern match.")
    parser.add_argument("--thumb-threshold", type=float, default=18.0, help="Max mean absolute RGB thumbnail distance.")
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

    image_paths = discover_images(input_dir, args.recursive, out_dir)
    if not image_paths:
        raise SystemExit(f"No images found in: {input_dir}")

    features: list[ImageFeature] = []
    skipped: list[dict[str, str]] = []
    for path in image_paths:
        image = read_image(path)
        if image is None:
            skipped.append({"source": str(path), "reason": "could_not_read"})
            continue
        feature = build_feature(image, path, args.top_ratio, args.bottom_ratio, args.side_ratio, feature_cache, cache_stats)
        skip_reason = feature_skip_reason(feature)
        if skip_reason:
            skipped.append({
                "source": str(path),
                "filename": path.name,
                "reason": skip_reason,
                "pageType": feature.page_type,
                "pairKey": feature.pair_key,
            })
            continue
        features.append(feature)

    groups = cluster_features(features, args.phash_threshold, args.thumb_threshold)
    folder_ids = assign_output_folder_ids(groups, out_dir, args.include_singletons)
    moved_paths: dict[str, Path] = {}
    if not args.dry_run:
        moved_paths = write_groups(groups, out_dir, action=args.action, folder_ids=folder_ids)
    manifest = build_manifest(input_dir, out_dir, groups, skipped, args, folder_ids, feature_cache, cache_stats, moved_paths)
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
        if re.fullmatch(r"G\d+", part, flags=re.IGNORECASE):
            return True
        if re.fullmatch(r"group_\d+", part, flags=re.IGNORECASE):
            return True
        if part == "grouped_patterns":
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


def load_feature_cache(manifest_path: Path) -> dict[str, dict[str, Any]]:
    if not manifest_path.exists():
        return {}
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return {}

    cache: dict[str, dict[str, Any]] = {}
    for group in payload.get("groups", []):
        for item in group.get("items", []):
            source = item.get("source")
            if not source or item.get("size") is None or item.get("mtimeNs") is None:
                continue
            cache[cache_key(Path(source))] = item
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
    if cached.get("pageType") not in {PATTERN_VIEW, PREVIEW_VIEW, COLOR_MODAL, UNKNOWN_VIEW}:
        return None
    return cached


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
        thumb=color_thumb(crop),
    )


def classify_page(image: np.ndarray) -> str:
    if looks_like_color_modal(image):
        return COLOR_MODAL
    if looks_like_preview_view(image):
        return PREVIEW_VIEW
    if count_bottom_circles(image) >= 3:
        return PATTERN_VIEW
    return UNKNOWN_VIEW


def feature_skip_reason(feature: ImageFeature) -> str | None:
    if feature.page_type == UNKNOWN_VIEW:
        return "unrecognized_page_type"
    if feature.page_type in {PREVIEW_VIEW, COLOR_MODAL} and not feature.pair_key:
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
    return white_ratio > 0.55 and extract_pair_key_from_region(image, PREVIEW_VIEW) is not None


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
    if page_type not in {PATTERN_VIEW, PREVIEW_VIEW, COLOR_MODAL}:
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
    if pytesseract is None:
        return None
    height, width = image.shape[:2]
    if page_type == COLOR_MODAL:
        box = find_modal_box(image)
        if box is None:
            crop = image[int(height * 0.08):int(height * 0.20), int(width * 0.10):int(width * 0.80)]
        else:
            x, y, w, h = box
            crop = image[y + int(h * 0.02):y + int(h * 0.11), x + int(w * 0.02):x + int(w * 0.72)]
    else:
        crop = image[int(height * 0.86):int(height * 0.98), :]
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    config = "--psm 7"
    try:
        text = pytesseract.image_to_string(Image.fromarray(gray), config=config)
    except Exception:
        return None
    repaired = repair_pair_numbers_from_text(text)
    if repaired:
        return f"{repaired[0]}_{repaired[1]}"
    return None


def repair_pair_numbers_from_text(text: str) -> list[int]:
    digits = re.sub(r"\D", "", text)
    if len(digits) < 5:
        return []
    # The UI text often OCRs as "52829558" for "52 色号 · 2955 豆":
    # two-ish leading digits for color count, then a 4-digit bead count,
    # sometimes with one stray trailing digit from icons/punctuation.
    candidates: list[tuple[int, int]] = []
    for color_len in (2, 3, 1):
        if len(digits) <= color_len + 2:
            continue
        color_count = int(digits[:color_len])
        if not (1 <= color_count <= 400):
            continue
        tail = digits[color_len:]
        for start in range(0, max(0, len(tail) - 3)):
            bead_text = tail[start:start + 4]
            if len(bead_text) != 4:
                continue
            bead_count = int(bead_text)
            if 100 <= bead_count <= 9999:
                candidates.append((color_count, bead_count))
    if not candidates:
        return []
    def score(pair: tuple[int, int]) -> tuple[int, int, int]:
        color_count, bead_count = pair
        preferred_first_digit = 1 <= int(str(bead_count)[0]) <= 4
        return (0 if preferred_first_digit else 1, 0 if 1000 <= bead_count <= 5000 else 1, abs(color_count - 60))

    color_count, bead_count = min(candidates, key=score)
    return [color_count, bead_count]


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


def color_thumb(image: np.ndarray, size: int = 64) -> np.ndarray:
    resized = cv2.resize(image, (size, size), interpolation=cv2.INTER_AREA)
    return cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32)


def cluster_features(
    features: list[ImageFeature],
    phash_threshold: int,
    thumb_threshold: float,
) -> list[Group]:
    groups: list[Group] = []
    for feature in features:
        best: tuple[float, Group] | None = None
        for group in groups:
            match = group_match_score(feature, group, phash_threshold, thumb_threshold)
            if match is not None and (best is None or match < best[0]):
                best = (match, group)
        if best is None:
            groups.append(Group(id=f"group_{len(groups) + 1:03d}", items=[feature]))
        else:
            best[1].items.append(feature)
    return groups


def group_match_score(
    feature: ImageFeature,
    group: Group,
    phash_threshold: int,
    thumb_threshold: float,
) -> float | None:
    if feature.page_type == PATTERN_VIEW:
        pattern_items = [item for item in group.items if item.page_type == PATTERN_VIEW]
        if not pattern_items:
            return None
        distance = group_distance(feature, Group(group.id, pattern_items))
        if not is_same_pattern(distance, phash_threshold, thumb_threshold):
            return None
        return distance["phashDistance"] + distance["thumbMae"] / 4.0

    if feature.pair_key:
        keys = {item.pair_key for item in group.items if item.pair_key}
        if feature.pair_key in keys:
            # Key-only matching is for cross-page-type pairing. Two pattern pages
            # with the same count still need visual similarity.
            if feature.page_type != PATTERN_VIEW or any(item.page_type != PATTERN_VIEW for item in group.items):
                return 1.0
    return None


def group_distance(feature: ImageFeature, group: Group) -> dict[str, float]:
    distances = [feature_distance(feature, item) for item in group.items]
    return {
        "phashDistance": min(distance["phashDistance"] for distance in distances),
        "thumbMae": min(distance["thumbMae"] for distance in distances),
    }


def feature_distance(a: ImageFeature, b: ImageFeature) -> dict[str, float]:
    return {
        "phashDistance": float(np.count_nonzero(a.phash != b.phash)),
        "thumbMae": float(np.mean(np.abs(a.thumb - b.thumb))),
    }


def is_same_pattern(distance: dict[str, float], phash_threshold: int, thumb_threshold: float) -> bool:
    return distance["phashDistance"] <= phash_threshold and distance["thumbMae"] <= thumb_threshold


def assign_output_folder_ids(groups: list[Group], out_dir: Path, include_singletons: bool) -> dict[str, str]:
    existing_numbers = set()
    if out_dir.exists():
        for path in out_dir.iterdir():
            if not path.is_dir():
                continue
            match = re.fullmatch(r"G(\d+)", path.name, flags=re.IGNORECASE)
            if match:
                existing_numbers.add(int(match.group(1)))

    folder_ids: dict[str, str] = {}
    next_number = 1
    for group in groups:
        if len(group.items) == 1 and not include_singletons:
            continue
        while next_number in existing_numbers:
            next_number += 1
        folder_ids[group.id] = f"G{next_number}"
        existing_numbers.add(next_number)
        next_number += 1
    return folder_ids


def write_groups(groups: list[Group], out_dir: Path, action: str, folder_ids: dict[str, str]) -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    used_names: set[Path] = set()
    moved_paths: dict[str, Path] = {}
    for group in groups:
        folder_id = folder_ids.get(group.id)
        if folder_id is None:
            continue
        group_dir = out_dir / folder_id
        group_dir.mkdir(parents=True, exist_ok=True)
        for index, item in enumerate(group.items, start=1):
            destination = unique_destination(group_dir, item.path, index, used_names)
            if action == "copy":
                shutil.copy2(item.path, destination)
            else:
                shutil.move(str(item.path), str(destination))
            moved_paths[cache_key(item.path)] = destination
    return moved_paths


def unique_destination(group_dir: Path, source: Path, index: int, used_names: set[Path]) -> Path:
    base = f"image_{index:03d}{source.suffix.lower()}"
    destination = group_dir / base
    if destination not in used_names and not destination.exists():
        used_names.add(destination)
        return destination
    stem = source.stem[:80].strip() or "image"
    destination = group_dir / f"image_{index:03d}_{safe_filename(stem)}{source.suffix.lower()}"
    counter = 2
    while destination in used_names or destination.exists():
        destination = group_dir / f"image_{index:03d}_{safe_filename(stem)}_{counter}{source.suffix.lower()}"
        counter += 1
    used_names.add(destination)
    return destination


def build_manifest(
    input_dir: Path,
    out_dir: Path,
    groups: list[Group],
    skipped: list[dict[str, str]],
    args: argparse.Namespace,
    folder_ids: dict[str, str],
    feature_cache: dict[str, dict[str, Any]],
    cache_stats: dict[str, int],
    moved_paths: dict[str, Path],
) -> dict[str, Any]:
    group_rows = []
    planned_folder_names = set(folder_ids.values())
    group_rows.extend(existing_group_rows(input_dir, planned_folder_names, feature_cache, cache_stats))

    for group in groups:
        rows = []
        for item in group.items:
            current_path = moved_paths.get(cache_key(item.path), item.path)
            stat = current_path.stat()
            row: dict[str, Any] = {
                "source": str(current_path),
                "filename": current_path.name,
                "size": stat.st_size,
                "mtimeNs": stat.st_mtime_ns,
                "pageType": item.page_type,
                "pairKey": item.pair_key,
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
            rows.append({
                **row,
            })
        folder_name = folder_ids.get(group.id)
        group_rows.append({
            "id": group.id,
            "count": len(group.items),
            "folderCreated": folder_name is not None,
            "folderName": folder_name,
            "placement": "group_folder" if folder_name is not None else "left_in_place",
            "items": rows,
        })

    return {
        "input": str(input_dir),
        "output": str(out_dir),
        "action": args.action,
        "dryRun": bool(args.dry_run),
        "recursive": bool(args.recursive),
        "includeSingletons": bool(args.include_singletons),
        "cache": {
            "hits": cache_stats.get("hit", 0),
            "misses": cache_stats.get("miss", 0),
            "key": "source + size + mtimeNs",
        },
        "parameters": {
            "topRatio": args.top_ratio,
            "bottomRatio": args.bottom_ratio,
            "sideRatio": args.side_ratio,
            "phashThreshold": args.phash_threshold,
            "thumbThreshold": args.thumb_threshold,
        },
        "imageCount": sum(int(group["count"]) for group in group_rows),
        "groupCount": len(group_rows),
        "groups": group_rows,
        "skipped": skipped,
    }


def existing_group_rows(
    input_dir: Path,
    planned_folder_names: set[str],
    feature_cache: dict[str, dict[str, Any]],
    cache_stats: dict[str, int],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not input_dir.exists():
        return rows
    for folder in sorted(input_dir.iterdir(), key=lambda path: natural_key(path.name)):
        if not folder.is_dir() or not re.fullmatch(r"G\d+", folder.name, flags=re.IGNORECASE):
            continue
        if folder.name in planned_folder_names:
            continue
        items = []
        for file_path in sorted(folder.iterdir(), key=lambda path: natural_key(path.name)):
            if not file_path.is_file() or file_path.suffix.lower() not in IMAGE_EXTENSIONS:
                continue
            image = read_image(file_path)
            stat = file_path.stat()
            if image is None:
                items.append({
                    "source": str(file_path),
                    "filename": file_path.name,
                    "size": stat.st_size,
                    "mtimeNs": stat.st_mtime_ns,
                    "pageType": "unreadable_existing_group",
                    "pairKey": None,
                    "cropBox": None,
                })
                continue
            feature = build_feature(
                image,
                file_path,
                top_ratio=0.08,
                bottom_ratio=0.38,
                side_ratio=0.02,
                feature_cache=feature_cache,
                cache_stats=cache_stats,
            )
            items.append({
                "source": str(file_path),
                "filename": file_path.name,
                "size": stat.st_size,
                "mtimeNs": stat.st_mtime_ns,
                "pageType": feature.page_type,
                "pairKey": feature.pair_key,
                "cropBox": {
                    "x": feature.crop_box[0],
                    "y": feature.crop_box[1],
                    "width": feature.crop_box[2],
                    "height": feature.crop_box[3],
                },
            })
        rows.append({
            "id": f"existing_{folder.name}",
            "count": len(items),
            "folderCreated": True,
            "folderName": folder.name,
            "placement": "group_folder",
            "items": items,
        })
    return rows


def natural_key(value: str) -> list[Any]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value)]


def safe_filename(value: str) -> str:
    import re

    return re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._") or "image"


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
