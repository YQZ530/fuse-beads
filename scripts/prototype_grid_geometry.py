#!/usr/bin/env python3
"""Prototype grid geometry detector used by the Next.js analysis API."""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from statistics import median
from typing import Iterable, List, Optional, Sequence, Tuple


AUTO_MIN_GRID_CELLS = 18
AUTO_MAX_GRID_CELLS = 115


@dataclass
class ImageData:
    width: int
    height: int
    rgba: bytes


@dataclass
class Bounds:
    left: float
    top: float
    right: float
    bottom: float

    @property
    def width(self) -> float:
        return max(1.0, self.right - self.left)

    @property
    def height(self) -> float:
        return max(1.0, self.bottom - self.top)


@dataclass
class Geometry:
    center_x: float
    center_y: float
    pitch_x: float
    pitch_y: float
    center_is_cell_center: bool = False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--out-dir", default="results/grid-prototype")
    parser.add_argument("--cols", type=int)
    parser.add_argument("--rows", type=int)
    parser.add_argument("--use-crop", action="store_true")
    args = parser.parse_args()

    image_path = Path(args.image)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    image = load_image(image_path)
    crop = Bounds(0, 0, image.width, image.height)
    geometry, confidence, mode, detection_area = detect_geometry(image, crop, args.cols, args.rows, args.use_crop)

    stem = image_path.stem
    result = {
        "imageSize": {"width": image.width, "height": image.height},
        "mode": mode,
        "crop": bounds_to_json(detection_area),
        "geometry": {
            "centerX": geometry.center_x,
            "centerY": geometry.center_y,
            "pitchX": geometry.pitch_x,
            "pitchY": geometry.pitch_y,
            "centerIsCellCenter": geometry.center_is_cell_center,
        },
        "debug": {
            "confidence": {"overall": confidence},
            "pitchConfidence": {"overall": confidence},
        },
    }

    json_path = out_dir / f"{stem}.geometry.json"
    json_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    write_svg_overlay(out_dir / f"{stem}.grid_overlay.svg", image_path, image, detection_area, geometry)
    print(json.dumps({"ok": True, "json": str(json_path)}, ensure_ascii=False))
    return 0


def load_image(path: Path) -> ImageData:
    try:
        from PIL import Image  # type: ignore

        with Image.open(path) as img:
            rgba_img = img.convert("RGBA")
            return ImageData(rgba_img.width, rgba_img.height, rgba_img.tobytes())
    except Exception:
        return load_image_with_sharp(path)


