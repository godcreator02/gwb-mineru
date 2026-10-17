import collections, html, json, re, tarfile
from html.parser import HTMLParser
from pathlib import Path
import fitz, markdown
ROOT=Path(__file__).parent
with tarfile.open(ROOT/'vendor/katex.tgz') as archive:
    for member in archive.getmembers():
        if member.isfile() and (member.name.startswith('package/dist/') or member.name=='package/LICENSE'):
            target=ROOT/'vendor/katex'/member.name.removeprefix('package/')
            if not target.resolve().is_relative_to((ROOT/'vendor/katex').resolve()):raise ValueError(member.name)
            target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(archive.extractfile(member).read())

class Clean(HTMLParser):
    allowed=set('p div span h1 h2 h3 h4 h5 h6 table thead tbody tr td th img a strong em b i sub sup pre code ul ol li br hr blockquote'.split())
    def __init__(self):super().__init__(convert_charrefs=False);self.parts=[]
    def handle_starttag(self,tag,attrs):
        if tag not in self.allowed:return
        safe=[]
        for key,val in attrs:
            if key not in ['src','href','alt','colspan','rowspan','class','data-tex','data-display']:continue
            if key in ['src','href'] and re.match(r'(?i)(https?:|javascript:|data:|//)',val):continue
            safe.append(f'{key}="{html.escape(val,quote=True)}"')
        self.parts.append('<'+tag+' '+ ' '.join(safe)+'>')
    def handle_endtag(self,tag):
        if tag in self.allowed:self.parts.append(f'</{tag}>')
    def handle_data(self,data):self.parts.append(html.escape(data))
    def handle_entityref(self,name):self.parts.append('&'+name+';')
    def handle_charref(self,name):self.parts.append('&#'+name+';')

def preview(text,sid,engine):
    formulas=[]
    def math(m):
        raw=m.group();display=raw.startswith('$$');tex=raw[2:-2] if display else raw[1:-1]
        key=f'MATHPLACEHOLDER{len(formulas)}END';formulas.append((key,tex,display));return key
    text=re.sub(r'\$\$[\s\S]*?\$\$|(?<!\\)\$[^$\n]+?(?<!\\)\$',math,text)
    rendered=markdown.markdown(text,extensions=['tables','fenced_code'])
    for key,tex,display in formulas:
        tag='div' if display else 'span'
        rendered=rendered.replace(key,f'<{tag} class="math" data-display="{str(display).lower()}" data-tex="{html.escape(tex,quote=True)}">{html.escape(tex)}</{tag}>')
    rendered=re.sub(r'(src=")[^":]+(?=")',lambda m:m.group().replace('src="','src="results/'+sid+'/'+engine+'/'),rendered)
    cleaner=Clean();cleaner.feed(rendered);return ''.join(cleaner.parts)

def mblock(b):
    t=b['type']
    if t in ['header','footer','page_number','page_footnote','aside_text']:return ''
    if t=='table':return '\n'.join(b.get('table_caption',[]))+'\n\n'+b.get('table_body','')
    if t in ['image','chart']:
        return f"![]({b['img_path']})\n\n"+'\n'.join(b.get(t+'_caption',b.get('image_caption',[])))
    if t=='code':return '\n'.join(b.get('code_caption',[]))+'\n\n'+b.get('code_body','')
    text=b.get('text','')
    if b.get('text_level'):text='#'*min(6,b['text_level'])+' '+text
    return text

rows=json.loads((ROOT/'manifest.json').read_text(encoding='utf-8'));payload=[]
for row in rows:
    sid=row['id'];base=ROOT/'results'/sid;groups=collections.defaultdict(list)
    for b in json.loads((base/'mineru/content_list.json').read_text(encoding='utf-8')):groups[b['page_idx']+1].append(b)
    pp=[r for line in (base/'paddle/result.jsonl').read_text(encoding='utf-8').splitlines() for r in json.loads(line)['result']['layoutParsingResults']]
    pages=[]
    with fitz.open(ROOT/row['input']) as doc:
        for n in range(1,row['pages']+1):
            img=ROOT/'samples'/sid/f'page-{n:03d}.png'
            if not img.exists():doc[n-1].get_pixmap(matrix=fitz.Matrix(1.25,1.25)).save(img)
            m='\n\n'.join(filter(None,(mblock(b) for b in groups[n])))
            p=(base/'paddle'/f'page-{n:03d}.md').read_text(encoding='utf-8')
            pages.append(dict(mraw=m,praw=p,m=preview(m,sid,'mineru'),p=preview(p,sid,'paddle')))
    payload.append(dict(id=sid,title=row['title'].replace('_',' '),category=row['category'],pages=pages))
