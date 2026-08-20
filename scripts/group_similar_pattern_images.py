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


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


@dataclass
class ImageFeature:
    path: Path
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
    parser.add_argument("--out", default="", help="Output directory. Defaults to <input_dir>/grouped_patterns.")
    parser.add_argument("--action", choices=("copy", "move"), default="move", help="Copy or move images into group folders.")
    parser.add_argument("--dry-run", action="store_true", help="Only write JSON plan; do not copy/move files.")
    parser.add_argument("--include-singletons", action="store_true", help="Also create folders for groups that contain only one image.")
    parser.add_argument("--recursive", action="store_true", help="Scan images recursively. Default only scans direct child files.")
    parser.add_argument("--top-ratio", type=float, default=0.08, help="Crop this ratio from the top before comparing.")
    parser.add_argument("--bottom-ratio", type=float, default=0.38, help="Crop this ratio from the bottom before comparing.")
    parser.add_argument("--side-ratio", type=float, default=0.02, help="Crop this ratio from left/right before comparing.")
    parser.add_argument("--phash-threshold", type=int, default=10, help="Max pHash Hamming distance for same-pattern match.")
    parser.add_argument("--thumb-threshold", type=float, default=18.0, help="Max mean absolute RGB thumbnail distance.")
    parser.add_argument("--manifest", default="", help="Manifest JSON path. Defaults to <out>/groups.manifest.json.")
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    if not input_dir.is_dir():
        raise SystemExit(f"Input is not a directory: {input_dir}")

    out_dir = Path(args.out) if args.out else input_dir / "grouped_patterns"
    manifest_path = Path(args.manifest) if args.manifest else out_dir / "groups.manifest.json"

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
        features.append(build_feature(image, path, args.top_ratio, args.bottom_ratio, args.side_ratio))

    groups = cluster_features(features, args.phash_threshold, args.thumb_threshold)
    folder_ids = assign_output_folder_ids(groups, out_dir, args.include_singletons)
    manifest = build_manifest(input_dir, out_dir, groups, skipped, args, folder_ids)

    if not args.dry_run:
        write_groups(groups, out_dir, action=args.action, folder_ids=folder_ids)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(str(manifest_path))
    return 0


def discover_images(input_dir: Path, recursive: bool, out_dir: Path) -> list[Path]:
    iterator = input_dir.rglob("*") if recursive else input_dir.iterdir()
    paths = []
    resolved_out = safe_resolve(out_dir)
    for path in iterator:
        if not path.is_file() or path.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        if is_inside(safe_resolve(path), resolved_out):
            continue
        paths.append(path)
    return sorted(paths, key=lambda path: natural_key(path.name))


def read_image(path: Path) -> np.ndarray | None:
    raw = np.fromfile(str(path), dtype=np.uint8)
    if raw.size == 0:
        return None
    return cv2.imdecode(raw, cv2.IMREAD_COLOR)


def build_feature(
    image: np.ndarray,
    path: Path,
    top_ratio: float,
    bottom_ratio: float,
    side_ratio: float,
) -> ImageFeature:
    crop, box = crop_main_pattern(image, top_ratio, bottom_ratio, side_ratio)
    return ImageFeature(
        path=path,
        crop_box=box,
        phash=phash(crop),
        thumb=color_thumb(crop),
    )


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
            distance = group_distance(feature, group)
            if is_same_pattern(distance, phash_threshold, thumb_threshold):
                score = distance["phashDistance"] + distance["thumbMae"] / 4.0
                if best is None or score < best[0]:
                    best = (score, group)
        if best is None:
            groups.append(Group(id=f"group_{len(groups) + 1:03d}", items=[feature]))
        else:
            best[1].items.append(feature)
    return groups


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
            match = re.fullmatch(r"group_(\d+)", path.name)
            if match:
                existing_numbers.add(int(match.group(1)))

    folder_ids: dict[str, str] = {}
    next_number = 1
    for group in groups:
        if len(group.items) == 1 and not include_singletons:
            continue
        while next_number in existing_numbers:
            next_number += 1
        folder_ids[group.id] = f"group_{next_number:03d}"
        existing_numbers.add(next_number)
        next_number += 1
    return folder_ids


def write_groups(groups: list[Group], out_dir: Path, action: str, folder_ids: dict[str, str]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    used_names: set[Path] = set()
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
) -> dict[str, Any]:
    group_rows = []
    for group in groups:
        rows = []
        for item in group.items:
            rows.append({
                "source": str(item.path),
                "filename": item.path.name,
                "cropBox": {
                    "x": item.crop_box[0],
                    "y": item.crop_box[1],
                    "width": item.crop_box[2],
                    "height": item.crop_box[3],
                },
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
        "parameters": {
            "topRatio": args.top_ratio,
            "bottomRatio": args.bottom_ratio,
            "sideRatio": args.side_ratio,
            "phashThreshold": args.phash_threshold,
            "thumbThreshold": args.thumb_threshold,
        },
        "imageCount": sum(len(group.items) for group in groups),
        "groupCount": len(groups),
        "groups": group_rows,
        "skipped": skipped,
    }


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
