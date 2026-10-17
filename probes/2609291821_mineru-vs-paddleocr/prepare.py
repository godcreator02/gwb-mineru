import hashlib, json, shutil
from pathlib import Path
import fitz
from PIL import Image, ImageDraw
root=Path(__file__).parent
inv=json.loads((root/'inventory.json').read_text(encoding='utf-8'))
choices=[(14,'英文双栏，公式密集'),(1,'英文双栏，推导与表格'),(59,'英文双栏，AI应用与图表'),(74,'英文单栏，框图与长表'),(68,'英文双栏，历史扫描版与公式'),(216,'英文双栏，历史扫描版与拓扑图'),(15,'中文双栏，公式密集'),(19,'中文双栏，短篇控制论文'),(193,'中文双栏，工程方案与图表'),(24,'中文单栏学位论文，整页栅格图与文字层')]
rows=[]
sheet=Image.new('RGB',(1500,440*5),'#e5e5e5'); draw=ImageDraw.Draw(sheet)
for k,(idx,category) in enumerate(choices,1):
    r=inv[idx].copy(); sid=f'{k:02d}'; dest=root/'samples'/sid
    dest.mkdir(parents=True,exist_ok=True)
    shutil.copy2(r['path'],dest/'source.pdf')
    r.update(id=sid,category=category,sha256=hashlib.sha256((dest/'source.pdf').read_bytes()).hexdigest(),input=f'samples/{sid}/source.pdf')
    with fitz.open(dest/'source.pdf') as doc:
        pages=[0, min(2,len(doc)-1)] if idx!=24 else [10,32]
        r['review_pages']=[p+1 for p in pages]
        for j,p in enumerate(pages):
            pix=doc[p].get_pixmap(matrix=fitz.Matrix(1,1))
            pix.save(dest/f'page-{p+1:03d}.png')
            im=Image.frombytes('RGB',[pix.width,pix.height],pix.samples); im.thumbnail((365,405))
            x=((k-1)%2)*750+j*370;y=((k-1)//2)*440
            sheet.paste(im,(x,y+25));draw.text((x+5,y+5),f'{sid} / page {p+1}',fill='black')
    rows.append(r)
(root/'manifest.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
sheet.save(root/'sample-contact.png')
print('Selected',len(rows),'papers;',sum(r['pages'] for r in rows),'pages')
