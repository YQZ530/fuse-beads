import argparse
import importlib.util
import json
import pathlib
import re
import sys
import time
from collections import Counter, defaultdict
from typing import Any

import cv2
import numpy as np
from PIL import Image


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "analyze_color_legend.py"
MANIFEST = ROOT / "test_scr" / "groups.manifest.json"
OUT_JSON = ROOT / "test_scr" / "output" / "detail_pages_color_match_opencv_count.json"
OUT_COMPARE = ROOT / "test_scr" / "output" / "detail_pages_color_match_opencv_count_compare.json"
OUT_FINAL = ROOT / "test_scr" / "output" / "detail_pages_color_match_opencv_count.final.json"

spec = importlib.util.spec_from_file_location("acl", SCRIPT)
acl = importlib.util.module_from_spec(spec)
sys.modules["acl"] = acl
spec.loader.exec_module(acl)
acl.configure_tesseract(acl.DEFAULT_TESSERACT)


def count_components_in_box(image: np.ndarray, box: tuple[int, int, int, int]) -> list[dict[str, Any]]:
    x0, y0, w, h = box
    legend = image[y0 : y0 + h, x0 : x0 + w]
    gray = cv2.cvtColor(legend, cv2.COLOR_BGR2GRAY)
    row_top = int(h * 0.55)
    row_bottom = int(h * 0.90)
    row = gray[row_top:row_bottom, :]
    mask = cv2.inRange(row, 90, 235)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((1, 1), np.uint8))
    n, _labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    comps = []
    for index in range(1, n):
        x, y, cw, ch, area = stats[index]
        if 4 <= cw <= 26 and 8 <= ch <= 24 and 8 <= area <= 220:
            comps.append({"x": int(x), "y": int(y + row_top), "w": int(cw), "h": int(ch), "area": int(area), "img": mask[y : y + ch, x : x + cw]})
    return comps


def build_digit_templates(tokens: list[Any], comps: list[dict[str, Any]], box: tuple[int, int, int, int]) -> dict[str, list[np.ndarray]]:
    x0, y0, _w, _h = box
    templates: dict[str, list[np.ndarray]] = defaultdict(list)
    for token in tokens:
        local_x = token.x - x0
        local_y = token.y - y0
        inside = [
            comp
            for comp in comps
            if comp["x"] >= local_x - 3
            and comp["x"] + comp["w"] <= local_x + token.width + 3
            and abs(comp["y"] - local_y) <= 8
        ]
        inside = sorted(inside, key=lambda comp: comp["x"])
        if len(inside) == len(token.text):
            for digit, comp in zip(token.text, inside):
                templates[digit].append(cv2.resize(comp["img"], (24, 32), interpolation=cv2.INTER_NEAREST))
    return dict(templates)


def classify_component(comp: dict[str, Any], templates: dict[str, list[np.ndarray]]) -> tuple[str, float]:
    if not templates:
        return "", 0.0
    char = cv2.resize(comp["img"], (24, 32), interpolation=cv2.INTER_NEAREST)
    best = ("", -1.0)
    for digit, samples in templates.items():
        score = max(float(cv2.matchTemplate(char, sample, cv2.TM_CCOEFF_NORMED)[0][0]) for sample in samples)
        if score > best[1]:
            best = (digit, score)
    return best


def opencv_count_for_circle(
    circle: tuple[int, int, int],
    comps: list[dict[str, Any]],
    templates: dict[str, list[np.ndarray]],
    box: tuple[int, int, int, int],
) -> tuple[str, list[float]]:
    x0, y0, _w, _h = box
    cx, cy, radius = circle
    lx = cx - x0
    ly = cy - y0
    candidates = []
    for comp in comps:
        comp_cx = comp["x"] + comp["w"] / 2
        comp_cy = comp["y"] + comp["h"] / 2
        dx = abs(comp_cx - lx)
        dy = comp_cy - ly
        if dx <= max(radius * 1.15, 32) and radius * 0.75 <= dy <= radius * 2.05:
            candidates.append(comp)
    candidates = sorted(candidates, key=lambda comp: comp["x"])
    if not candidates:
        return "", []
    recognized = [classify_component(comp, templates) for comp in candidates]
    if any(not digit or score < 0.35 for digit, score in recognized):
        return "", [round(score, 3) for _digit, score in recognized]
    return "".join(digit for digit, _score in recognized), [round(score, 3) for _digit, score in recognized]