template='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>论文 OCR 对比</title>
<link rel="stylesheet" href="vendor/katex/dist/katex.min.css"><script src="vendor/katex/dist/katex.min.js"></script>
<style>*{box-sizing:border-box}body{margin:0;color:#222;font:14px/1.65 'Microsoft YaHei',sans-serif;background:#fafafa}header{padding:12px 18px;border-bottom:1px solid #ccc;display:flex;gap:12px;align-items:center}select{max-width:47vw}button,select,input{font:inherit}small{display:block;padding:5px 18px;color:#666;border-bottom:1px solid #ddd}.grid{display:grid;grid-template-columns:34% 33% 33%;height:calc(100vh - 118px)}section{overflow:auto;border-right:1px solid #ddd;padding:12px}section>h2{font-size:15px;position:sticky;top:-12px;background:#fafafa;margin:0;padding:4px 0 12px;z-index:2}.body h1{font-size:20px;line-height:1.45}.body h2,.body h3{font-size:16px;line-height:1.5}.body img{max-width:100%;height:auto}.source{width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.65 Consolas,monospace}table{border-collapse:collapse;font-size:12px}td,th{border:1px solid #aaa;padding:4px}.math{overflow-x:auto}.katex{font-size:1.02em}a{color:#23518d}#meta{flex:1}#page{width:64px}</style>
<header><b>论文 OCR 对比</b><select id="paper"></select><button id="prev">上一页</button><input id="page" type="number" min="1" value="1"><span id="total"></span><button id="next">下一页</button><label><input type="checkbox" id="raw">源码</label><a href="report.html">报告</a></header>
<small id="meta"></small><small>MinerU 分页预览由 content_list 重建；PaddleOCR 使用逐页 Markdown，仅将图片路径按页隔离。公式仅渲染，不补编号、不纠错。全文原件：<a id="ml">MinerU</a> · <a id="pl">PaddleOCR</a> · <a id="pdf">PDF</a></small>
<div class="grid"><section><h2>原 PDF 页面</h2><img id="source" class="source"></section><section><h2>MinerU · vlm</h2><div class="body" id="m"></div></section><section><h2>PaddleOCR-VL-1.6</h2><div class="body" id="p"></div></section></div>
<script>const data=PAYLOAD;const $=x=>document.getElementById(x);data.forEach((r,i)=>$('paper').add(new Option(r.id+' '+r.title,i)));function show(){const r=data[+$('paper').value];let n=Math.max(1,Math.min(r.pages.length,+$('page').value||1));$('page').value=n;$('total').textContent='/ '+r.pages.length;$('meta').textContent=r.category;$('source').src=`samples/${r.id}/page-${String(n).padStart(3,'0')}.png`;$('ml').href=`results/${r.id}/mineru/full.md`;$('pl').href=`results/${r.id}/paddle/full.md`;$('pdf').href=`samples/${r.id}/source.pdf#page=${n}`;for(const key of ['m','p']){const el=$(key);el.replaceChildren();if($('raw').checked){const pre=document.createElement('pre');pre.textContent=r.pages[n-1][key+'raw'];el.append(pre)}else{el.innerHTML=r.pages[n-1][key];el.querySelectorAll('.math').forEach(x=>katex.render(x.dataset.tex,x,{displayMode:x.dataset.display==='true',throwOnError:false,strict:false,trust:false}))}el.parentElement.scrollTop=0}location.hash=r.id+':'+n} $('paper').onchange=()=>{$('page').value=1;show()};$('page').onchange=show;$('page').oninput=show;$('raw').onchange=show;$('prev').onclick=()=>{$('page').value=+$('page').value-1;show()};$('next').onclick=()=>{$('page').value=+$('page').value+1;show()};let [id,n]=location.hash.slice(1).split(':');let i=data.findIndex(x=>x.id===id);if(i>=0){$('paper').value=i;$('page').value=n||1}show();</script></html>'''
(ROOT/'compare.html').write_text(template.replace('PAYLOAD',json.dumps(payload,ensure_ascii=False).replace('<','\\u003c')),encoding='utf-8')
print('Viewer built:',len(payload),'papers; offline KaTeX and page images included')
