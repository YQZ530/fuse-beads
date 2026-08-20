#!/usr/bin/env python3
"""Prototype v3 grid geometry detector.

This version follows the text-lattice fitting flow:
detect text centers, estimate a square pitch from direct neighbors, fit the
infinite lattice phase, choose the finite 52x52/104x104 window, then globally
refine origin_x, origin_y, and one shared square pitch.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np


DEFAULT_GRID_SIZE = 52
GRID_SIZE_CHOICES = (52, 104)
DEFAULT_OUT_DIR = Path(r"C:\Users\z5308\Desktop\perler-beads-analysis\results\grid-prototype")


@dataclass
class ImageData:
    width: int
    height: int
    bgr: np.ndarray


@dataclass
class TextCenter:
    x: float
    y: float
    width: int
    height: int
    area: int
    row: Optional[int] = None
    col: Optional[int] = None
    residual: Optional[float] = None
    matched: bool = False


@dataclass
class OccupiedCell:
    candidate_index: int
    row: int
    col: int
    residual: float


@dataclass
class FitResult:
    grid_size: int
    origin_x: float
    origin_y: float
    pitch: float
    occupied: Dict[Tuple[int, int], OccupiedCell]
    candidate_count: int
    avg_residual: Optional[float]
    median_residual: Optional[float]
    max_residual: Optional[float]
    confidence: float

    @property
    def left(self) -> float:
        return self.origin_x - self.pitch / 2.0

    @property
    def top(self) -> float:
        return self.origin_y - self.pitch / 2.0

    @property
    def right(self) -> float:
        return self.origin_x + (self.grid_size - 1) * self.pitch + self.pitch / 2.0

    @property
    def bottom(self) -> float:
        return self.origin_y + (self.grid_size - 1) * self.pitch + self.pitch / 2.0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--grid-size", "--board-size", dest="grid_size", type=int, choices=GRID_SIZE_CHOICES, default=DEFAULT_GRID_SIZE)
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--debug-all-candidates", action="store_true")
    args = parser.parse_args()

    image_path = Path(args.image)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    image = load_image(image_path)
    result, centers, text_mask = fit_grid(image, args.grid_size)
    apply_matches_to_centers(centers, result.occupied)

    stem = image_path.stem
    json_path = out_dir / f"{stem}.geometry.v3.json"
    svg_path = out_dir / f"{stem}.grid_overlay.v3.svg"
    mask_path = out_dir / f"{stem}.text_mask.v3.png"

    payload = result_to_payload(image, result, centers)
    json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    write_svg_overlay(svg_path, image_path, image, result, centers, args.debug_all_candidates)
    write_gray_image(mask_path, text_mask)

    print(json.dumps({"ok": True, "json": str(json_path), "svg": str(svg_path), "mask": str(mask_path)}, ensure_ascii=False))
    return 0


def load_image(path: Path) -> ImageData:
    raw = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if raw is None:
        raise RuntimeError(f"Could not load image: {path}")

    if raw.ndim == 2:
        bgr = cv2.cvtColor(raw, cv2.COLOR_GRAY2BGR)
    elif raw.shape[2] == 4:
        bgra = raw.astype(np.float32)
        alpha = bgra[:, :, 3:4] / 255.0
        bgr = bgra[:, :, :3] * alpha + 255.0 * (1.0 - alpha)
        bgr = np.clip(bgr, 0, 255).astype(np.uint8)
    else:
        bgr = raw

    height, width = bgr.shape[:2]
    return ImageData(width=width, height=height, bgr=bgr)


def detect_text_centers(image: ImageData, grid_size: int) -> Tuple[List[TextCenter], np.ndarray]:
    gray = cv2.cvtColor(image.bgr, cv2.COLOR_BGR2GRAY)
    min_dim = min(image.width, image.height)
    expected_pitch = min_dim / grid_size

    sigma = max(0.8, expected_pitch * 0.05)
    blurred = cv2.GaussianBlur(gray, (0, 0), sigma)
    high_pass = cv2.absdiff(gray, blurred)
    mask = (high_pass > 18).astype(np.uint8) * 255

    line_length = max(10, int(expected_pitch * 0.58))
    horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (line_length, 1))
    vertical_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, line_length))
    horizontal = cv2.morphologyEx(mask, cv2.MORPH_OPEN, horizontal_kernel)
    vertical = cv2.morphologyEx(mask, cv2.MORPH_OPEN, vertical_kernel)
    long_lines = cv2.max(horizontal, vertical)
    mask = cv2.bitwise_and(mask, cv2.bitwise_not(long_lines))

    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2)))
    join_w = max(2, int(round(expected_pitch * 0.10)))
    mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_RECT, (join_w, 1)), iterations=1)

    count, _labels, stats, centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
    min_h = max(3, int(expected_pitch * 0.12))
    max_h = max(min_h + 1, int(expected_pitch * 0.60))
    min_w = max(3, int(expected_pitch * 0.12))
    max_w = max(min_w + 1, int(expected_pitch * 0.95))
    min_area = max(5, int(expected_pitch * expected_pitch * 0.008))
    max_area = max(60, int(expected_pitch * expected_pitch * 0.24))

    centers: List[TextCenter] = []
    for idx in range(1, count):
        x, y, w, h, area = stats[idx]
        if h < min_h or h > max_h or w < min_w or w > max_w:
            continue
        if area < min_area or area > max_area:
            continue
        aspect = w / max(h, 1)
        if aspect < 0.30 or aspect > 4.5:
            continue
        cx, cy = centroids[idx]
        centers.append(TextCenter(x=float(cx), y=float(cy), width=int(w), height=int(h), area=int(area)))

    return centers, mask


def estimate_pitch(centers: Sequence[TextCenter], image_width: int, image_height: int, grid_size: int) -> float:
    points = np.array([[p.x, p.y] for p in centers], dtype=np.float64)
    min_dim = min(image_width, image_height)
    min_pitch = min_dim / (grid_size + 8)
    max_pitch = min_dim / max(1, grid_size - 8)
    expected_pitch = min_dim / grid_size
    same_axis_tolerance = max(1.5, expected_pitch * 0.08)
    distances: List[float] = []

    for i, a in enumerate(points):
        others = points[i + 1 :]
        if len(others) == 0:
            continue
        delta = others - a
        dx = np.abs(delta[:, 0])
        dy = np.abs(delta[:, 1])
        same_row = (dy <= same_axis_tolerance) & (dx >= min_pitch) & (dx <= max_pitch)
        same_col = (dx <= same_axis_tolerance) & (dy >= min_pitch) & (dy <= max_pitch)
        distances.extend(dx[same_row].tolist())
        distances.extend(dy[same_col].tolist())

    if not distances:
        raise RuntimeError("Could not estimate pitch from text centers.")

    bin_size = 0.25
    bins = np.arange(min_pitch, max_pitch + bin_size, bin_size)
    hist, edges = np.histogram(distances, bins=bins)
    best_bin = int(np.argmax(hist))
    pitch0 = float((edges[best_bin] + edges[best_bin + 1]) / 2.0)
    refine_tolerance = max(0.8, pitch0 * 0.035)
    nearby = [d for d in distances if abs(d - pitch0) <= refine_tolerance]
    return float(np.median(nearby)) if nearby else pitch0


def fit_grid(image: ImageData, grid_size: int) -> Tuple[FitResult, List[TextCenter], np.ndarray]:
    centers, text_mask = detect_text_centers(image, grid_size)
    if len(centers) < 10:
        raise RuntimeError(f"Too few text candidates: {len(centers)}")

    pitch = estimate_pitch(centers, image.width, image.height, grid_size)
    xs = [c.x for c in centers]
    ys = [c.y for c in centers]
    phase_x = fit_phase(xs, pitch)
    phase_y = fit_phase(ys, pitch)

    x_start = best_window_start(lattice_index_counts(xs, phase_x, pitch), grid_size)
    y_start = best_window_start(lattice_index_counts(ys, phase_y, pitch), grid_size)
    origin_x = phase_x + x_start * pitch
    origin_y = phase_y + y_start * pitch

    origin_x, origin_y, pitch, occupied = global_refine(centers, origin_x, origin_y, pitch, grid_size)
    residuals = [item.residual for item in occupied.values()]
    confidence = calculate_confidence(occupied, centers, grid_size, residuals, pitch)

    return (
        FitResult(
            grid_size=grid_size,
            origin_x=origin_x,
            origin_y=origin_y,
            pitch=pitch,
            occupied=occupied,
            candidate_count=len(centers),
            avg_residual=float(np.mean(residuals)) if residuals else None,
            median_residual=float(np.median(residuals)) if residuals else None,
            max_residual=float(np.max(residuals)) if residuals else None,
            confidence=confidence,
        ),
        centers,
        text_mask,
    )


def periodic_delta(value: float, phase: float, period: float) -> float:
    return ((value - phase + period / 2.0) % period) - period / 2.0


def fit_phase(values: Sequence[float], pitch: float) -> float:
    mods = np.mod(np.asarray(values, dtype=np.float64), pitch)
    hist, edges = np.histogram(mods, bins=160, range=(0.0, pitch))
    best = int(np.argmax(hist))
    phase = float((edges[best] + edges[best + 1]) / 2.0)
    deltas = np.array([periodic_delta(float(m), phase, pitch) for m in mods])
    close = np.abs(deltas) <= max(2.0, pitch * 0.10)
    if np.any(close):
        phase = (phase + float(np.mean(deltas[close]))) % pitch
    return phase


def lattice_index_counts(values: Sequence[float], phase: float, pitch: float) -> Dict[int, int]:
    counts: Dict[int, int] = {}
    tolerance = max(3.0, pitch * 0.15)
    for value in values:
        k = int(round((value - phase) / pitch))
        predicted = phase + k * pitch
        if abs(value - predicted) <= tolerance:
            counts[k] = counts.get(k, 0) + 1
    return counts


def best_window_start(counts: Dict[int, int], grid_size: int) -> int:
    if not counts:
        return 0
    minimum = min(counts)
    maximum = max(counts)
    best_start = minimum
    best_score = -1
    for start in range(minimum - grid_size + 1, maximum + 1):
        score = sum(counts.get(k, 0) for k in range(start, start + grid_size))
        if score > best_score:
            best_score = score
            best_start = start
    return best_start


def assign_cells(
    centers: Sequence[TextCenter],
    origin_x: float,
    origin_y: float,
    pitch: float,
    grid_size: int,
    tolerance: Optional[float] = None,
) -> Dict[Tuple[int, int], OccupiedCell]:
    if tolerance is None:
        tolerance = max(3.0, pitch * 0.16)

    occupied: Dict[Tuple[int, int], OccupiedCell] = {}
    for index, candidate in enumerate(centers):
        col = int(round((candidate.x - origin_x) / pitch))
        row = int(round((candidate.y - origin_y) / pitch))
        if col < 0 or col >= grid_size or row < 0 or row >= grid_size:
            continue

        grid_x = origin_x + col * pitch
        grid_y = origin_y + row * pitch
        dx = candidate.x - grid_x
        dy = candidate.y - grid_y
        residual = math.hypot(dx, dy)
        if abs(dx) > tolerance or abs(dy) > tolerance:
            continue

        key = (row, col)
        previous = occupied.get(key)
        if previous is None or residual < previous.residual:
            occupied[key] = OccupiedCell(candidate_index=index, row=row, col=col, residual=residual)

    return occupied


def global_refine(
    centers: Sequence[TextCenter],
    origin_x: float,
    origin_y: float,
    pitch: float,
    grid_size: int,
    iterations: int = 5,
) -> Tuple[float, float, float, Dict[Tuple[int, int], OccupiedCell]]:
    occupied: Dict[Tuple[int, int], OccupiedCell] = {}
    for _ in range(iterations):
        occupied = assign_cells(centers, origin_x, origin_y, pitch, grid_size)
        if len(occupied) < 10:
            break

        matrix: List[List[float]] = []
        values: List[float] = []
        for item in occupied.values():
            candidate = centers[item.candidate_index]
            matrix.append([1.0, 0.0, float(item.col)])
            values.append(candidate.x)
            matrix.append([0.0, 1.0, float(item.row)])
            values.append(candidate.y)

        solved, *_ = np.linalg.lstsq(np.asarray(matrix, dtype=np.float64), np.asarray(values, dtype=np.float64), rcond=None)
        new_origin_x, new_origin_y, new_pitch = map(float, solved)
        if not all(math.isfinite(v) for v in (new_origin_x, new_origin_y, new_pitch)) or new_pitch <= 1.0:
            break
        origin_x, origin_y, pitch = new_origin_x, new_origin_y, new_pitch

    occupied = assign_cells(centers, origin_x, origin_y, pitch, grid_size)
    return origin_x, origin_y, pitch, occupied


def calculate_confidence(
    occupied: Dict[Tuple[int, int], OccupiedCell],
    centers: Sequence[TextCenter],
    grid_size: int,
    residuals: Sequence[float],
    pitch: float,
) -> float:
    if not occupied:
        return 0.05

    rows = [cell.row for cell in occupied.values()]
    cols = [cell.col for cell in occupied.values()]
    span_rows = max(rows) - min(rows) + 1
    span_cols = max(cols) - min(cols) + 1
    spatial_coverage = ((span_rows / grid_size) + (span_cols / grid_size)) / 2.0
    matched_ratio = min(1.0, len(occupied) / max(12.0, len(centers) * 0.75))
    avg_residual = float(np.mean(residuals)) if residuals else pitch
    residual_score = max(0.0, 1.0 - avg_residual / max(1.0, pitch * 0.18))
    return round(clamp_float(matched_ratio * 0.45 + spatial_coverage * 0.35 + residual_score * 0.20, 0.05, 0.98), 3)


def apply_matches_to_centers(centers: Sequence[TextCenter], occupied: Dict[Tuple[int, int], OccupiedCell]) -> None:
    for item in occupied.values():
        center = centers[item.candidate_index]
        center.row = item.row
        center.col = item.col
        center.residual = item.residual
        center.matched = True


def result_to_payload(image: ImageData, result: FitResult, centers: Sequence[TextCenter]) -> Dict[str, object]:
    return {
        "imageSize": {"width": image.width, "height": image.height},
        "mode": "text-lattice-v3",
        "crop": {
            "left": max(0.0, result.left),
            "top": max(0.0, result.top),
            "right": min(float(image.width), result.right),
            "bottom": min(float(image.height), result.bottom),
            "width": max(0.0, min(float(image.width), result.right) - max(0.0, result.left)),
            "height": max(0.0, min(float(image.height), result.bottom) - max(0.0, result.top)),
        },
        "geometry": {
            "centerX": result.origin_x,
            "centerY": result.origin_y,
            "pitchX": result.pitch,
            "pitchY": result.pitch,
            "centerIsCellCenter": True,
        },
        "grid": {
            "rows": result.grid_size,
            "cols": result.grid_size,
            "gridSize": result.grid_size,
            "rowMin": 0,
            "rowMax": result.grid_size - 1,
            "colMin": 0,
            "colMax": result.grid_size - 1,
        },
        "debug": {
            "confidence": {"overall": result.confidence},
            "candidateCount": result.candidate_count,
            "matchedCellCount": len(result.occupied),
            "inlierCount": len(result.occupied),
            "avgResidual": result.avg_residual,
            "medianResidual": result.median_residual,
            "maxResidual": result.max_residual,
            "gridSize": result.grid_size,
            "pitch": result.pitch,
            "bounds": {"left": result.left, "top": result.top, "right": result.right, "bottom": result.bottom},
        },
        "textCenters": [center_to_json(c) for c in centers if c.matched],
    }


def center_to_json(center: TextCenter) -> Dict[str, object]:
    return {
        "x": center.x,
        "y": center.y,
        "row": center.row,
        "col": center.col,
        "residual": center.residual,
        "width": center.width,
        "height": center.height,
        "area": center.area,
        "inlier": center.matched,
    }


def write_svg_overlay(
    path: Path,
    image_path: Path,
    image: ImageData,
    result: FitResult,
    centers: Sequence[TextCenter],
    debug_all_candidates: bool,
) -> None:
    data_uri = image_to_data_uri(image_path)
    bounds_left = max(0.0, result.left)
    bounds_top = max(0.0, result.top)
    bounds_right = min(float(image.width), result.right)
    bounds_bottom = min(float(image.height), result.bottom)
    bounds_width = max(0.0, bounds_right - bounds_left)
    bounds_height = max(0.0, bounds_bottom - bounds_top)

    lines: List[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{image.width}" height="{image.height}" viewBox="0 0 {image.width} {image.height}">',
        f'<image href="{data_uri}" x="0" y="0" width="{image.width}" height="{image.height}" preserveAspectRatio="none"/>',
        '<g fill="none" stroke-linecap="square">',
        f'<rect x="{bounds_left:.3f}" y="{bounds_top:.3f}" width="{bounds_width:.3f}" height="{bounds_height:.3f}" stroke="#ef4444" stroke-width="3"/>',
    ]

    for col in range(result.grid_size + 1):
        x = result.left + col * result.pitch
        if -result.pitch <= x <= image.width + result.pitch:
            lines.append(f'<line x1="{x:.3f}" y1="{bounds_top:.3f}" x2="{x:.3f}" y2="{bounds_bottom:.3f}" stroke="#2563eb" stroke-width="1" opacity="0.9"/>')
    for row in range(result.grid_size + 1):
        y = result.top + row * result.pitch
        if -result.pitch <= y <= image.height + result.pitch:
            lines.append(f'<line x1="{bounds_left:.3f}" y1="{y:.3f}" x2="{bounds_right:.3f}" y2="{y:.3f}" stroke="#2563eb" stroke-width="1" opacity="0.9"/>')

    cross = max(8.0, result.pitch * 0.45)
    lines.append(f'<line x1="{result.origin_x - cross:.3f}" y1="{result.origin_y:.3f}" x2="{result.origin_x + cross:.3f}" y2="{result.origin_y:.3f}" stroke="#dc2626" stroke-width="2"/>')
    lines.append(f'<line x1="{result.origin_x:.3f}" y1="{result.origin_y - cross:.3f}" x2="{result.origin_x:.3f}" y2="{result.origin_y + cross:.3f}" stroke="#dc2626" stroke-width="2"/>')
    lines.append("</g>")

    dot_radius = max(2.0, min(5.0, result.pitch * 0.13))
    if debug_all_candidates:
        lines.append('<g fill="#f97316" opacity="0.65">')
        for center in centers:
            if not center.matched:
                lines.append(f'<circle cx="{center.x:.3f}" cy="{center.y:.3f}" r="{dot_radius:.3f}"/>')
        lines.append("</g>")

    lines.append('<g fill="#22c55e" stroke="#064e3b" stroke-width="1" opacity="0.92">')
    for center in centers:
        if center.matched:
            lines.append(f'<circle cx="{center.x:.3f}" cy="{center.y:.3f}" r="{dot_radius:.3f}"/>')
    lines.append("</g>")

    label = f"v3 {result.grid_size}x{result.grid_size} pitch={result.pitch:.4f} matches={len(result.occupied)} conf={result.confidence:.3f}"
    lines.append(f'<text x="16" y="28" font-family="Arial, sans-serif" font-size="22" fill="#dc2626" stroke="white" stroke-width="4" paint-order="stroke">{escape_xml(label)}</text>')
    lines.append("</svg>")
    path.write_text("\n".join(lines), encoding="utf-8")


def write_gray_image(path: Path, image: np.ndarray) -> None:
    ok, encoded = cv2.imencode(path.suffix or ".png", image)
    if not ok:
        raise RuntimeError(f"Could not encode image: {path}")
    encoded.tofile(str(path))


def image_to_data_uri(path: Path) -> str:
    ext = path.suffix.lower()
    mime = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }.get(ext, "application/octet-stream")
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def clamp_float(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def escape_xml(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


if __name__ == "__main__":
    raise SystemExit(main())
