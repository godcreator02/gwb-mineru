import collections, datetime, html, json, re, zipfile
from pathlib import Path
ROOT=Path(__file__).parent
rows=json.loads((ROOT/'manifest.json').read_text(encoding='utf-8'))
stats=[]
for row in rows:
    sid=row['id'];base=ROOT/'results'/sid
    archives=list((base/'.mineru.pdf2md').glob('*.zip'))
    if not archives:continue
    with zipfile.ZipFile(archives[-1]) as z:
        name=next(n for n in z.namelist() if n.endswith('_content_list.json'))
        blocks=json.loads(z.read(name))
    (base/'mineru'/'content_list.json').write_text(json.dumps(blocks,ensure_ascii=False,indent=2),encoding='utf-8')
    pages=collections.defaultdict(list)
    for b in blocks:pages[b['page_idx']+1].append(b)
    for p,bs in pages.items():
        (base/'mineru'/f'page-{p:03d}.txt').write_text('\n\n'.join(b.get('text',b.get('table_body','')) or json.dumps(b,ensure_ascii=False) for b in bs),encoding='utf-8')
    pfile=base/'paddle'/'result.jsonl'; pp=[]
    if pfile.exists():
        for line in pfile.read_text(encoding='utf-8').splitlines():
            for r in json.loads(line)['result']['layoutParsingResults']:pp.append(r)
    mtext=(base/'mineru'/'full.md').read_text(encoding='utf-8')
    ptext=(base/'paddle'/'full.md').read_text(encoding='utf-8') if (base/'paddle'/'full.md').exists() else '\n\n'.join(p['markdown']['text'] for p in pp)
    if pp:(base/'paddle'/'full-preview.md').write_text(ptext,encoding='utf-8')
    stat=dict(id=sid,pages=row['pages'],mineru_pages=len(pages),paddle_pages=len(pp),mineru_types=dict(collections.Counter(b['type'] for b in blocks)),paddle_types=dict(collections.Counter(b['block_label'] for p in pp for b in p['prunedResult']['parsing_res_list'])),mineru_chars=len(mtext),paddle_chars=len(ptext))
    stats.append(stat)
    print(json.dumps(stat,ensure_ascii=False))
(ROOT/'metrics.json').write_text(json.dumps(stats,ensure_ascii=False,indent=2),encoding='utf-8')