def load_image_with_sharp(path: Path) -> ImageData:
    with tempfile.TemporaryDirectory() as temp:
        raw_path = Path(temp) / "image.rgba"
        meta_path = Path(temp) / "image.json"
        script = (
            "const sharp=require('sharp');"
            "const fs=require('fs');"
            "sharp(process.argv[1]).ensureAlpha().raw()"
            ".toBuffer({resolveWithObject:true})"
            ".then(({data,info})=>{fs.writeFileSync(process.argv[2],data);"
            "fs.writeFileSync(process.argv[3],JSON.stringify({width:info.width,height:info.height}));})"
            ".catch(err=>{console.error(err && err.stack || err); process.exit(1);});"
        )
        subprocess.run(
            ["node", "-e", script, str(path), str(raw_path), str(meta_path)],
            cwd=Path.cwd(),
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        return ImageData(int(meta["width"]), int(meta["height"]), raw_path.read_bytes())


def detect_geometry(
    image: ImageData,
    crop: Bounds,
    cols: Optional[int],
    rows: Optional[int],
    use_crop: bool,
) -> Tuple[Geometry, float, str, Bounds]:
    content = detect_content_bounds(image, crop)
    scan = expand_bounds(content, image.width, image.height, 0.03)
    detection_area = crop if use_crop else refine_scan_area(scan, image.width, image.height)

    if cols and rows and cols > 0 and rows > 0:
        pitch_x = detection_area.width / cols
        pitch_y = detection_area.height / rows
        return (
            Geometry(detection_area.left, detection_area.top, max(1.0, pitch_x), max(1.0, pitch_y), False),
            0.86,
            "manual",
            detection_area,
        )

    vertical = axis_profile(image, detection_area, "x")
    horizontal = axis_profile(image, detection_area, "y")
    pitch_x, conf_x = estimate_pitch(vertical, detection_area.width)
    pitch_y, conf_y = estimate_pitch(horizontal, detection_area.height)

    if not pitch_x:
        pitch_x = max(1.0, detection_area.width / 50)
        conf_x = 0.25
    if not pitch_y:
        pitch_y = max(1.0, detection_area.height / 50)
        conf_y = 0.25

    pitch = choose_square_pitch(pitch_x, pitch_y, detection_area.width, detection_area.height)
    pitch_x = pitch
    pitch_y = pitch

    anchor_x = detection_area.left + find_anchor(vertical, pitch_x, detection_area.width)
    anchor_y = detection_area.top + find_anchor(horizontal, pitch_y, detection_area.height)
    confidence = round(max(0.1, min(0.95, (conf_x + conf_y) / 2)), 3)
    return Geometry(anchor_x, anchor_y, pitch_x, pitch_y, True), confidence, "auto", detection_area


def detect_content_bounds(image: ImageData, crop: Bounds) -> Bounds:
    left = int(max(0, math.floor(crop.left)))
    top = int(max(0, math.floor(crop.top)))
    right = int(min(image.width, math.ceil(crop.right)))
    bottom = int(min(image.height, math.ceil(crop.bottom)))
    xs: List[int] = []
    ys: List[int] = []
    step = max(1, int(math.sqrt(max(1, (right - left) * (bottom - top)) / 90000)))

    for y in range(top, bottom, step):
        for x in range(left, right, step):
            r, g, b, a = pixel(image, x, y)
            if a < 32:
                continue
            luma = get_luma(r, g, b)
            saturation = max(r, g, b) - min(r, g, b)
            if luma < 246 or saturation > 18:
                xs.append(x)
                ys.append(y)

    if len(xs) < 20:
        return crop

    return Bounds(
        percentile(xs, 0.01),
        percentile(ys, 0.01),
        percentile(xs, 0.99) + 1,
        percentile(ys, 0.99) + 1,
    )


def refine_scan_area(bounds: Bounds, image_width: int, image_height: int) -> Bounds:
    width = bounds.width
    height = bounds.height
    if height > width * 1.12:
        height = min(height, width * 1.05)
    elif width > height * 1.12:
        width = min(width, height * 1.05)

    return Bounds(
        max(0.0, bounds.left),
        max(0.0, bounds.top),
        min(float(image_width), bounds.left + width),
        min(float(image_height), bounds.top + height),
    )


def axis_profile(image: ImageData, bounds: Bounds, axis: str) -> List[float]:
    left = int(max(0, math.floor(bounds.left)))
    top = int(max(0, math.floor(bounds.top)))
    right = int(min(image.width, math.ceil(bounds.right)))
    bottom = int(min(image.height, math.ceil(bounds.bottom)))
    if axis == "x":
        length = max(1, right - left)
        profile = [0.0] * length
        y_step = max(1, (bottom - top) // 700)
        for xi, x in enumerate(range(left, right)):
            score = 0.0
            samples = 0
            prev = None
            for y in range(top, bottom, y_step):
                r, g, b, a = pixel(image, x, y)
                luma = 255 if a < 32 else get_luma(r, g, b)
                if prev is not None:
                    score += abs(prev - luma)
                if luma < 90:
                    score += 40
                prev = luma
                samples += 1
            profile[xi] = score / max(1, samples)
        return smooth(profile, 2)

    length = max(1, bottom - top)
    profile = [0.0] * length
    x_step = max(1, (right - left) // 700)
    for yi, y in enumerate(range(top, bottom)):
        score = 0.0
        samples = 0
        prev = None
        for x in range(left, right, x_step):
            r, g, b, a = pixel(image, x, y)
            luma = 255 if a < 32 else get_luma(r, g, b)
            if prev is not None:
                score += abs(prev - luma)
            if luma < 90:
                score += 40
            prev = luma
            samples += 1
        profile[yi] = score / max(1, samples)
    return smooth(profile, 2)


def estimate_pitch(profile: Sequence[float], span: float) -> Tuple[Optional[float], float]:
    peaks = find_peaks(profile)
    if len(peaks) >= 3:
        min_pitch, max_pitch = get_auto_pitch_bounds(span)
        gaps = [
            peaks[index + 1] - peaks[index]
            for index in range(len(peaks) - 1)
            if min_pitch * 0.5 <= peaks[index + 1] - peaks[index] <= max_pitch * 8
        ]
        pitch = robust_pitch_from_gaps(gaps, span)
        if pitch:
            return pitch, min(0.92, 0.35 + len(gaps) / max(12, span / pitch) * 0.55)

    pitch = autocorrelation_pitch(profile, span)
    return (pitch, 0.45) if pitch else (None, 0.0)


def robust_pitch_from_gaps(gaps: Sequence[int], span: float) -> Optional[float]:
    if not gaps:
        return None
    min_pitch, max_pitch = get_auto_pitch_bounds(span)
    candidates: List[float] = []
    for gap in gaps:
        for divisor in range(1, 7):
            value = gap / divisor
            if min_pitch <= value <= max_pitch:
                candidates.append(round(value * 2) / 2)
    if not candidates:
        return None

    best_pitch = None
    best_score = 0.0
    for candidate in sorted(set(candidates)):
        score = 0.0
        for gap in gaps:
            multiple = round(gap / candidate)
            if multiple < 1 or multiple > 8:
                continue
            error = abs(gap - candidate * multiple) / candidate
            if error <= 0.18:
                score += (1 - error / 0.18) / math.sqrt(multiple)

        grid_count = span / candidate if candidate > 0 else 0
        if grid_count < AUTO_MIN_GRID_CELLS or grid_count > AUTO_MAX_GRID_CELLS:
            score *= 0.25

        if score > best_score:
            best_pitch = candidate
            best_score = score

    return float(best_pitch) if best_pitch and best_score >= 2.0 else None


def autocorrelation_pitch(profile: Sequence[float], span: float) -> Optional[float]:
    if len(profile) < 16:
        return None
    norm = normalize(profile)
    min_pitch_value, max_pitch_value = get_auto_pitch_bounds(span)
    min_pitch = max(3, int(math.floor(min_pitch_value)))
    max_pitch = min(len(profile) // 2, int(math.ceil(max_pitch_value)))
    best_pitch = None
    best_score = 0.0
    for pitch in range(min_pitch, max_pitch + 1):
        score = 0.0
        count = 0
        for index in range(0, len(norm) - pitch, max(1, pitch // 5)):
            score += norm[index] * norm[index + pitch]
            count += 1
        if count:
            score /= count
        if score > best_score:
            best_score = score
            best_pitch = pitch
    return float(best_pitch) if best_pitch and best_score > 0.08 else None


def get_auto_pitch_bounds(span: float) -> Tuple[float, float]:
    min_pitch = max(8.0, span / AUTO_MAX_GRID_CELLS)
    max_pitch = min(110.0, max(18.0, span / AUTO_MIN_GRID_CELLS))
    return min_pitch, max_pitch


def choose_square_pitch(pitch_x: float, pitch_y: float, width: float, height: float) -> float:
    candidates = [
        pitch_x,
        pitch_y,
        (pitch_x + pitch_y) / 2,
        math.sqrt(max(1e-6, pitch_x * pitch_y)),
    ]
    best = None
    best_score = float("inf")

    for candidate in candidates:
        if not candidate or candidate <= 0:
            continue
        cols = width / candidate
        rows = height / candidate
        if cols < AUTO_MIN_GRID_CELLS or rows < AUTO_MIN_GRID_CELLS:
            penalty = 4.0
        elif cols > AUTO_MAX_GRID_CELLS or rows > AUTO_MAX_GRID_CELLS:
            penalty = 4.0
        else:
            penalty = 0.0

        score = abs(math.log(candidate / pitch_x)) + abs(math.log(candidate / pitch_y)) + penalty
        if score < best_score:
            best = candidate
            best_score = score

    return float(best if best else max(1.0, (pitch_x + pitch_y) / 2))


def find_anchor(profile: Sequence[float], pitch: float, span: float) -> float:
    peaks = find_peaks(profile)
    center = span / 2
    if peaks:
        return float(min(peaks, key=lambda item: abs(item - center)))
    return round(center / pitch) * pitch


def find_peaks(profile: Sequence[float]) -> List[int]:
    if not profile:
        return []
    baseline = percentile(profile, 0.55)
    high = percentile(profile, 0.90)
    threshold = baseline + (high - baseline) * 0.45
    min_distance = max(3, len(profile) // 180)
    peaks: List[int] = []
    last = -10**9
    for index in range(1, len(profile) - 1):
        value = profile[index]
        if value < threshold or value < profile[index - 1] or value < profile[index + 1]:
            continue
        if index - last < min_distance:
            if peaks and value > profile[peaks[-1]]:
                peaks[-1] = index
                last = index
            continue
        peaks.append(index)
        last = index
    return peaks


def write_svg_overlay(path: Path, image_path: Path, image: ImageData, crop: Bounds, geometry: Geometry) -> None:
    x_lines = axis_boundaries(crop.left, crop.right, geometry.center_x, geometry.pitch_x, geometry.center_is_cell_center)
    y_lines = axis_boundaries(crop.top, crop.bottom, geometry.center_y, geometry.pitch_y, geometry.center_is_cell_center)
    background_href = image_to_data_url(image_path)
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{image.width}" height="{image.height}" viewBox="0 0 {image.width} {image.height}">',
        f'<image x="0" y="0" width="{image.width}" height="{image.height}" href="{background_href}" preserveAspectRatio="none"/>',
        f'<rect x="{crop.left:.3f}" y="{crop.top:.3f}" width="{crop.width:.3f}" height="{crop.height:.3f}" fill="none" stroke="#ef4444" stroke-width="3"/>',
    ]
    for x in x_lines:
        parts.append(f'<line x1="{x:.3f}" y1="{crop.top:.3f}" x2="{x:.3f}" y2="{crop.bottom:.3f}" stroke="#2563eb" stroke-width="1" opacity="0.85"/>')
    for y in y_lines:
        parts.append(f'<line x1="{crop.left:.3f}" y1="{y:.3f}" x2="{crop.right:.3f}" y2="{y:.3f}" stroke="#2563eb" stroke-width="1" opacity="0.85"/>')
    parts.append(f'<line x1="{geometry.center_x - 18:.3f}" y1="{geometry.center_y:.3f}" x2="{geometry.center_x + 18:.3f}" y2="{geometry.center_y:.3f}" stroke="#ef4444" stroke-width="3"/>')
    parts.append(f'<line x1="{geometry.center_x:.3f}" y1="{geometry.center_y - 18:.3f}" x2="{geometry.center_x:.3f}" y2="{geometry.center_y + 18:.3f}" stroke="#ef4444" stroke-width="3"/>')
    parts.append("</svg>")
    path.write_text("\n".join(parts), encoding="utf-8")


def image_to_data_url(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".png":
        mime = "image/png"
    elif suffix == ".webp":
        mime = "image/webp"
    else:
        mime = "image/jpeg"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def axis_boundaries(start: float, end: float, center: float, pitch: float, center_is_cell_center: bool) -> List[float]:
    anchor = center - pitch / 2 if center_is_cell_center else center
    first = math.floor((start - anchor) / pitch) - 1
    last = math.ceil((end - anchor) / pitch) + 1
    values = [start]
    for index in range(first, last + 1):
        value = anchor + index * pitch
        if start < value < end:
            values.append(value)
    values.append(end)
    return dedupe(sorted(values), 0.01)


def pixel(image: ImageData, x: int, y: int) -> Tuple[int, int, int, int]:
    index = (y * image.width + x) * 4
    data = image.rgba
    return data[index], data[index + 1], data[index + 2], data[index + 3]


def get_luma(r: int, g: int, b: int) -> float:
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def smooth(values: Sequence[float], radius: int) -> List[float]:
    result = []
    for index in range(len(values)):
        left = max(0, index - radius)
        right = min(len(values), index + radius + 1)
        result.append(sum(values[left:right]) / max(1, right - left))
    return result


def normalize(values: Sequence[float]) -> List[float]:
    low = percentile(values, 0.45)
    high = percentile(values, 0.95)
    scale = max(1e-6, high - low)
    return [max(0.0, min(1.0, (value - low) / scale)) for value in values]


def percentile(values: Sequence[float] | Sequence[int], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(float(value) for value in values)
    index = max(0, min(len(ordered) - 1, int(round((len(ordered) - 1) * q))))
    return ordered[index]


def expand_bounds(bounds: Bounds, width: int, height: int, ratio: float) -> Bounds:
    pad_x = bounds.width * ratio
    pad_y = bounds.height * ratio
    return Bounds(
        max(0.0, bounds.left - pad_x),
        max(0.0, bounds.top - pad_y),
        min(float(width), bounds.right + pad_x),
        min(float(height), bounds.bottom + pad_y),
    )


def dedupe(values: Iterable[float], tolerance: float) -> List[float]:
    result: List[float] = []
    for value in values:
        if not result or abs(value - result[-1]) > tolerance:
            result.append(value)
    return result


def bounds_to_json(bounds: Bounds) -> dict:
    return {"left": bounds.left, "top": bounds.top, "right": bounds.right, "bottom": bounds.bottom}


if __name__ == "__main__":
    raise SystemExit(main())
