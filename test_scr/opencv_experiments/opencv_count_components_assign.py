import importlib.util, pathlib, sys, cv2, numpy as np
ROOT=pathlib.Path(r'C:\Users\z5308\Desktop\perler-beads-batch_analy2')
SCRIPT=ROOT/'scripts'/'analyze_color_legend.py'
SRC=pathlib.Path(r'C:\Users\z5308\Desktop\batch_pic\Image1\Image1_3.PNG')
spec=importlib.util.spec_from_file_location('acl',SCRIPT); m=importlib.util.module_from_spec(spec); sys.modules['acl']=m; spec.loader.exec_module(m)
img=m.read_image(SRC); box=m.choose_bottom_legend_rect(img); x0,y0,w,h=box; legend=img[y0:y0+h,x0:x0+w]; gray=cv2.cvtColor(legend,cv2.COLOR_BGR2GRAY)
row_top=int(h*0.55); row=gray[row_top:int(h*0.90),:]
mask=cv2.inRange(row,90,235)
n,labels,stats,cent=cv2.connectedComponentsWithStats(mask,8)
comps=[]
for i in range(1,n):
    x,y,wc,hc,area=stats[i]; cy=y+row_top
    if 4<=wc<=26 and 8<=hc<=24 and 8<=area<=220:
        comps.append({'x':int(x),'y':int(cy),'w':int(wc),'h':int(hc),'area':int(area),'img':mask[y:y+hc,x:x+wc]})
# Build templates from trusted OCR tokens by assigning components inside token bbox.
tokens=m.read_number_tokens_in_box(img,box)
templates={}
for t in tokens:
    local_x=t.x-x0; local_y=t.y-y0
    inside=[c for c in comps if c['x']>=local_x-3 and c['x']+c['w']<=local_x+t.width+3 and abs(c['y']-local_y)<=6]
    inside=sorted(inside,key=lambda c:c['x'])
    if len(inside)==len(t.text):
        for ch,c in zip(t.text,inside):
            templ=cv2.resize(c['img'],(24,32),interpolation=cv2.INTER_NEAREST)
            templates.setdefault(ch,[]).append(templ)
print('template digits', {k:len(v) for k,v in sorted(templates.items())})
def classify(c):
    char=cv2.resize(c['img'],(24,32),interpolation=cv2.INTER_NEAREST)
    best=(-9,'?')
    for d,tmpls in templates.items():
        score=max(float(cv2.matchTemplate(char,t,cv2.TM_CCOEFF_NORMED)[0][0]) for t in tmpls)
        if score>best[0]: best=(score,d)
    return best
circles=sorted(m.detect_circles_in_box(img,box), key=lambda c:c[0])
for idx,(cx,cy,r) in enumerate(circles,1):
    if not (cy > y0+60): continue
    lx=cx-x0; ly=cy-y0
    # Components under this circle, similar geometry as count.
    candidates=[]
    for c in comps:
        ccx=c['x']+c['w']/2; ccy=c['y']+c['h']/2
        dx=abs(ccx-lx); dy=ccy-ly
        if dx <= max(r*1.15,32) and r*0.75 <= dy <= r*2.05:
            candidates.append(c)
    candidates=sorted(candidates,key=lambda c:c['x'])
    text=''.join(classify(c)[1] for c in candidates)
    scores=[round(classify(c)[0],2) for c in candidates]
    if candidates:
        print(idx, 'circle', (cx,cy,r), 'cv_text', text, 'scores', scores, 'xs', [c['x'] for c in candidates])