def preprocessing_vote_count_crop(image: np.ndarray, circle: tuple[int, int, int]) -> tuple[str, list[dict[str, str]]]:
    x, y, radius = circle
    crop = acl.crop_box(image, x, y + int(radius * 1.55), int(radius * 1.55), int(radius * 0.55))
    if crop.size == 0:
        return "", []
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    big = cv2.resize(gray, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
    variants = [
        ("gray4x", big),
        ("otsu4x", cv2.threshold(big, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]),
        ("otsu_inv4x", cv2.threshold(big, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]),
    ]
    config = "--psm 7 -c tessedit_char_whitelist=0123456789"
    observations = []
    for name, variant in variants:
        try:
            raw_text = acl.pytesseract.image_to_string(Image.fromarray(variant), config=config, timeout=5)
        except Exception as exc:
            observations.append({"variant": name, "raw": f"ERROR:{exc}", "digits": ""})
            continue
        digits = acl.digits_only(raw_text)
        observations.append({"variant": name, "raw": raw_text.strip(), "digits": digits})
    votes = [item["digits"] for item in observations if 1 <= len(item["digits"]) <= 4]
    if not votes:
        return "", observations
    counts = Counter(votes)
    winner, winner_count = counts.most_common(1)[0]
    if winner_count >= 2:
        return winner, observations
    if len(set(votes)) == 1:
        return votes[0], observations
    return "", observations


def best_token_below_circle(tokens: list[Any], circle: tuple[int, int, int]) -> Any | None:
    return acl.find_count_below_circle(tokens, circle)


def choose_count_text(
    preprocessing_vote_text: str,
    cv_text: str,
    token_text: str,
) -> tuple[str, str, list[str]]:
    candidates = [
        ("preprocessing_vote", preprocessing_vote_text),
        ("opencv_components", cv_text),
        ("tesseract_token", token_text),
    ]
    non_empty = [(source, text) for source, text in candidates if text]
    if not non_empty:
        return "", "missing", []

    counts = Counter(text for _source, text in non_empty)
    text, count = counts.most_common(1)[0]
    sources = [source for source, candidate_text in non_empty if candidate_text == text]
    if count >= 2:
        if len(counts) > 1:
            return text, "majority_vote", sources
        return text, sources[0], sources

    source, text = non_empty[0]
    return text, source, [source]


def count_candidate_sources(item: dict[str, Any], count_text: str) -> list[str]:
    sources = []
    if item.get("preprocessingVoteText") == count_text:
        sources.append("preprocessing_vote")
    if item.get("opencvCountText") == count_text:
        sources.append("opencv_components")
    if item.get("tesseractCountText") == count_text:
        sources.append("tesseract_token")
    return sources


def reconcile_conflict_counts_to_expected(items: list[dict[str, Any]], expected_total: int | None) -> None:
    if expected_total is None:
        return

    conflict_items = [item for item in items if item.get("countConflict")]
    if not conflict_items:
        return

    fixed_sum = sum(int(item["count"]) for item in items if not item.get("countConflict"))
    target = int(expected_total) - fixed_sum
    if target < 0:
        return

    choices: list[list[tuple[int, str, list[str]]]] = []
    for item in conflict_items:
        by_count: dict[int, tuple[str, list[str]]] = {}
        for text in (
            str(item.get("preprocessingVoteText") or ""),
            str(item.get("opencvCountText") or ""),
            str(item.get("tesseractCountText") or ""),
        ):
            if not text.isdigit():
                continue
            value = int(text)
            sources = count_candidate_sources(item, text)
            current = by_count.get(value)
            if current is None or len(sources) > len(current[1]):
                by_count[value] = (text, sources)
        if not by_count:
            return
        choices.append([(value, text, sources) for value, (text, sources) in by_count.items()])

    dp: dict[int, list[tuple[int, str, list[str]]]] = {0: []}
    for item_choices in choices:
        next_dp: dict[int, list[tuple[int, str, list[str]]]] = {}
        for current_sum, selected in dp.items():
            for choice in item_choices:
                value, _text, _sources = choice
                new_sum = current_sum + value
                if new_sum > target:
                    continue
                if new_sum not in next_dp:
                    next_dp[new_sum] = selected + [choice]
        dp = next_dp
        if not dp:
            return

    selected_choices = dp.get(target)
    if selected_choices is None:
        return

    for item, (value, text, sources) in zip(conflict_items, selected_choices):
        if int(item["count"]) == value:
            item["countReconciled"] = False
            continue
        item["countBeforeReconcile"] = int(item["count"])
        item["countTextBeforeReconcile"] = item["countText"]
        item["countSourceBeforeReconcile"] = item["countSource"]
        item["count"] = value
        item["countText"] = text
        item["countSource"] = "expected_total_reconcile"
        item["countVoteSources"] = sources
        item["countReconciled"] = True
        item["countReconcileReason"] = f"expected_total {expected_total} minus fixed_sum {fixed_sum}"


def group_circles_by_y(circles: list[tuple[int, int, int]]) -> list[list[tuple[int, int, int]]]:
    if not circles:
        return []
    radii = [radius for _x, _y, radius in circles]
    tolerance = max(18, int(round(float(np.median(radii)) * 0.90)))
    rows: list[list[tuple[int, int, int]]] = []
    for circle in sorted(circles, key=lambda item: item[1]):
        for row in rows:
            row_y = float(np.median([item[1] for item in row]))
            if abs(circle[1] - row_y) <= tolerance:
                row.append(circle)
                break
        else:
            rows.append([circle])
    return [sorted(row, key=lambda item: item[0]) for row in rows]


def choose_color_circle_row(
    circles: list[tuple[int, int, int]],
    tokens: list[Any],
) -> tuple[list[tuple[int, int, int]], list[dict[str, Any]]]:
    rows = group_circles_by_y(circles)
    diagnostics = []
    for index, row in enumerate(rows):
        token_matches = sum(1 for circle in row if best_token_below_circle(tokens, circle) is not None)
        median_y = float(np.median([circle[1] for circle in row])) if row else 0.0
        diagnostics.append(
            {
                "rowIndex": index,
                "circleCount": len(row),
                "tokenMatchCount": token_matches,
                "medianY": round(median_y, 3),
                "circles": [{"x": x, "y": y, "radius": radius} for x, y, radius in row],
            }
        )
    if not rows:
        return [], diagnostics
    best_index, best_row = max(
        enumerate(rows),
        key=lambda pair: (
            sum(1 for circle in pair[1] if best_token_below_circle(tokens, circle) is not None),
            len(pair[1]),
            float(np.median([circle[1] for circle in pair[1]])),
        ),
    )
    diagnostics[best_index]["selected"] = True
    return best_row, diagnostics


def drop_incomplete_edge_circles(
    circles: list[tuple[int, int, int]],
    box: tuple[int, int, int, int],
    page_index: int,
) -> tuple[list[tuple[int, int, int]], int]:
    x, _y, w, _h = box
    margin = max(4, int(round(w * 0.004)))
    if page_index == 1:
        right_edge = x + w
        kept = [circle for circle in circles if circle[0] + circle[2] < right_edge - margin]
    else:
        left_edge = x
        kept = [circle for circle in circles if circle[0] - circle[2] > left_edge + margin]
    return kept, len(circles) - len(kept)


def analyze_detail_page(
    path: pathlib.Path,
    palette: list[Any],
    page_index: int = 1,
    drop_incomplete_edges: bool = False,
    reconcile_expected_total: bool = False,
) -> dict[str, Any]:
    image = acl.read_image(path)
    if image is None:
        return {"source": str(path), "error": "could_not_read", "items": [], "colorCounts": {}, "totalColorKeys": 0, "totalBeads": 0}
    box = acl.choose_bottom_legend_rect(image)
    if box is None:
        return {"source": str(path), "error": "legend_box_not_found", "items": [], "colorCounts": {}, "totalColorKeys": 0, "totalBeads": 0}

    raw_circles = acl.detect_circles_in_box(image, box)
    number_tokens = acl.read_number_tokens_in_box(image, box)
    _count_tokens, expected_total, transparent_token = acl.select_legend_count_tokens(number_tokens)
    comps = count_components_in_box(image, box)
    templates = build_digit_templates(number_tokens, comps, box)
    palette_keys = {color.key for color in palette}
    color_circles, row_diagnostics = choose_color_circle_row(raw_circles, number_tokens)
    edge_dropped_circle_count = 0
    if drop_incomplete_edges:
        color_circles, edge_dropped_circle_count = drop_incomplete_edge_circles(color_circles, box, page_index)

    items = []
    for circle in color_circles:
        x, y, radius = circle
        if acl.looks_like_mosaic_stat_circle(image, x, y, radius):
            ocr_key, _inside_text = acl.read_circle_key(image, x, y, radius, palette_keys)
            if ocr_key not in palette_keys:
                continue
        sampled_rgb = acl.sample_circle_rgb(image, x, y, radius)
        if sampled_rgb is None:
            continue
        matched, distance = acl.match_palette(sampled_rgb, palette)
        token = best_token_below_circle(number_tokens, circle)
        token_text = token.text if token else ""
        preprocessing_vote_text, preprocessing_vote_observations = preprocessing_vote_count_crop(image, circle)
        cv_text, scores = opencv_count_for_circle(circle, comps, templates, box)
        count_candidates = [preprocessing_vote_text, cv_text, token_text]
        if expected_total is not None and any(candidate and int(candidate) == int(expected_total) for candidate in count_candidates):
            continue
        count_text, count_source, count_vote_sources = choose_count_text(preprocessing_vote_text, cv_text, token_text)
        if not count_text:
            continue
        items.append(
            {
                "colorKey": matched.key,
                "count": int(count_text),
                "countText": count_text,
                "countSource": count_source,
                "tesseractCountText": token_text,
                "preprocessingVoteText": preprocessing_vote_text,
                "preprocessingVoteObservations": preprocessing_vote_observations,
                "opencvCountText": cv_text,
                "countCandidates": [
                    {"source": "preprocessing_vote", "text": preprocessing_vote_text},
                    {"source": "opencv_components", "text": cv_text},
                    {"source": "tesseract_token", "text": token_text},
                ],
                "countVoteSources": count_vote_sources,
                "countConflict": len({value for value in [preprocessing_vote_text, cv_text, token_text] if value}) > 1,
                "opencvScores": scores,
                "sampledRgb": list(sampled_rgb),
                "distance": round(float(distance), 3),
                "bbox": {"x": x - radius, "y": y - radius, "width": radius * 2, "height": radius * 2},
            }
        )

    if reconcile_expected_total:
        reconcile_conflict_counts_to_expected(items, expected_total)

    color_counts: dict[str, int] = defaultdict(int)
    for item in items:
        color_counts[item["colorKey"]] += int(item["count"])
    color_counts = dict(sorted(color_counts.items(), key=lambda kv: acl.color_key_sort(kv[0])))
    return {
        "source": str(path),
        "legendBox": {"x": box[0], "y": box[1], "width": box[2], "height": box[3]},
        "rawCircleCount": len(raw_circles),
        "colorCircleCount": len(color_circles),
        "edgeDroppedCircleCount": edge_dropped_circle_count,
        "circleRowDiagnostics": row_diagnostics,
        "countTokenCount": len(number_tokens),
        "expectedTotalBeads": expected_total,
        "transparentCount": int(transparent_token.text) if transparent_token else None,
        "templateDigits": {digit: len(samples) for digit, samples in sorted(templates.items())},
        "items": items,
        "colorCounts": color_counts,
        "totalColorKeys": len(color_counts),
        "totalBeads": int(sum(color_counts.values())),
    }


def pair_key_from_group(group: dict[str, Any]) -> str | None:
    keys = []
    for item in group.get("items", []):
        pair_key = item.get("pairKey")
        if isinstance(pair_key, str) and re.match(r"^\d+_\d+$", pair_key):
            keys.append(pair_key)
    if not keys:
        return None
    return Counter(keys).most_common(1)[0][0]


def total_from_pair_key(pair_key: str | None) -> int | None:
    if not pair_key:
        return None
    match = re.match(r"^\d+_(\d+)$", pair_key)
    return int(match.group(1)) if match else None


def item_count_candidates(item: dict[str, Any]) -> list[int]:
    values = []
    for candidate in item.get("countCandidates", []):
        text = str(candidate.get("text") or "")
        if text.isdigit():
            values.append(int(text))
    count = item.get("count")
    if count is not None:
        values.append(int(count))
    return sorted(set(values))


def candidate_source_votes(items: list[dict[str, Any]]) -> Counter[int]:
    votes: Counter[int] = Counter()
    for item in items:
        for candidate in item.get("countCandidates", []):
            text = str(candidate.get("text") or "")
            if text.isdigit():
                votes[int(text)] += 1
    return votes


def choose_fallback_count(items: list[dict[str, Any]]) -> int:
    votes = candidate_source_votes(items)
    if votes:
        best_count, _best_votes = votes.most_common(1)[0]
        return int(best_count)
    return max(int(item.get("count") or 0) for item in items)


def reconcile_group_counts(
    by_key: dict[str, list[dict[str, Any]]],
    expected_pair_key: str | None,
) -> tuple[dict[str, int], dict[str, dict[str, Any]], dict[str, Any]]:
    expected_total = total_from_pair_key(expected_pair_key)
    chosen: dict[str, int] = {}
    uncertain: dict[str, list[int]] = {}
    diagnostics: dict[str, Any] = {"expectedTotal": expected_total, "uncertainColorKeys": []}

    for key, items in by_key.items():
        observed_counts = {int(item.get("count") or 0) for item in items}
        has_conflict = any(bool(item.get("countConflict")) for item in items)
        choices = sorted({value for item in items for value in item_count_candidates(item)})
        if has_conflict or len(observed_counts) > 1:
            uncertain[key] = choices or [choose_fallback_count(items)]
        else:
            chosen[key] = next(iter(observed_counts))

    diagnostics["uncertainColorKeys"] = sorted(uncertain, key=acl.color_key_sort)
    if not uncertain or expected_total is None:
        for key, items in by_key.items():
            chosen.setdefault(key, choose_fallback_count(items))
        return chosen, {}, diagnostics

    fixed_sum = sum(chosen.values())
    target = expected_total - fixed_sum
    diagnostics["fixedSum"] = fixed_sum
    diagnostics["targetUncertainSum"] = target
    if target < 0:
        for key, items in by_key.items():
            chosen.setdefault(key, choose_fallback_count(items))
        diagnostics["reconcileStatus"] = "skipped_negative_target"
        return chosen, {}, diagnostics

    ordered_keys = sorted(uncertain, key=acl.color_key_sort)
    dp: dict[int, list[tuple[str, int]]] = {0: []}
    for key in ordered_keys:
        next_dp: dict[int, list[tuple[str, int]]] = {}
        for current_sum, selected in dp.items():
            for value in uncertain[key]:
                new_sum = current_sum + value
                if new_sum > target:
                    continue
                if new_sum not in next_dp:
                    next_dp[new_sum] = selected + [(key, value)]
        dp = next_dp
        if not dp:
            break

    selected = dp.get(target) if dp else None
    overrides: dict[str, dict[str, Any]] = {}
    if selected is None:
        diagnostics["reconcileStatus"] = "no_exact_combo"
        for key, items in by_key.items():
            chosen.setdefault(key, choose_fallback_count(items))
        return chosen, overrides, diagnostics

    diagnostics["reconcileStatus"] = "exact_combo"
    for key, value in selected:
        fallback = choose_fallback_count(by_key[key])
        chosen[key] = value
        overrides[key] = {
            "countBeforeGroupReconcile": fallback,
            "countReconciled": value != fallback,
            "countReconcileReason": f"group expected total {expected_total} minus fixed sum {fixed_sum}",
        }

    return chosen, overrides, diagnostics


def merge_pages(group_name: str, pages: list[dict[str, Any]], expected_pair_key: str | None) -> dict[str, Any]:
    by_key: dict[str, list[dict[str, Any]]] = defaultdict(list)
    sources: dict[str, list[str]] = defaultdict(list)
    for page in pages:
        for item in page.get("items", []):
            key = item["colorKey"]
            by_key[key].append(item)
            source = page.get("source", "")
            if source and source not in sources[key]:
                sources[key].append(source)

    chosen_counts, overrides, reconcile_diagnostics = reconcile_group_counts(by_key, expected_pair_key)
    rows = []
    for key, items in by_key.items():
        best_item = min(items, key=lambda item: float(item.get("distance") or 999999))
        row = dict(best_item)
        row["count"] = int(chosen_counts[key])
        row["countText"] = str(chosen_counts[key])
        row["sources"] = sources[key]
        row["duplicateDetections"] = [
            {
                "count": int(item.get("count") or 0),
                "countText": item.get("countText"),
                "countSource": item.get("countSource"),
                "countConflict": item.get("countConflict"),
                "preprocessingVoteText": item.get("preprocessingVoteText"),
                "opencvCountText": item.get("opencvCountText"),
                "tesseractCountText": item.get("tesseractCountText"),
            }
            for item in items
        ]
        if key in overrides:
            row.update(overrides[key])
            row["countSource"] = "group_expected_total_reconcile"
        elif len({int(item.get("count") or 0) for item in items}) > 1:
            row["countSource"] = "cross_page_vote"
        rows.append(row)

    rows.sort(key=lambda row: (-int(row["count"]), acl.color_key_sort(row["colorKey"])))
    color_counts = {row["colorKey"]: int(row["count"]) for row in rows}
    total = int(sum(color_counts.values()))
    return {
        "id": group_name,
        "analysisMethod": "detail_pages_only_color_match_key_opencv_count",
        "expectedPairKey": expected_pair_key,
        "pageCount": len(pages),
        "sourceImages": [page.get("source") for page in pages],
        "totalColorKeys": len(color_counts),
        "totalBeads": total,
        "gotPairKey": f"{len(color_counts)}_{total}",
        "matchesPairKey": expected_pair_key == f"{len(color_counts)}_{total}" if expected_pair_key else None,
        "colorCounts": color_counts,
        "colors": rows,
        "pages": pages,
        "groupReconcile": reconcile_diagnostics,
    }


def build_final_payload(debug_payload: dict[str, Any]) -> dict[str, Any]:
    images = []
    conflict_images = []
    for row in debug_payload.get("images", []):
        color_counts = dict(row.get("colorCounts", {}) or {})
        transparent_count = row.get("transparentCount")
        if transparent_count is not None:
            color_counts["transparent"] = int(transparent_count)
        expected = row.get("expectedPairKey")
        current = row.get("gotPairKey")
        image = {
            "id": row.get("id"),
            "totalColorKeys": row.get("totalColorKeys"),
            "totalBeads": row.get("totalBeads"),
            "expected": expected,
            "colorCounts": color_counts,
        }
        images.append(image)
        if expected and current and expected != current:
            conflict_images.append(
                {
                    "id": row.get("id"),
                    "current": current,
                    "expected": expected,
                }
            )
    return {
        "images": images,
        "conflictImages": conflict_images,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="", help="Comma-separated Image ids to run, e.g. Image2,Image3.")
    parser.add_argument("--exclude", default="", help="Comma-separated Image ids to skip.")
    args = parser.parse_args()
    only_ids = {item.strip() for item in args.only.split(",") if item.strip()}
    exclude_ids = {item.strip() for item in args.exclude.split(",") if item.strip()}

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    palette = acl.load_mard_palette(acl.DEFAULT_MAPPING_PATH, acl.DEFAULT_PALETTE_SETS_PATH, "291")
    results = []
    skipped = []
    for group in manifest.get("groups", []):
        group_name = group.get("groupName") or group.get("folderName") or group.get("id") or "unknown"
        if only_ids and group_name not in only_ids:
            continue
        if group_name in exclude_ids:
            continue
        detail_items = [item for item in group.get("items", []) if item.get("pageType") == "detail_page"]
        if not detail_items:
            skipped.append({"id": group_name, "reason": "no_detail_page"})
            continue
        group_start = time.perf_counter()
        print(f"{group_name}: detail pages {len(detail_items)}", flush=True)
        pages = []
        for page_index, item in enumerate(detail_items, start=1):
            page_start = time.perf_counter()
            page = analyze_detail_page(
                pathlib.Path(str(item.get("source"))),
                palette,
                page_index=page_index,
                drop_incomplete_edges=len(detail_items) > 1,
                reconcile_expected_total=False,
            )
            page["elapsedSeconds"] = round(time.perf_counter() - page_start, 3)
            pages.append(page)
        merged = merge_pages(group_name, pages, pair_key_from_group(group))
        merged["elapsedSeconds"] = round(time.perf_counter() - group_start, 3)
        results.append(merged)

    payload = {
        "input": str(MANIFEST),
        "algorithm": "detail_pages_only_color_match_key_opencv_count",
        "notes": [
            "Only manifest items with pageType == detail_page are analyzed.",
            "color_modal and summary_view items are skipped.",
            "colorKey comes from palette color matching, with mosaic/stat-circle filtering only.",
            "count comes from OpenCV connected components when available.",
        ],
        "imageCount": len(results),
        "skippedGroupCount": len(skipped),
        "skippedGroups": skipped,
        "images": results,
    }
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    final_payload = build_final_payload(payload)
    OUT_FINAL.write_text(json.dumps(final_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    comparison = {
        "summary": {
            "matchedPairKey": sum(1 for row in results if row.get("matchesPairKey") is True),
            "mismatchedPairKey": sum(1 for row in results if row.get("matchesPairKey") is False),
            "unknownPairKey": sum(1 for row in results if row.get("matchesPairKey") is None),
        },
        "groups": [
            {
                "id": row["id"],
                "expectedPairKey": row.get("expectedPairKey"),
                "gotPairKey": row.get("gotPairKey"),
                "matchesPairKey": row.get("matchesPairKey"),
                "pageCount": row.get("pageCount"),
                "elapsedSeconds": row.get("elapsedSeconds"),
            }
            for row in results
        ],
    }
    OUT_COMPARE.write_text(json.dumps(comparison, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(OUT_JSON)
    print(OUT_FINAL)
    print(OUT_COMPARE)
    print(json.dumps(comparison["summary"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
