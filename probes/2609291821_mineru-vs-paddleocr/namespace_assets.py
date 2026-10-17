import collections,concurrent.futures,json,shutil
from pathlib import Path
from run_paddle import download
root=Path(__file__).parent
tasks=[];conflicts=[]
for base in sorted((root/'results').iterdir()):
    out=base/'paddle'
    pp=[r for line in (out/'result.jsonl').read_text(encoding='utf-8').splitlines() for r in json.loads(line)['result']['layoutParsingResults']]
    rels=collections.Counter(rel for p in pp for rel in p['markdown']['images'])
    parts=[]
    for i,p in enumerate(pp,1):
        page=out/'pages'/f'{i:03d}';page.mkdir(parents=True,exist_ok=True)
        md=p['markdown']['text'];(page/'raw.md').write_text(md,encoding='utf-8')
        for rel,url in p['markdown']['images'].items():
            target=(page/rel).resolve()
            assert target.is_relative_to(page.resolve())
            target.parent.mkdir(parents=True,exist_ok=True)
            if rels[rel]==1:shutil.copy2(out/rel,target)
            else:
                conflicts.append(dict(id=base.name,page=i,path=rel))
                tasks.append((url,target))
            md=md.replace(rel,f'pages/{i:03d}/{rel}')
        (out/f'page-{i:03d}.md').write_text(md,encoding='utf-8')
        parts.append(f'<!-- page {i} -->\n'+md)
    (out/'full.md').write_text('\n\n'.join(parts),encoding='utf-8')
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    futures=[pool.submit(download,*t) for t in tasks]
    for f in futures:f.result()
(root/'image-path-collisions.json').write_text(json.dumps(conflicts,ensure_ascii=False,indent=2),encoding='utf-8')
print('Namespaced all image paths; duplicate-path page occurrences:',len(conflicts))
