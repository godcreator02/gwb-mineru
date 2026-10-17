import datetime, hashlib, json, re
from pathlib import Path
root=Path(__file__).parent
manifest=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
jobs=json.loads((root/'mineru-status.json').read_text(encoding='utf-8'))
metrics=json.loads((root/'metrics.json').read_text(encoding='utf-8'))
summary=[]
for row in manifest:
    sid=row['id'];base=root/'results'/sid
    assert hashlib.sha256((root/row['input']).read_bytes()).hexdigest()==row['sha256']
    state=json.loads((base/'paddle/run.json').read_text(encoding='utf-8'))
    if state.get('error') and state['state']=='done':
        state.setdefault('previous_errors',[]).append(state.pop('error'))
        (base/'paddle/run.json').write_text(json.dumps(state,ensure_ascii=False,indent=2),encoding='utf-8')
    assert state['state']=='done' and not state['asset_errors']
    pp=[r for line in (base/'paddle/result.jsonl').read_text(encoding='utf-8').splitlines() for r in json.loads(line)['result']['layoutParsingResults']]
    assert len(pp)==row['pages']
    for page_num,p in enumerate(pp,1):
        for rel in p['markdown']['images']:
            path=(base/'paddle'/'pages'/f'{page_num:03d}'/rel).resolve()
            assert path.is_relative_to((base/'paddle').resolve()) and path.stat().st_size>0
    mt=(base/'mineru/full.md').read_text(encoding='utf-8');pt=(base/'paddle/full.md').read_text(encoding='utf-8')
    for rel in re.findall(r'!\[[^\]]*\]\(([^)]+)\)',mt):assert (base/'mineru'/rel).is_file(),rel
    mjob=[j for j in jobs if f'/{sid}/' in j['input'] and j['state']=='done'][-1]
    pjob=json.loads((base/'paddle/status.json').read_text(encoding='utf-8'))['data']['extractProgress']
    met=next(m for m in metrics if m['id']==sid)
    s=dict(id=sid,pages=row['pages'],mineru_equations=met['mineru_types'].get('equation',0),paddle_equations=met['paddle_types'].get('display_formula',0),mineru_tables=met['mineru_types'].get('table',0),paddle_tables=met['paddle_types'].get('table',0),mineru_tags=len(re.findall(r'\\tag\s*\{',mt)),paddle_tags=len(re.findall(r'\\tag\s*\{',pt)),paddle_number_blocks=met['paddle_types'].get('formula_number',0),mineru_control_chars=sum(ord(c)<32 and c not in '\n\r\t' for c in mt),mineru_success_attempt_seconds=round((datetime.datetime.fromisoformat(mjob['updatedAt'])-datetime.datetime.fromisoformat(mjob['createdAt'])).total_seconds(),2),paddle_server_seconds=(datetime.datetime.fromisoformat(pjob['endTime'])-datetime.datetime.fromisoformat(pjob['startTime'])).total_seconds())
    summary.append(s)
(root/'validation.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(summary,ensure_ascii=False,indent=2))
print('PASS: 10 identical inputs, 194 pages each, 10 terminal successes each, all Markdown images present')
