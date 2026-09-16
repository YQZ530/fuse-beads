"""Combine the grouped-image requirements and the second set, once each."""
from pathlib import Path
from collections import Counter
import json
import re

root = Path(__file__).resolve().parents[1]
second_path = root / 'set2_tot.txt'
grouped_path = root / 'results/processing/2.groupped-bead-count/analyze_color_legend.main.json'
second = Counter()
for line in second_path.read_text(encoding='utf-8-sig').splitlines():
    line = line.strip()
    if not line or re.fullmatch(r'\[[A-Z]+\]', line):
        continue
    tokens = line.split()
    assert len(tokens) % 2 == 0, line
    for code, raw_count in zip(tokens[::2], tokens[1::2]):
        assert re.fullmatch(r'[A-Z]+[1-9][0-9]*', code), code
        assert code not in second, f'Duplicate second-set code: {code}'
        assert raw_count.isdecimal(), raw_count
        second[code] = int(raw_count)

data = json.loads(grouped_path.read_text(encoding='utf-8-sig'))
images = data['images']
assert len(images) == data['imageCount']
assert len({p['id'] for p in images}) == len(images)
grouped = Counter()
notes = []
for part in images:
    counts = part['colorCounts']
    assert all(re.fullmatch(r'[A-Z]+[1-9][0-9]*', c) and type(n) is int and n >= 0 for c,n in counts.items())
    assert sum(counts.values()) == part['totalBeads'], part['id']
    if len(counts) != part['totalColorKeys']:
        notes.append(f"来源备注：{part['id']} 的 totalColorKeys 标为 {part['totalColorKeys']}，实际 colorCounts 有 {len(counts)} 个色号；豆子总数一致，本汇总按实际逐色明细计算。")
    grouped.update(counts)

total = grouped + second
adjustments = Counter()
correction_path = root / 'summary_tot_0913.corrections.json'
corrections = json.loads(correction_path.read_text(encoding='utf-8')) if correction_path.exists() else []
for change in corrections:
    source, target, count = change['from'], change['to'], change['count']
    assert type(count) is int and count > 0
    assert total[source] >= count, change
    total[source] -= count
    adjustments[source] -= count
    if target is not None:
        total[target] += count
        adjustments[target] += count
removed = sum(c['count'] for c in corrections if c['to'] is None)
assert sum(adjustments.values()) == -removed
expected = sum(p['totalBeads'] for p in images) + sum(second.values()) - removed
assert sum(total.values()) == expected
active_colors = sum(n > 0 for n in total.values())
pending_path = root / 'summary_tot_0913.pending.json'
pending = json.loads(pending_path.read_text(encoding='utf-8')) if pending_path.exists() else []
def key(code):
    m = re.fullmatch(r'([A-Z]+)([0-9]+)', code)
    return m[1], int(m[2])

lines = [
    '拼豆需求汇总 — 0913',
    f'合计色号数：{active_colors:,}（仅计数量大于零的色号）',
    f'合计豆子数：{expected:,}',
    '',
    f'分组图片：{len(images)} 组，{len(grouped)} 个色号，{sum(grouped.values()):,} 颗豆',
    f'第二套：{len(second)} 个色号，{sum(second.values()):,} 颗豆',
    '计算方式：每组图片计一次，同色号跨组及跨套相加，再应用用户更正。两个来源列保留原始数量，更正单列显示。',
    f'直接扣减：{removed} 颗；更正后为零的色号保留在明细中供核对，不计入合计色号数。',
    '',
    f'来源一：{grouped_path.relative_to(root).as_posix()}',
    f'来源二：{second_path.name}',
    '',
    '色号       分组图片       第二套         更正         合计',
    '-' * 60,
]
for code in sorted(total, key=key):
    lines.append(f'{code:<6}{grouped[code]:>12}{second[code]:>12}{adjustments[code]:>+12}{total[code]:>12}')
lines += ['-' * 60, f'TOTAL {sum(grouped.values()):>12}{sum(second.values()):>12}{-removed:>+12}{expected:>12}', '',
          '校验：30 组的逐色数量与各组 totalBeads 一致；合计等于两个来源总数之和减去直接扣减数量。']
lines += notes
if corrections:
    lines += ['', '用户更正（已计入合计）：']
    lines += [f"第 {c.get('batch', 1)} 批：{c['from']} -> {c['to'] or '直接扣减'}：{c['count']} 颗" for c in corrections]
    if any(c.get('batch') == 2 for c in corrections):
        lines += ['第 2 批确认：G12c 按 G12，G50 按 G5；H5 -> C18 按用户要求跳过。']
    if any(c.get('batch') == 3 and c['from'] == 'R21' for c in corrections):
        lines += ['第 3 批确认：R21 -> G19，1 颗；开头 H1 按用户要求跳过。']
if pending:
    lines += ['', '待确认（以下项目尚未计入）：'] + pending
output = root / 'summary_tot_0913.audit.txt'
output.write_text('\n'.join(lines) + '\n', encoding='utf-8-sig')
# Verify the written data rows independently of the in-memory total.
read_rows = [line.split() for line in output.read_text(encoding='utf-8-sig').splitlines() if re.match(r'^[A-Z]+[0-9]+\s+\d', line)]
assert len(read_rows) == len(total)
assert sum(int(row[4]) for row in read_rows) == expected
assert all(int(row[1]) + int(row[2]) + int(row[3]) == int(row[4]) for row in read_rows)
assert not pending, 'Resolve pending corrections before generating the final list.'
final_counts = {code: total[code] for code in sorted(total, key=key) if total[code] > 0}
final_lines = ['拼豆需求最终清单 — 0913',
               f'色号总数：{active_colors}', f'豆子总数：{expected:,}', '',
               '色号          最终数量', '-' * 24]
final_lines += [f'{code:<8}{count:>12}' for code, count in final_counts.items()]
final_lines += ['-' * 24, f'TOTAL   {expected:>12}']
output = root / 'summary_tot_0913.txt'
output.write_text('\n'.join(final_lines) + '\n', encoding='utf-8-sig')
written = dict((code, int(count)) for code, count in
               re.findall(r'^([A-Z]+[0-9]+)\s+(\d+)\s*$', output.read_text(encoding='utf-8-sig'), re.MULTILINE))
assert written == final_counts
assert len(written) == active_colors and sum(written.values()) == expected
print(f'{active_colors} colors; {expected} beads; grouped={sum(grouped.values())}; set2={sum(second.values())}; removed={removed}; pending={len(pending)}')
print(output)
