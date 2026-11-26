import json, sys, csv, random, collections, subprocess, math, os
import tiktoken
BASE = sys.argv[1]
enc = tiktoken.get_encoding('cl100k_base')
cands = {c['aic']: c for c in json.load(open(f'{BASE}/work/candidates.json'))}
state = json.load(open(f'{BASE}/work/state.json'))
ok = [a for a, v in state.items() if v['status'] == 'ok']
ings = sorted({cands[a]['atc'] for a in ok})
groups = collections.defaultdict(list)
for i in ings: groups[i[0]].append(i)
rnd = random.Random(42); split = {}
for g in sorted(groups):
    l = sorted(groups[g]); rnd.shuffle(l); k = round(len(l) * 0.2)
    for j, i in enumerate(l): split[i] = 'test' if j < k else 'train'
rows = []; toks = {}
for a in sorted(ok):
    c = cands[a]
    for dt in ('RCP', 'FI'):
        d = state[a]['docs'][dt]; p = f'{BASE}/pdf/{a}_{dt}.pdf'
        txt = subprocess.run(['pdftotext', p, '-'], capture_output=True, text=True).stdout
        toks[(a, dt)] = len(enc.encode(txt, disallowed_special=()))
        rows.append(dict(aic=a, aic_packs=c['packs'], product_name=c['name'], active_ingredient=c['ingredient'], atc=c['atc'],
            atc_desc=c['atc_desc'], holder=c['holder'], strength=c['strengths'], form=c['forms'], procedure=c['procedure'],
            doc_type=dt, source_url=d['url'], sha256=d['sha256'], bytes=d['bytes'], page_count=d['pages'],
            has_text_layer=d['has_text_layer'], text_tokens=toks[(a, dt)], split=split[c['atc']]))
with open(f'{BASE}/manifest.csv', 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
skips = collections.Counter(); skipdt = collections.Counter()
for a, v in state.items():
    if v['status'] == 'skip':
        for dt, d in v['docs'].items():
            if d.get('reason'): skips[d['reason'].split(':')[0]] += 1; skipdt[(d['reason'].split(':')[0], dt, str(d.get('http')))] += 1
pages = sum(r['page_count'] for r in rows); tok = sum(r['text_tokens'] for r in rows); nbytes = sum(r['bytes'] for r in rows)
chunks_pg = 2 * pages; chunks_tok = sum(math.ceil(r['text_tokens'] / 500) for r in rows)
grp = collections.defaultdict(lambda: [set(), 0, 0])
for r in rows:
    g = grp[r['atc'][0]]; g[0].add(r['atc']); g[1] += 1
spl = collections.defaultdict(lambda: [set(), set(), 0, 0])
for r in rows:
    s = spl[r['split']]; s[0].add(r['atc']); s[1].add(r['aic']); s[2] += 1; s[3] += r['page_count']
per_ing = collections.Counter(cands[a]['atc'] for a in ok)
json.dump(dict(products=len(ok), pdfs=len(rows), ingredients=len(ings), pages=pages, tokens=tok, bytes=nbytes, chunks_pg=chunks_pg,
    chunks_tok=chunks_tok, skips=dict(skips), skipdt={'|'.join(k): v for k, v in skipdt.items()},
    groups={g: [len(v[0]), len({r['aic'] for r in rows if r['atc'][0] == g}), v[1]] for g, v in sorted(grp.items())},
    splits={s: [len(v[0]), len(v[1]), v[2], v[3]] for s, v in spl.items()},
    per_ing_dist=dict(collections.Counter(per_ing.values())),
    tok_per_page=tok / pages, rcp_pages=sum(r['page_count'] for r in rows if r['doc_type'] == 'RCP'),
    fi_pages=sum(r['page_count'] for r in rows if r['doc_type'] == 'FI'),
    rcp_tok=sum(r['text_tokens'] for r in rows if r['doc_type'] == 'RCP'),
    min_pages=min(r['page_count'] for r in rows), max_pages=max(r['page_count'] for r in rows),
    holders=len({r['holder'] for r in rows}), candidates_tried=len(state)), open(f'{BASE}/work/stats.json', 'w'), indent=1)
print(open(f'{BASE}/work/stats.json').read())
