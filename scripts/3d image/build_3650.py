from pathlib import Path
s=Path('scripts/render_3648.py').read_text(encoding='utf-8')
s=s.replace("Path('results/3648')","Path('results/3650')").replace('else 78','else 96').replace('==37','==8').replace('==2428','==2542')
s=s.replace('星月夜','千里江山').replace('37 个零件','8 个零件').replace('2,428','2,542').replace('i*240','i*270').replace('starry-night','thousand-miles-mountains')
s=s.replace("'parts':37","'parts':8").replace("'beads':2428","'beads':2542").replace('37 parts, 2428 cells','8 parts, 2542 cells')
Path('scripts/render_3650.py').write_text(s,encoding='utf-8')
