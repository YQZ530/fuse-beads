#!/usr/bin/env python3
"""Print remaining inventory after selected images.

This script does not modify any files.

Examples:
    python test_scr/calc_remaining_inventory.py --selected Image3 Image6
    python test_scr/calc_remaining_inventory.py --selected Image3 Image6 Image22 --extra H11=300
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any


DEFAULT_ANALYSIS = Path("results") / "batch_pic" / "analyze_color_legend.main.json"
DEFAULT_INVENTORY = Path("亚麻色系库存.txt")


def load_analysis(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_inventory(path: Path) -> dict[str, int]:
    with path.open(encoding="utf-8", newline="") as file:
        rows = list(csv.DictReader(file))

    inventory: dict[str, int] = {}
    for row in rows:
        key = row["colorKey"]
        count = int(row.get("ownedCount") or row.get("remaining") or 0)
        inventory[key] = inventory.get(key, 0) + count
    return inventory


def parse_extra(values: list[str]) -> dict[str, int]:
    extras: dict[str, int] = {}
    for value in values:
        if "=" not in value:
            raise ValueError(f"Extra inventory must look like COLOR=COUNT: {value}")
        key, count = value.split("=", 1)
        extras[key.strip()] = extras.get(key.strip(), 0) + int(count)
    return extras


def collect_usage(data: dict[str, Any], selected: list[str]) -> Counter[str]:
    images = {image["id"]: image for image in data.get("images", [])}
    missing_ids = [image_id for image_id in selected if image_id not in images]
    if missing_ids:
        raise ValueError("Images not found: " + ", ".join(missing_ids))

    usage: Counter[str] = Counter()
    for image_id in selected:
        usage.update(images[image_id]["colorCounts"])
    return usage


def print_table(rows: list[tuple[str, int, int, int]], only_used: bool) -> None:
    if only_used:
        rows = [row for row in rows if row[2] != 0 or row[3] < 0]

    print("colorKey,owned,used,remaining")
    for key, owned, used, remaining in rows:
        print(f"{key},{owned},{used},{remaining}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Calculate remaining inventory after selected images."
    )
    parser.add_argument("--analysis", type=Path, default=DEFAULT_ANALYSIS)
    parser.add_argument("--inventory", type=Path, default=DEFAULT_INVENTORY)
    parser.add_argument("--selected", nargs="+", required=True)
    parser.add_argument(
        "--extra",
        nargs="*",
        default=[],
        help="Additional inventory entries like H11=300 T1=300.",
    )
    parser.add_argument(
        "--only-used",
        action="store_true",
        help="Only print colors used by selected images or negative remaining colors.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    inventory = load_inventory(args.inventory)
    for key, count in parse_extra(args.extra).items():
        inventory[key] = inventory.get(key, 0) + count

    usage = collect_usage(load_analysis(args.analysis), args.selected)
    all_keys = sorted(set(inventory) | set(usage))
    rows = [
        (key, inventory.get(key, 0), usage.get(key, 0), inventory.get(key, 0) - usage.get(key, 0))
        for key in all_keys
    ]

    print_table(rows, args.only_used)


if __name__ == "__main__":
    main()
