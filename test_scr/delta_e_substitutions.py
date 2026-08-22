#!/usr/bin/env python3
"""Find MARD color substitutions with CIEDE2000 / Delta E.

Examples:
    python test_scr/delta_e_substitutions.py --images Image32 Image8
    python test_scr/delta_e_substitutions.py --max-beads 1500 --exclude Image3 Image6
    python test_scr/delta_e_substitutions.py --images Image32 --apply
"""

from __future__ import annotations

import argparse
import csv
import json
from copy import deepcopy
from pathlib import Path
from typing import Any

import numpy as np
from skimage.color import deltaE_ciede2000, rgb2lab


DEFAULT_ANALYSIS = Path("results") / "batch_pic" / "analyze_color_legend.main.json"
DEFAULT_INVENTORY = Path("亚麻色系库存.txt")
DEFAULT_MAPPING = Path("src") / "app" / "colorSystemMapping.json"


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def hex_to_lab(hex_code: str) -> np.ndarray:
    hex_value = hex_code.lstrip("#")
    rgb = np.array(
        [[[int(hex_value[i : i + 2], 16) / 255 for i in (0, 2, 4)]]],
        dtype=float,
    )
    return rgb2lab(rgb)


def delta_e(lab_by_key: dict[str, np.ndarray], a: str, b: str) -> float:
    return float(deltaE_ciede2000(lab_by_key[a], lab_by_key[b])[0, 0])


def load_inventory(path: Path) -> tuple[dict[str, int], list[str]]:
    with path.open(encoding="utf-8", newline="") as file:
        rows = list(csv.DictReader(file))

    if not rows:
        raise ValueError(f"Inventory is empty: {path}")

    count_column = "remaining" if "remaining" in rows[0] else "ownedCount"
    stock: dict[str, int] = {}
    palette: list[str] = []
    seen_palette: set[str] = set()
    for row in rows:
        key = row["colorKey"]
        stock[key] = stock.get(key, 0) + int(row[count_column])
        if key != "T1" and key not in seen_palette:
            palette.append(key)
            seen_palette.add(key)
    return stock, palette


def load_labs(mapping_path: Path) -> tuple[dict[str, str], dict[str, np.ndarray]]:
    mapping = load_json(mapping_path)
    hex_by_key = {
        row["MARD"]: hex_code
        for hex_code, row in mapping.items()
        if isinstance(row, dict) and row.get("MARD")
    }
    lab_by_key = {key: hex_to_lab(hex_code) for key, hex_code in hex_by_key.items()}
    return hex_by_key, lab_by_key


def choose_best_substitution(
    source_key: str,
    need: int,
    stock: dict[str, int],
    palette: list[str],
    lab_by_key: dict[str, np.ndarray],
) -> tuple[str, float] | None:
    if source_key not in lab_by_key:
        return None

    candidates: list[tuple[float, str]] = []
    for target_key in palette:
        if target_key not in lab_by_key:
            continue
        if stock.get(target_key, 0) < need:
            continue
        candidates.append((delta_e(lab_by_key, source_key, target_key), target_key))

    return min(candidates) if candidates else None


def substitute_counts(
    counts: dict[str, int],
    stock: dict[str, int],
    palette: list[str],
    lab_by_key: dict[str, np.ndarray],
) -> tuple[dict[str, int], list[dict[str, Any]], list[dict[str, Any]]]:
    new_counts: dict[str, int] = {}
    working_stock = dict(stock)
    substitutions: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []

    for source_key, need in sorted(counts.items()):
        if working_stock.get(source_key, 0) >= need:
            working_stock[source_key] -= need
            new_counts[source_key] = new_counts.get(source_key, 0) + need
            continue

        best = choose_best_substitution(source_key, need, working_stock, palette, lab_by_key)
        if best is None:
            failures.append({"from": source_key, "need": need})
            new_counts[source_key] = new_counts.get(source_key, 0) + need
            continue

        distance, target_key = best
        working_stock[target_key] -= need
        new_counts[target_key] = new_counts.get(target_key, 0) + need
        substitutions.append(
            {
                "from": source_key,
                "to": target_key,
                "count": need,
                "deltaE": round(distance, 2),
            }
        )

    return new_counts, substitutions, failures


def image_matches_args(image: dict[str, Any], args: argparse.Namespace) -> bool:
    image_id = image.get("id", "")
    if args.images and image_id not in args.images:
        return False
    if image_id in args.exclude:
        return False
    if args.max_beads is not None and int(image.get("totalBeads", 0)) > args.max_beads:
        return False
    return True


def apply_counts(image: dict[str, Any], new_counts: dict[str, int]) -> None:
    old_transparent = image.get("countsWithTransparent", {}).get("transparent")
    image["colorCounts"] = new_counts
    if "countsWithTransparent" in image:
        with_transparent = dict(new_counts)
        if old_transparent is not None:
            with_transparent["transparent"] = old_transparent
        image["countsWithTransparent"] = with_transparent
    image["totalColorKeys"] = len(new_counts)
    image["expected"] = f"{image['totalColorKeys']}_{image['totalBeads']}"
    image["matchesExpected"] = sum(new_counts.values()) == int(image["totalBeads"])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compute MARD substitutions using CIEDE2000 / Delta E."
    )
    parser.add_argument("--analysis", type=Path, default=DEFAULT_ANALYSIS)
    parser.add_argument("--inventory", type=Path, default=DEFAULT_INVENTORY)
    parser.add_argument("--mapping", type=Path, default=DEFAULT_MAPPING)
    parser.add_argument("--images", nargs="*", default=[])
    parser.add_argument("--exclude", nargs="*", default=[])
    parser.add_argument("--max-beads", type=int)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write substitutions back to the analysis JSON.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    data = load_json(args.analysis)
    stock, palette = load_inventory(args.inventory)
    _, lab_by_key = load_labs(args.mapping)

    changed: list[str] = []
    for image in data.get("images", []):
        if not image_matches_args(image, args):
            continue

        new_counts, substitutions, failures = substitute_counts(
            image["colorCounts"], stock, palette, lab_by_key
        )
        if not substitutions and not failures:
            continue

        image_id = image.get("id", "")
        print(
            f"{image_id}\tbeads={image.get('totalBeads')}"
            f"\tcolors={image.get('totalColorKeys')}"
            f"\tsubs={len(substitutions)}\tfailures={len(failures)}"
        )
        for item in substitutions:
            print(
                f"  {item['from']}->{item['to']}:{item['count']}"
                f" dE={item['deltaE']:.2f}"
            )
        for item in failures:
            print(f"  NO_SUB {item['from']}:{item['need']}")

        if args.apply and substitutions and not failures:
            apply_counts(image, new_counts)
            changed.append(image_id)

    if args.apply:
        args.analysis.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print("applied=" + ",".join(changed))


if __name__ == "__main__":
    main()
