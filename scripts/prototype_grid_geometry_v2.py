#!/usr/bin/env python3
"""Prototype v2 grid geometry detector.

This version estimates a square grid from text-like centers first. It does not
need known row/column counts and treats axis-profile/grid-line detection as a
fallback idea, not the primary signal.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import cv2
import numpy as np


DEFAULT_GRID_SIZE = 52
GRID_SIZE_CHOICES = (52, 104)


@dataclass
class ImageData:
    width: int
    height: int
    rgb: np.ndarray


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
class TextCandidate:
    x: float
    y: float
    width: float
    height: float
    area: float
    score: float
    inlier: bool = False
    row: Optional[int] = None
    col: Optional[int] = None
    residual: Optional[float] = None


@dataclass
class SquareGridGeometry:
    origin_x: float
    origin_y: float
    pitch: float
    confidence: float
    row_min: int
    row_max: int
    col_min: int
    col_max: int


@dataclass
class FitResult:
    geometry: SquareGridGeometry
    score: float
    inlier_indices: List[int]
    avg_residual: float
    direct_support: int


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--out-dir", default="results/grid-prototype-v2")
    parser.add_argument("--grid-size", "--board-size", dest="grid_size", type=int, choices=GRID_SIZE_CHOICES, default=DEFAULT_GRID_SIZE)
    parser.add_argument("--max-candidates", type=int, default=1800)
    parser.add_argument("--debug-all-candidates", action="store_true")
    args = parser.parse_args()

    image_path = Path(args.image)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    image = load_image(image_path)
    result = detect_text_lattice(image, args.grid_size, args.max_candidates)

    stem = image_path.stem
    geometry = result.geometry
    grid_bounds = geometry_to_bounds(geometry, image.width, image.height)

    for idx, candidate in enumerate(result.candidates):
        if idx in set(result.fit.inlier_indices):
            candidate.inlier = True

    payload = {
        "imageSize": {"width": image.width, "height": image.height},
        "mode": "text-lattice-v2",
        "crop": bounds_to_json(grid_bounds),
        "geometry": {
            "centerX": geometry.origin_x,
            "centerY": geometry.origin_y,
            "pitchX": geometry.pitch,
            "pitchY": geometry.pitch,
            "centerIsCellCenter": True,
        },
        "grid": {
            "rows": geometry.row_max - geometry.row_min + 1,
            "cols": geometry.col_max - geometry.col_min + 1,
            "gridSize": args.grid_size,
            "rowMin": geometry.row_min,
            "rowMax": geometry.row_max,
            "colMin": geometry.col_min,
            "colMax": geometry.col_max,
        },
        "debug": {
            "confidence": {"overall": geometry.confidence},
            "candidateCount": len(result.candidates),
            "inlierCount": len(result.fit.inlier_indices),
            "avgResidual": result.fit.avg_residual,
            "directSupport": result.fit.direct_support,
            "fitScore": result.fit.score,
            "gridSize": args.grid_size,
            "pitch": geometry.pitch,
        },
        "textCenters": [candidate_to_json(c) for c in result.candidates if c.inlier],
    }

    json_path = out_dir / f"{stem}.geometry.v2.json"
    svg_path = out_dir / f"{stem}.grid_overlay.v2.svg"
    json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    write_svg_overlay(
        svg_path,
        image_path,
        image,
        grid_bounds,
        geometry,
        result.candidates,
        args.debug_all_candidates,
    )
    print(json.dumps({"ok": True, "json": str(json_path), "svg": str(svg_path)}, ensure_ascii=False))
    return 0


@dataclass
class DetectionResult:
    geometry: SquareGridGeometry
    fit: FitResult
    candidates: List[TextCandidate]


def load_image(path: Path) -> ImageData:
    raw = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if raw is None:
        raise RuntimeError(f"Could not load image: {path}")

    if raw.ndim == 2:
        rgb = cv2.cvtColor(raw, cv2.COLOR_GRAY2RGB)
    elif raw.shape[2] == 4:
        bgra = raw.astype(np.float32)
        alpha = bgra[:, :, 3:4] / 255.0
        bgr = bgra[:, :, :3] * alpha + 255.0 * (1.0 - alpha)
        rgb = cv2.cvtColor(np.clip(bgr, 0, 255).astype(np.uint8), cv2.COLOR_BGR2RGB)
    else:
        rgb = cv2.cvtColor(raw, cv2.COLOR_BGR2RGB)

    height, width = rgb.shape[:2]
    return ImageData(width=width, height=height, rgb=rgb)


def detect_text_lattice(image: ImageData, grid_size: int, max_candidates: int) -> DetectionResult:
    candidates = detect_text_candidates(image)
    if not candidates:
        raise RuntimeError("No text-like candidates were found.")

    candidates = rank_and_limit_candidates(candidates, max_candidates)
    fit = fit_square_lattice(candidates, image.width, image.height, grid_size)
    if fit is None:
        raise RuntimeError(f"Could not fit a square lattice from {len(candidates)} candidates.")

    candidates = assign_candidates(candidates, fit.geometry, fit.inlier_indices)
    return DetectionResult(geometry=fit.geometry, fit=fit, candidates=candidates)


def detect_text_candidates(image: ImageData) -> List[TextCandidate]:
    gray = cv2.cvtColor(image.rgb, cv2.COLOR_RGB2GRAY)
    min_dim = min(image.width, image.height)
    blur_size = make_odd(clamp(int(min_dim / 34), 21, 61))
    background = cv2.GaussianBlur(gray, (blur_size, blur_size), 0)

    dark_delta = cv2.subtract(background, gray)
    bright_delta = cv2.subtract(gray, background)
    local_contrast = cv2.max(dark_delta, bright_delta)

    nonzero = local_contrast[local_contrast > 0]
    if nonzero.size:
        contrast_threshold = max(14, int(np.percentile(nonzero, 88)))
    else:
        contrast_threshold = 18

    dark_threshold = max(70, int(np.percentile(gray, 18)))
    bright_threshold = min(215, int(np.percentile(gray, 82)))
    dark_mask = (gray < dark_threshold) & (dark_delta > 8)
    bright_mask = (gray > bright_threshold) & (bright_delta > 10)
    contrast_mask = local_contrast > contrast_threshold
    mask = (dark_mask | bright_mask | contrast_mask).astype(np.uint8) * 255

    mask = remove_long_lines(mask, image.width, image.height)
    open_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, open_kernel, iterations=1)

    join_w = clamp(int(min_dim / 190), 5, 13)
    join_h = clamp(int(min_dim / 520), 2, 5)
    join_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (join_w, join_h))
    joined = cv2.dilate(mask, join_kernel, iterations=1)
    joined = cv2.morphologyEx(joined, cv2.MORPH_CLOSE, join_kernel, iterations=1)

    return connected_text_components(joined, local_contrast, image.width, image.height)


def remove_long_lines(mask: np.ndarray, width: int, height: int) -> np.ndarray:
    min_dim = min(width, height)
    horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(18, int(min_dim / 28)), 1))
    vertical_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(18, int(min_dim / 28))))
    horizontal = cv2.morphologyEx(mask, cv2.MORPH_OPEN, horizontal_kernel, iterations=1)
    vertical = cv2.morphologyEx(mask, cv2.MORPH_OPEN, vertical_kernel, iterations=1)
    lines = cv2.max(horizontal, vertical)
    return cv2.bitwise_and(mask, cv2.bitwise_not(lines))


def connected_text_components(
    mask: np.ndarray,
    contrast: np.ndarray,
    image_width: int,
    image_height: int,
) -> List[TextCandidate]:
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(mask, 8)
    image_area = image_width * image_height
    min_dim = min(image_width, image_height)

    min_area = max(6, image_area / 400000)
    max_area = max(120, image_area / 130)
    max_w = min_dim * 0.22
    max_h = min_dim * 0.14
    candidates: List[TextCandidate] = []

    for label in range(1, count):
        x, y, w, h, area = stats[label]
        if area < min_area or area > max_area:
            continue
        if w < 3 or h < 3 or w > max_w or h > max_h:
            continue
        aspect = w / max(1, h)
        if aspect < 0.12 or aspect > 9.0:
            continue
        fill = area / max(1, w * h)
        if fill < 0.04 or fill > 0.88:
            continue

        region = contrast[y : y + h, x : x + w]
        contrast_score = float(np.mean(region[labels[y : y + h, x : x + w] == label])) if region.size else 0.0
        shape_score = min(1.0, area / max(1.0, w * h * 0.35))
        score = contrast_score * (0.5 + shape_score)
        cx, cy = centroids[label]
        candidates.append(
            TextCandidate(
                x=float(cx),
                y=float(cy),
                width=float(w),
                height=float(h),
                area=float(area),
                score=float(score),
            )
        )

    return candidates


def rank_and_limit_candidates(candidates: List[TextCandidate], max_candidates: int) -> List[TextCandidate]:
    if len(candidates) <= max_candidates:
        return candidates
    ranked = sorted(candidates, key=lambda c: c.score, reverse=True)
    return sorted(ranked[:max_candidates], key=lambda c: (c.y, c.x))


def fit_square_lattice(
    candidates: Sequence[TextCandidate],
    image_width: int,
    image_height: int,
    grid_size: int,
) -> Optional[FitResult]:
    pitch_candidates = propose_pitch_candidates(candidates, image_width, image_height, grid_size)
    if not pitch_candidates:
        return None

    best: Optional[FitResult] = None
    for pitch in pitch_candidates:
        phase_x = fit_periodic_phase([c.x for c in candidates], pitch)
        phase_y = fit_periodic_phase([c.y for c in candidates], pitch)
        offset_x = choose_axis_offset(candidates, phase_x, pitch, grid_size, "x", image_width)
        offset_y = choose_axis_offset(candidates, phase_y, pitch, grid_size, "y", image_height)
        fit = evaluate_lattice(candidates, offset_x, offset_y, pitch, grid_size, image_width, image_height)
        if fit is None:
            continue
        if best is None or fit.score > best.score:
            best = fit
    return best


def propose_pitch_candidates(
    candidates: Sequence[TextCandidate],
    image_width: int,
    image_height: int,
    grid_size: int,
) -> List[float]:
    min_dim = min(image_width, image_height)
    min_pitch = max(6.0, min_dim / max(20, grid_size + 8))
    max_pitch = min(95.0, min_dim / 10.0)
    median_h = median_value([c.height for c in candidates]) or 8.0
    median_w = median_value([c.width for c in candidates]) or 8.0
    near_y = max(4.0, median_h * 0.8)
    near_x = max(4.0, median_w * 0.55)

    points = sorted(candidates, key=lambda c: c.score, reverse=True)[:900]
    bins: Dict[int, float] = {}

    def add_pitch(value: float, weight: float) -> None:
        if value < min_pitch or value > max_pitch:
            return
        key = int(round(value * 2.0))
        bins[key] = bins.get(key, 0.0) + weight

    for i, a in enumerate(points):
        for b in points[i + 1 :]:
            dx = abs(a.x - b.x)
            dy = abs(a.y - b.y)
            if dy <= near_y and dx >= min_pitch:
                add_distance_as_pitch(dx, add_pitch)
            if dx <= near_x and dy >= min_pitch:
                add_distance_as_pitch(dy, add_pitch)

    if not bins:
        return []

    ranked = sorted(bins.items(), key=lambda item: item[1], reverse=True)[:100]
    raw = [key / 2.0 for key, _ in ranked]
    refined = sorted(set(round(refine_pitch_from_neighbors(points, p), 3) for p in raw))
    return sorted(refined, key=lambda p: -pitch_direct_support(points, p))[:80]


def add_distance_as_pitch(distance: float, add_pitch) -> None:
    for divisor in range(1, 9):
        pitch = distance / divisor
        weight = 4.0 if divisor == 1 else 1.4 / math.sqrt(divisor)
        add_pitch(pitch, weight)


def refine_pitch_from_neighbors(candidates: Sequence[TextCandidate], pitch: float) -> float:
    values: List[float] = []
    tol = max(2.0, pitch * 0.12)
    for i, a in enumerate(candidates):
        for b in candidates[i + 1 :]:
            dx = abs(a.x - b.x)
            dy = abs(a.y - b.y)
            if abs(dx - pitch) <= tol and dy <= max(5.0, pitch * 0.22):
                values.append(dx)
            if abs(dy - pitch) <= tol and dx <= max(5.0, pitch * 0.22):
                values.append(dy)
    if len(values) >= 3:
        return float(np.median(values))
    return pitch


def pitch_direct_support(candidates: Sequence[TextCandidate], pitch: float) -> int:
    tol = max(2.2, pitch * 0.14)
    same = max(5.0, pitch * 0.22)
    support = 0
    points = candidates[:700]
    for i, a in enumerate(points):
        for b in points[i + 1 :]:
            dx = abs(a.x - b.x)
            dy = abs(a.y - b.y)
            if abs(dx - pitch) <= tol and dy <= same:
                support += 1
            if abs(dy - pitch) <= tol and dx <= same:
                support += 1
    return support


def fit_periodic_phase(values: Sequence[float], pitch: float) -> float:
    mods = np.array([v % pitch for v in values], dtype=np.float64)
    if mods.size == 0:
        return 0.0

    bin_count = max(24, int(round(pitch * 2)))
    hist, edges = np.histogram(mods, bins=bin_count, range=(0.0, pitch))
    smooth = hist.astype(np.float64)
    for _ in range(2):
        smooth = np.roll(smooth, -1) * 0.25 + smooth * 0.5 + np.roll(smooth, 1) * 0.25
    best_bin = int(np.argmax(smooth))
    phase = (edges[best_bin] + edges[best_bin + 1]) / 2.0

    tol = max(2.5, pitch * 0.18)
    close = [m for m in mods if abs(periodic_delta(m, phase, pitch)) <= tol]
    if close:
        deltas = [periodic_delta(m, phase, pitch) for m in close]
        phase = (phase + float(np.mean(deltas))) % pitch
    return phase


def choose_axis_offset(
    candidates: Sequence[TextCandidate],
    phase: float,
    pitch: float,
    grid_size: int,
    axis: str,
    image_extent: int,
) -> float:
    tol = max(2.4, pitch * 0.19)
    values = [c.x if axis == "x" else c.y for c in candidates]
    if not values:
        return phase

    lattice_indices = [int(round((v - phase) / pitch)) for v in values]
    k_min = min(lattice_indices) - grid_size + 1
    k_max = max(lattice_indices)
    center = image_extent / 2.0

    best_k = k_min
    best_score = -1.0
    for k in range(k_min, k_max + 1):
        offset = phase + k * pitch
        score = 0.0
        for candidate, value in zip(candidates, values):
            idx = int(round((value - offset) / pitch))
            if idx < 0 or idx >= grid_size:
                continue
            predicted = offset + idx * pitch
            error = abs(value - predicted)
            if error > tol:
                continue
            center_weight = 1.0 + 0.35 * max(0.0, 1.0 - abs(value - center) / max(1.0, center))
            score += center_weight * max(0.0, 1.0 - error / tol) * max(0.5, min(2.0, candidate.score / 55.0))

        if score > best_score:
            best_score = score
            best_k = k

    return phase + best_k * pitch


def evaluate_lattice(
    candidates: Sequence[TextCandidate],
    offset_x: float,
    offset_y: float,
    pitch: float,
    grid_size: int,
    image_width: int,
    image_height: int,
) -> Optional[FitResult]:
    tol = max(2.4, pitch * 0.19)
    residuals: List[float] = []
    occupied: Dict[Tuple[int, int], int] = {}
    weighted_match_score = 0.0
    image_cx = image_width / 2.0
    image_cy = image_height / 2.0

    for idx, candidate in enumerate(candidates):
        col = int(round((candidate.x - offset_x) / pitch))
        row = int(round((candidate.y - offset_y) / pitch))
        if col < 0 or col >= grid_size or row < 0 or row >= grid_size:
            continue
        predicted_x = offset_x + col * pitch
        predicted_y = offset_y + row * pitch
        dx = candidate.x - predicted_x
        dy = candidate.y - predicted_y
        residual = math.hypot(dx, dy)
        if abs(dx) <= tol and abs(dy) <= tol and residual <= tol * 1.35:
            key = (row, col)
            previous = occupied.get(key)
            if previous is None or candidate.score > candidates[previous].score:
                occupied[key] = idx
            center_weight = 1.0 + 0.35 * max(
                0.0,
                1.0 - math.hypot(candidate.x - image_cx, candidate.y - image_cy) / max(1.0, math.hypot(image_cx, image_cy)),
            )
            weighted_match_score += center_weight * max(0.0, 1.0 - residual / (tol * 1.35))

    occupied = filter_lattice_components(occupied)
    inlier_indices = list(occupied.values())
    if len(inlier_indices) < 8:
        return None

    keys = set(occupied.keys())
    rows = [r for r, _ in keys]
    cols = [c for _, c in keys]
    row_min, row_max = min(rows), max(rows)
    col_min, col_max = min(cols), max(cols)
    span_rows = row_max - row_min + 1
    span_cols = col_max - col_min + 1
    if span_rows < 2 or span_cols < 2:
        return None

    direct = 0
    for row, col in keys:
        if (row, col + 1) in keys:
            direct += 1
        if (row + 1, col) in keys:
            direct += 1

    for idx in inlier_indices:
        candidate = candidates[idx]
        col = int(round((candidate.x - offset_x) / pitch))
        row = int(round((candidate.y - offset_y) / pitch))
        dx = candidate.x - (offset_x + col * pitch)
        dy = candidate.y - (offset_y + row * pitch)
        residuals.append(math.hypot(dx, dy))

    avg_residual = float(np.mean(residuals)) if residuals else 999.0
    density_penalty = max(0, span_rows * span_cols - len(keys)) * 0.025
    score = len(keys) * 10.0 + direct * 16.0 + weighted_match_score * 5.0 - avg_residual * 3.5 - density_penalty
    confidence = clamp_float((len(keys) / max(12.0, len(candidates) * 0.28)) * 0.45 + min(0.4, direct / 90.0) + max(0.0, 0.15 - avg_residual / max(1.0, pitch)), 0.05, 0.98)

    geometry = SquareGridGeometry(
        origin_x=offset_x,
        origin_y=offset_y,
        pitch=pitch,
        confidence=round(confidence, 3),
        row_min=0,
        row_max=grid_size - 1,
        col_min=0,
        col_max=grid_size - 1,
    )
    return FitResult(geometry=geometry, score=score, inlier_indices=inlier_indices, avg_residual=avg_residual, direct_support=direct)


def filter_lattice_components(occupied: Dict[Tuple[int, int], int]) -> Dict[Tuple[int, int], int]:
    keys = set(occupied.keys())
    if len(keys) < 12:
        return occupied

    components: List[List[Tuple[int, int]]] = []
    visited: set[Tuple[int, int]] = set()
    radius = 2

    for key in keys:
        if key in visited:
            continue
        stack = [key]
        visited.add(key)
        component: List[Tuple[int, int]] = []
        while stack:
            current = stack.pop()
            component.append(current)
            row, col = current
            for dr in range(-radius, radius + 1):
                for dc in range(-radius, radius + 1):
                    if dr == 0 and dc == 0:
                        continue
                    if abs(dr) + abs(dc) > radius + 1:
                        continue
                    nxt = (row + dr, col + dc)
                    if nxt in keys and nxt not in visited:
                        visited.add(nxt)
                        stack.append(nxt)
        components.append(component)

    if not components:
        return occupied

    largest = max(len(c) for c in components)
    min_keep = max(8, int(largest * 0.18))
    kept: set[Tuple[int, int]] = set()
    for component in components:
        rows = [r for r, _ in component]
        cols = [c for _, c in component]
        span_rows = max(rows) - min(rows) + 1
        span_cols = max(cols) - min(cols) + 1
        is_two_dimensional = span_rows >= 4 and span_cols >= 4
        if len(component) == largest or (len(component) >= min_keep and is_two_dimensional):
            kept.update(component)

    if len(kept) < max(8, largest):
        best = max(components, key=len)
        kept = set(best)

    return {key: occupied[key] for key in kept}


def assign_candidates(
    candidates: Sequence[TextCandidate],
    geometry: SquareGridGeometry,
    inlier_indices: Sequence[int],
) -> List[TextCandidate]:
    inlier_set = set(inlier_indices)
    out: List[TextCandidate] = []
    for idx, candidate in enumerate(candidates):
        copy = TextCandidate(
            x=candidate.x,
            y=candidate.y,
            width=candidate.width,
            height=candidate.height,
            area=candidate.area,
            score=candidate.score,
        )
        dx = periodic_delta(candidate.x, geometry.origin_x, geometry.pitch)
        dy = periodic_delta(candidate.y, geometry.origin_y, geometry.pitch)
        copy.residual = math.hypot(dx, dy)
        copy.col = int(round((candidate.x - geometry.origin_x) / geometry.pitch))
        copy.row = int(round((candidate.y - geometry.origin_y) / geometry.pitch))
        copy.inlier = idx in inlier_set
        out.append(copy)
    return out


def expand_geometry_with_content(
    image: ImageData,
    geometry: SquareGridGeometry,
    candidates: Sequence[TextCandidate],
) -> SquareGridGeometry:
    gray = cv2.cvtColor(image.rgb, cv2.COLOR_RGB2GRAY)
    hsv = cv2.cvtColor(image.rgb, cv2.COLOR_RGB2HSV)
    saturation = hsv[:, :, 1]
    content_mask = ((gray < 246) | (saturation > 18)).astype(np.uint8)

    occupied: Dict[Tuple[int, int], float] = {}
    row_start = int(math.floor((0 - geometry.origin_y) / geometry.pitch)) - 1
    row_end = int(math.ceil((image.height - geometry.origin_y) / geometry.pitch)) + 1
    col_start = int(math.floor((0 - geometry.origin_x) / geometry.pitch)) - 1
    col_end = int(math.ceil((image.width - geometry.origin_x) / geometry.pitch)) + 1
    half = max(2, int(round(geometry.pitch * 0.32)))

    for row in range(row_start, row_end + 1):
        cy = geometry.origin_y + row * geometry.pitch
        y0 = int(max(0, round(cy - half)))
        y1 = int(min(image.height, round(cy + half + 1)))
        if y1 <= y0:
            continue
        for col in range(col_start, col_end + 1):
            cx = geometry.origin_x + col * geometry.pitch
            x0 = int(max(0, round(cx - half)))
            x1 = int(min(image.width, round(cx + half + 1)))
            if x1 <= x0:
                continue
            patch = content_mask[y0:y1, x0:x1]
            ratio = float(np.mean(patch))
            if ratio > 0.18:
                occupied[(row, col)] = ratio

    inlier_keys = {(c.row, c.col) for c in candidates if c.inlier and c.row is not None and c.col is not None}
    if not inlier_keys:
        return geometry

    kept = keep_content_near_text_components(occupied, inlier_keys)
    keys = set(kept.keys()) | {(int(r), int(c)) for r, c in inlier_keys}
    if not keys:
        return geometry

    rows = [r for r, _ in keys]
    cols = [c for _, c in keys]
    return SquareGridGeometry(
        origin_x=geometry.origin_x,
        origin_y=geometry.origin_y,
        pitch=geometry.pitch,
        confidence=geometry.confidence,
        row_min=min(rows),
        row_max=max(rows),
        col_min=min(cols),
        col_max=max(cols),
    )


def keep_content_near_text_components(
    occupied: Dict[Tuple[int, int], float],
    inlier_keys: Iterable[Tuple[Optional[int], Optional[int]]],
) -> Dict[Tuple[int, int], float]:
    occupied_keys = set(occupied.keys())
    required = {(int(r), int(c)) for r, c in inlier_keys if r is not None and c is not None}
    visited: set[Tuple[int, int]] = set()
    kept: Dict[Tuple[int, int], float] = {}

    for key in list(occupied_keys):
        if key in visited:
            continue
        stack = [key]
        component: List[Tuple[int, int]] = []
        visited.add(key)
        touches_text = False
        while stack:
            current = stack.pop()
            component.append(current)
            if current in required:
                touches_text = True
            row, col = current
            for nxt in ((row - 1, col), (row + 1, col), (row, col - 1), (row, col + 1)):
                if nxt in occupied_keys and nxt not in visited:
                    visited.add(nxt)
                    stack.append(nxt)

        if touches_text or len(component) >= 8:
            for item in component:
                kept[item] = occupied[item]

    return kept


def geometry_to_bounds(geometry: SquareGridGeometry, width: int, height: int) -> Bounds:
    left = geometry.origin_x + geometry.col_min * geometry.pitch - geometry.pitch / 2.0
    right = geometry.origin_x + geometry.col_max * geometry.pitch + geometry.pitch / 2.0
    top = geometry.origin_y + geometry.row_min * geometry.pitch - geometry.pitch / 2.0
    bottom = geometry.origin_y + geometry.row_max * geometry.pitch + geometry.pitch / 2.0
    return Bounds(
        left=max(0.0, left),
        top=max(0.0, top),
        right=min(float(width), right),
        bottom=min(float(height), bottom),
    )


def write_svg_overlay(
    path: Path,
    image_path: Path,
    image: ImageData,
    bounds: Bounds,
    geometry: SquareGridGeometry,
    candidates: Sequence[TextCandidate],
    debug_all_candidates: bool,
) -> None:
    data_uri = image_to_data_uri(image_path)
    lines: List[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{image.width}" height="{image.height}" viewBox="0 0 {image.width} {image.height}">',
        f'<image href="{data_uri}" x="0" y="0" width="{image.width}" height="{image.height}" preserveAspectRatio="none"/>',
        '<g fill="none" stroke-linecap="square">',
        f'<rect x="{bounds.left:.3f}" y="{bounds.top:.3f}" width="{bounds.width:.3f}" height="{bounds.height:.3f}" stroke="#ef4444" stroke-width="3"/>',
    ]

    pitch = geometry.pitch
    for col in range(geometry.col_min, geometry.col_max + 2):
        x = geometry.origin_x + col * pitch - pitch / 2.0
        if -pitch <= x <= image.width + pitch:
            lines.append(f'<line x1="{x:.3f}" y1="{bounds.top:.3f}" x2="{x:.3f}" y2="{bounds.bottom:.3f}" stroke="#2563eb" stroke-width="1" opacity="0.9"/>')
    for row in range(geometry.row_min, geometry.row_max + 2):
        y = geometry.origin_y + row * pitch - pitch / 2.0
        if -pitch <= y <= image.height + pitch:
            lines.append(f'<line x1="{bounds.left:.3f}" y1="{y:.3f}" x2="{bounds.right:.3f}" y2="{y:.3f}" stroke="#2563eb" stroke-width="1" opacity="0.9"/>')

    cross = max(8.0, pitch * 0.45)
    lines.append(f'<line x1="{geometry.origin_x - cross:.3f}" y1="{geometry.origin_y:.3f}" x2="{geometry.origin_x + cross:.3f}" y2="{geometry.origin_y:.3f}" stroke="#dc2626" stroke-width="2"/>')
    lines.append(f'<line x1="{geometry.origin_x:.3f}" y1="{geometry.origin_y - cross:.3f}" x2="{geometry.origin_x:.3f}" y2="{geometry.origin_y + cross:.3f}" stroke="#dc2626" stroke-width="2"/>')
    lines.append("</g>")

    dot_radius = max(2.0, min(5.0, pitch * 0.13))
    if debug_all_candidates:
        lines.append('<g fill="#f97316" opacity="0.65">')
        for c in candidates:
            if not c.inlier:
                lines.append(f'<circle cx="{c.x:.3f}" cy="{c.y:.3f}" r="{dot_radius:.3f}"/>')
        lines.append("</g>")

    lines.append('<g fill="#22c55e" stroke="#064e3b" stroke-width="1" opacity="0.92">')
    for c in candidates:
        if c.inlier:
            lines.append(f'<circle cx="{c.x:.3f}" cy="{c.y:.3f}" r="{dot_radius:.3f}"/>')
    lines.append("</g>")

    label = f"pitch={geometry.pitch:.3f} rows={geometry.row_max - geometry.row_min + 1} cols={geometry.col_max - geometry.col_min + 1} conf={geometry.confidence:.3f}"
    lines.append(f'<text x="16" y="28" font-family="Arial, sans-serif" font-size="22" fill="#dc2626" stroke="white" stroke-width="4" paint-order="stroke">{escape_xml(label)}</text>')
    lines.append("</svg>")
    path.write_text("\n".join(lines), encoding="utf-8")


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


def candidate_to_json(candidate: TextCandidate) -> Dict[str, object]:
    return {
        "x": candidate.x,
        "y": candidate.y,
        "row": candidate.row,
        "col": candidate.col,
        "residual": candidate.residual,
        "width": candidate.width,
        "height": candidate.height,
        "score": candidate.score,
    }


def bounds_to_json(bounds: Bounds) -> Dict[str, float]:
    return {
        "left": bounds.left,
        "top": bounds.top,
        "right": bounds.right,
        "bottom": bounds.bottom,
        "width": bounds.width,
        "height": bounds.height,
    }


def periodic_delta(value: float, phase: float, period: float) -> float:
    return ((value - phase + period / 2.0) % period) - period / 2.0


def median_value(values: Sequence[float]) -> Optional[float]:
    if not values:
        return None
    return float(np.median(np.array(values, dtype=np.float64)))


def clamp(value: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, value))


def clamp_float(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def make_odd(value: int) -> int:
    return value if value % 2 == 1 else value + 1


def escape_xml(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


if __name__ == "__main__":
    raise SystemExit(main())
