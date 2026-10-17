import difflib,json,re
from pathlib import Path
root=Path(__file__).parent
def norm(s):return re.sub(r'\s+','',s).lower()
for base in sorted((root/'results').iterdir()):
    f=base/'paddle'/'result.jsonl'
    if not f.exists():continue
    pp=[r for l in f.read_text(encoding='utf-8').splitlines() for r in json.loads(l)['result']['layoutParsingResults']]
    mm=json.loads((base/'mineru'/'content_list.json').read_text(encoding='utf-8'))
    diffs=[]
    for m in mm:
        if m['type'] not in ['text','ref_text'] or len(m.get('text',''))<60:continue
        p=pp[m['page_idx']]['prunedResult'];x0,y0,x1,y1=m['bbox'];mx=(x0+x1)/2000;my=(y0+y1)/2000
        candidates=[]
        for b in p['parsing_res_list']:
            if b['block_label'] not in ['text','abstract','reference_content']:continue
            u,v,w,z=b['block_bbox'];dist=abs((u+w)/2/p['width']-mx)+abs((v+z)/2/p['height']-my)
            if dist<.08:candidates.append((dist,b))
        if not candidates:continue
        b=min(candidates,key=lambda x:x[0])[1];a1=norm(m['text']);b1=norm(b['block_content']);ratio=difflib.SequenceMatcher(None,a1,b1).ratio()
        if .6<ratio<.985:
            sm=difflib.SequenceMatcher(None,a1,b1)
            changes=[(a1[max(0,i-15):j+15],b1[max(0,k-15):l+15]) for tag,i,j,k,l in sm.get_opcodes() if tag!='equal']
            diffs.append(dict(page=m['page_idx']+1,ratio=round(ratio,3),changes=changes[:5]))
    print(base.name,json.dumps(sorted(diffs,key=lambda x:x['ratio'])[:5],ensure_ascii=False))
