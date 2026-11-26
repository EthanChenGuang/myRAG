import csv, sys, os, time, hashlib, json, urllib.request, urllib.error
man, base = sys.argv[1], sys.argv[2]
UA = 'Mozilla/5.0 (compatible; research-corpus-builder/1.0)'
pdfdir = f'{base}/pdf'; res_path = f'{base}/work/download.json'
res = json.load(open(res_path)) if os.path.exists(res_path) else {}
def get(url, timeout=120):
    delay = 2; err = None
    for _ in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=timeout) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            if e.code in (404, 400, 410, 429): return e.code, b''
            err = e.code
        except Exception as e: err = repr(e)
        time.sleep(delay); delay *= 2
    return f'fail:{err}', b''
lp = f'{base}/raw/confezioni_fornitura.csv'
if not os.path.exists(lp):
    c, b = get('https://drive.aifa.gov.it/farmaci/confezioni_fornitura.csv', 300)
    if c == 200: open(lp, 'wb').write(b)
    print('listing', c, len(b), flush=True); time.sleep(0.7)
rows = list(csv.DictReader(open(man, newline='')))
for i, r in enumerate(rows):
    key = f"{r['aic']}_{r['doc_type']}"
    if res.get(key, {}).get('status') in ('ok', 'mismatch'): continue
    code, body = get(r['source_url']); time.sleep(0.7)
    rec = {'http': code, 'expected': r['sha256']}
    if code == 200 and body.startswith(b'%PDF'):
        h = hashlib.sha256(body).hexdigest()
        open(f'{pdfdir}/{key}.pdf', 'wb').write(body)
        rec.update(sha256=h, bytes=len(body), status='ok' if h == r['sha256'] else 'mismatch')
    else:
        rec['status'] = 'missing'
    res[key] = rec
    json.dump(res, open(res_path + '.tmp', 'w')); os.replace(res_path + '.tmp', res_path)
    print(i, key, rec['status'], code, flush=True)
print('DONE', {s: sum(1 for v in res.values() if v['status'] == s) for s in ('ok', 'mismatch', 'missing')}, flush=True)
