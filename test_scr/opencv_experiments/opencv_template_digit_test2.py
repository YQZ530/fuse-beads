import importlib.util, pathlib, sys, cv2, numpy as np
ROOT=pathlib.Path(r'C:\Users\z5308\Desktop\perler-beads-batch_analy2')
SCRIPT=ROOT/'scripts'/'analyze_color_legend.py'
SRC=pathlib.Path(r'C:\Users\z5308\Desktop\batch_pic\Image1\Image1_3.PNG')
OUT=ROOT/'test_scr'/'output'/'template_debug2'
spec=importlib.util.spec_from_file_location('acl',SCRIPT); m=importlib.util.module_from_spec(spec); sys.modules['acl']=m; spec.loader.exec_module(m)
def write(path,img): path.parent.mkdir(parents=True,exist_ok=True); cv2.imencode('.png',img)[1].tofile(str(path))
img=m.read_image(SRC); box=m.choose_bottom_legend_rect(img); x,y,w,h=box; legend=img[y:y+h,x:x+w]; gray=cv2.cvtColor(legend,cv2.COLOR_BGR2GRAY)
# Count row only: below circles. Avoid top title/buttons and circle labels.
row=gray[int(h*0.55):int(h*0.90),:]
# Use top-hat/threshold for medium-dark gray text; exclude black home indicator by y band.
mask=cv2.inRange(row, 90, 235)
mask=cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((1,1),np.uint8))
write(OUT/'legend.png',legend); write(OUT/'count_row_mask.png',mask)
n,labels,stats,cent=cv2.connectedComponentsWithStats(mask,8)
comps=[]
for i in range(1,n):
    cx,cy,cw,ch,area=stats[i]
    # count digits are about 9-20 px tall in original legend crop
    if 4 <= cw <= 26 and 8 <= ch <= 24 and 8 <= area <= 220:
        comps.append((cx,cy+int(h*0.55),cw,ch,area))
print('box',box,'components',len(comps))
for c in comps:
    print(c)
# Print components in x range around D1 count at global x ~858, legend-local same x.
print('D1 nearby')
for c in comps:
    if 820 <= c[0] <= 900:
        print(c)
# Save D1 neighborhood mask larger
write(OUT/'D1_neighborhood.png', legend[135:205,810:920])
write(OUT/'D1_neighborhood_mask.png', mask[135-int(h*0.55):205-int(h*0.55),810:920])
print(OUT)
