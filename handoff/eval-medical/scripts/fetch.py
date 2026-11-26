import json, sys, os, time, hashlib, subprocess, urllib.request, urllib.error, csv
BASE = sys.argv[1]; TARGET = int(sys.argv[2]) if len(sys.argv) > 2 else 4
UA = 'Mozilla/5.0 (compatible; research-corpus-builder/1.0)'
cands = json.load(open(f'{BASE}/work/candidates.json'))
state_path = f'{BASE}/work/state.json'
state = json.load(open(state_path)) if os.path.exists(state_path) else {}
os.makedirs(f'{BASE}/pdf', exist_ok=True); os.makedirs(f'{BASE}/work/tmp', exist_ok=True)
class RateLimited(Exception): pass
def get(url):
    delay = 2
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            if e.code == 429: raise RateLimited(url)
            if e.code in (404, 400, 410): return e.code, b''
            err = e.code
        except Exception as e:
            err = repr(e)
        time.sleep(delay); delay *= 2
    return f'fail:{err}', b''
def inspect(path):
    pages = 0
    try:
        out = subprocess.run(['pdfinfo', path], capture_output=True, text=True, timeout=60).stdout
        for l in out.splitlines():
            if l.startswith('Pages:'): pages = int(l.split()[1])
    except Exception: pass
    try:
        txt = subprocess.run(['pdftotext', '-l', '3', path, '-'], capture_output=True, text=True, timeout=60).stdout
    except Exception: txt = ''
    return pages, len(txt.strip())
def save():
    json.dump(state, open(state_path + '.tmp', 'w')); os.replace(state_path + '.tmp', state_path)
hashes = {d['sha256']: k for k, v in state.items() if v.get('docs') for d in v['docs'].values() if d.get('sha256')}
by_ing = {}
for c in cands: by_ing.setdefault(c['atc'], []).append(c)
try:
    for atc, cs in by_ing.items():
        ok = sum(1 for c in cs if state.get(c['aic'], {}).get('status') == 'ok')
        for c in cs:
            if ok >= TARGET: break
            if c['aic'] in state: continue
            rec = {'docs': {}, 'status': 'ok'}
            for dt, url in (('RCP', c['link_rcp']), ('FI', c['link_fi'])):
                code, body = get(url); time.sleep(0.7)
                d = {'url': url, 'http': code}
                if code != 200 or not body.startswith(b'%PDF'):
                    d['reason'] = 'not_pdf_or_http_error'; rec['status'] = 'skip'; rec['docs'][dt] = d; break
                h = hashlib.sha256(body).hexdigest()
                d.update(sha256=h, bytes=len(body))
                if h in hashes:
                    d['reason'] = f'duplicate_of:{hashes[h]}'; rec['status'] = 'skip'; rec['docs'][dt] = d; break
                tmp = f'{BASE}/work/tmp/{c["aic"]}_{dt}.pdf'; open(tmp, 'wb').write(body)
                pages, chars = inspect(tmp)
                d.update(pages=pages, text_chars_first3=chars, has_text_layer=chars >= 200)
                if not d['has_text_layer']:
                    d['reason'] = 'no_text_layer'; rec['status'] = 'skip'
                rec['docs'][dt] = d
                if rec['status'] == 'skip': break
            if rec['status'] == 'ok':
                for dt, d in rec['docs'].items():
                    os.replace(f'{BASE}/work/tmp/{c["aic"]}_{dt}.pdf', f'{BASE}/pdf/{c["aic"]}_{dt}.pdf')
                    hashes[d['sha256']] = c['aic']
                ok += 1
            for f in os.listdir(f'{BASE}/work/tmp'): os.remove(f'{BASE}/work/tmp/{f}')
            state[c['aic']] = rec; save()
            print(c['aic'], atc, rec['status'], {k: (v.get('pages'), v.get('reason')) for k, v in rec['docs'].items()}, flush=True)
except RateLimited as e:
    print('RATE LIMITED at', e, flush=True); save(); sys.exit(3)
print('DONE', flush=True)
