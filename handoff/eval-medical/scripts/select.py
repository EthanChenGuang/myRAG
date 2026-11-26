import csv, collections, random, re, json, sys
BASE = sys.argv[1]
rows = list(csv.DictReader(open(f'{BASE}/raw/confezioni_fornitura.csv', encoding='latin-1'), delimiter=';'))
atcdesc = {r['CODICE_ATC']: r['DESCRIZIONE'] for r in csv.DictReader(open(f'{BASE}/raw/atc.csv', encoding='latin-1'), delimiter=';')}
SKIP_PROC = {'Omeopatico', 'Importazione Parallela', ''}
STR = re.compile(r'(\d+(?:[.,]\d+)?\s*(?:MG|MCG|µG|G|UI|U\.I\.|MMOL|%)(?:\s*/\s*\d*(?:[.,]\d+)?\s*(?:ML|G|DOSE|ORE|H|24 ORE))?)', re.I)
prods = {}
for r in rows:
    if r['STATO_AMMINISTRATIVO'] != 'Autorizzata' or r['TIPO_PROCEDURA'] in SKIP_PROC: continue
    pa = r['PA_ASSOCIATI'].strip(); atc = r['CODICE_ATC'].strip()
    if not pa or '/' in pa or len(atc) != 7 or pa == 'N.D.': continue
    p = prods.setdefault(r['COD_FARMACO'], dict(aic=r['COD_FARMACO'], name=r['DENOMINAZIONE'], ingredient=pa, atc=atc,
        holder=r['RAGIONE_SOCIALE'], holder_code=r['CODICE_DITTA'], procedure=r['TIPO_PROCEDURA'], forms=set(), strengths=set(),
        packs=[], link_rcp=r['LINK_RCP'], link_fi=r['LINK_FI']))
    p['forms'].add(r['FORMA']); p['packs'].append(r['CODICE_AIC'])
    m = STR.search(r['DESCRIZIONE'].replace('"', ''))
    if m: p['strengths'].add(re.sub(r'\s+', ' ', m.group(1).upper()))
byatc = collections.defaultdict(list)
for p in prods.values():
    if p['link_rcp'] and p['link_fi']: byatc[p['atc']].append(p)
elig = {a: ps for a, ps in byatc.items() if len({p['holder'] for p in ps}) >= 4 and a[0] not in 'V'}
quota = dict(C=15, N=17, J=13, L=9, A=11, M=7, R=6, G=6, B=5, H=4, D=3, S=3, P=2, V=0)
rnd = random.Random(20261126)
chosen = []
groups = collections.defaultdict(list)
for a in sorted(elig): groups[a[0]].append(a)
for g, q in quota.items():
    pool = groups.get(g, []); rnd.shuffle(pool)
    chosen += pool[:q]
    print(g, 'eligible', len(groups.get(g, [])), 'taken', min(q, len(pool)), file=sys.stderr)
def order(ps):
    ps = sorted(ps, key=lambda p: p['aic']); rnd.shuffle(ps)
    out, hs, fs, ss = [], set(), set(), set()
    while ps:
        best = max(ps, key=lambda p: (p['holder'] not in hs) * 4 + bool(p['forms'] - fs) * 2 + bool(p['strengths'] - ss))
        ps.remove(best); out.append(best); hs.add(best['holder']); fs |= best['forms']; ss |= best['strengths']
    return out
sel = []
for a in chosen:
    for rank, p in enumerate(order(elig[a])[:9]):
        q = dict(p); q['forms'] = ' | '.join(sorted(p['forms'])); q['strengths'] = ' | '.join(sorted(p['strengths']))
        q['packs'] = ' '.join(sorted(p['packs'])); q['rank'] = rank; q['atc_desc'] = atcdesc.get(a, '')
        sel.append(q)
json.dump(sel, open(f'{BASE}/work/candidates.json', 'w'), ensure_ascii=False, indent=0)
print(len(chosen), 'ingredients', len(sel), 'candidates', file=sys.stderr)
