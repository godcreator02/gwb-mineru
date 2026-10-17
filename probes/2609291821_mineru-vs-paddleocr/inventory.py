import json
from pathlib import Path
import fitz

ROOT = Path(__file__).parent
roots = [Path('D:/unitfolders/y4hhy-paper-library/papers'), Path('D:/unitfolders/0qm6n-old-paper-library/papers'), Path.home()/'AppData/Roaming/gwb-kernel/homes/default/data/paper-fetch/papers']
rows = []
for root in roots:
    for path in root.rglob('*.pdf'):
        try:
            with fitz.open(path) as doc:
                ix = sorted(set([0, min(1,len(doc)-1), len(doc)//2]))
                texts = [doc[i].get_text() for i in ix]
                images = [sum(abs(r.width*r.height) for im in doc[i].get_image_info() for r in [fitz.Rect(im['bbox'])])/doc[i].rect.get_area() for i in ix]
                meta_path = path.parent.parent/'meta.json'
                meta = json.loads(meta_path.read_text(encoding='utf-8-sig')) if meta_path.exists() else {}
                rows.append(dict(path=str(path), pages=len(doc), title=meta.get('title',path.stem), chars=[len(t) for t in texts], image_area=images, chinese=sum('\u4e00'<=c<='\u9fff' for c in ''.join(texts)), excerpt=texts[0][:200]))
        except Exception as e:
            rows.append(dict(path=str(path),error=str(e)))
(ROOT/'inventory.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
print('PDFs',len(rows))
for i,r in enumerate(rows):
    if 'pages' in r: print(i,r['pages'],r['chars'],[round(x,2) for x in r['image_area']],r['chinese'],r['title'])
