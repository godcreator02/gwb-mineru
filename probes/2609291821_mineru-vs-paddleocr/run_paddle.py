import concurrent.futures, json, os, time, subprocess, tempfile
from pathlib import Path
import requests

ROOT=Path(__file__).parent
URL='https://paddleocr.aistudio-app.com/api/v2/ocr/jobs'
MODEL='PaddleOCR-VL-1.6'
OPTIONS=dict(useDocOrientationClassify=False,useDocUnwarping=False,useChartRecognition=False)
TOKEN=os.environ.get('PADDLEOCR_TOKEN','')
def request(method,url,**kwargs):
    # curl uses the Windows TLS implementation; credentials are passed on stdin.
    for attempt in range(4):
        with tempfile.TemporaryDirectory() as tmp:
            dest=Path(tmp)/'response'
            config=['url = '+json.dumps(url),'output = '+json.dumps(str(dest).replace('\\','/'))]
            for key,value in kwargs.get('headers',{}).items():config.append('header = '+json.dumps(f'{key}: {value}'))
            for key,value in kwargs.get('data',{}).items():config.append('form-string = '+json.dumps(f'{key}={value}'))
            for key,value in kwargs.get('files',{}).items():config.append('form = '+json.dumps(f'{key}=@{str(value.name).replace(chr(92),chr(47))};type=application/pdf'))
            proc=subprocess.run(['curl.exe','--silent','--show-error','--connect-timeout','15','--max-time','180','--write-out','%{http_code}','--config','-'],input='\n'.join(config),capture_output=True,text=True)
            if proc.returncode==0:
                r=requests.Response();r.status_code=int(proc.stdout);r._content=dest.read_bytes();r.encoding='utf-8';return r
            if attempt==3:raise RuntimeError(f'curl transfer failed, exit={proc.returncode}')
            time.sleep(2)
def save(path,data):
    path.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
def download(url,path):
    if path.exists() and path.stat().st_size:return
    path.parent.mkdir(parents=True,exist_ok=True)
    for attempt in range(3):
        try:
            r=request('GET',url,timeout=120);r.raise_for_status();path.write_bytes(r.content);return
        except requests.RequestException:
            if attempt==2: raise
            time.sleep(2)
def run(row):
    out=ROOT/'results'/row['id']/'paddle';out.mkdir(parents=True,exist_ok=True)
    status_path=out/'run.json'
    if status_path.exists():
        state=json.loads(status_path.read_text(encoding='utf-8'))
        if state.get('state')=='done':return state
    else: state=dict(id=row['id'],model=MODEL,options=OPTIONS,started=time.time())
    if state.get('error'):
        state.setdefault('previous_errors',[]).append(state.pop('error'))
    try:
        if not state.get('jobId'):
            with (ROOT/row['input']).open('rb') as f:
                r=request('POST',URL,headers={'Authorization':f'bearer {TOKEN}'},data={'model':MODEL,'optionalPayload':json.dumps(OPTIONS)},files={'file':f},timeout=180)
            state['submit_http_status']=r.status_code
            if r.status_code!=200:raise RuntimeError(f'HTTP {r.status_code}: {r.text[:1200]}')
            data=r.json();save(out/'submit.json',data);state['jobId']=data['data']['jobId'];save(status_path,state)
        deadline=time.time()+3600
        while time.time()<deadline:
            if (out/'result.jsonl').exists():
                job=json.loads((out/'status.json').read_text(encoding='utf-8'))['data'];break
            r=request('GET',f"{URL}/{state['jobId']}",headers={'Authorization':f'bearer {TOKEN}'},timeout=60);r.raise_for_status()
            data=r.json();save(out/'status.json',data);job=data['data']
            if job['state']=='failed':raise RuntimeError(str(job.get('errorMsg',job)))
            if job['state']=='done':break
            time.sleep(5)
        else:raise TimeoutError('one hour job timeout')
        state.setdefault('processing_done',time.time())
        download(job['resultUrl']['jsonUrl'],out/'result.jsonl')
        page=0;parts=[];asset_errors=[];assets=[]
        for line in (out/'result.jsonl').read_text(encoding='utf-8').splitlines():
            if not line.strip():continue
            for res in json.loads(line)['result']['layoutParsingResults']:
                page+=1;md=res['markdown']['text']
                page_root=out/'pages'/f'{page:03d}';page_root.mkdir(parents=True,exist_ok=True)
                (page_root/'raw.md').write_text(md,encoding='utf-8')
                for rel in res['markdown'].get('images',{}):md=md.replace(rel,f'pages/{page:03d}/{rel}')
                (out/f'page-{page:03d}.md').write_text(md,encoding='utf-8');parts.append(f'<!-- page {page} -->\n'+md)
                for rel,url in res['markdown'].get('images',{}).items():
                    target=(page_root/rel).resolve()
                    if not target.is_relative_to(page_root.resolve()):raise ValueError('unsafe image path')
                    assets.append((url,target))
                for name,url in res.get('outputImages',{}).items():
                    assets.append((url,out/'layouts'/f'{page:03d}-{Path(name).name}.jpg'))
        (out/'full.md').write_text('\n\n'.join(parts),encoding='utf-8')
        state.update(state='downloading',pages=page);save(status_path,state)
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
            futures={pool.submit(download,url,path):path for url,path in assets}
            for future in concurrent.futures.as_completed(futures):
                try:future.result()
                except Exception as e:asset_errors.append(dict(path=str(futures[future]),error=str(e)))
        state.update(state='done',pages=page,asset_errors=asset_errors,finished=time.time())
    except Exception as e:state.update(state='failed',error=str(e),finished=time.time())
    save(status_path,state)
    with (out/'attempts.jsonl').open('a',encoding='utf-8') as f:f.write(json.dumps(state,ensure_ascii=False)+'\n')
    print(json.dumps(state,ensure_ascii=False),flush=True);return state
if __name__=='__main__':
    rows=json.loads((ROOT/'manifest.json').read_text(encoding='utf-8'))
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool: list(pool.map(run,rows))
