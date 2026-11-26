import re,glob,os,subprocess,collections
exec(open(os.path.join(os.path.dirname(__file__),'ready2.py')).read().split('for n,(deps,a) in plans.items():')[0])
reason=collections.Counter(); per=collections.defaultdict(collections.Counter); notdone_deps=collections.Counter()
for n,(deps,a) in plans.items():
    if n in done: continue
    ph=n.rsplit('-',1)[0]
    g=[g for g,rs in PHASE_GATES.items() if n.startswith(g) and not all(phase_done(r) for r in rs)]
    if g: per[ph]['gate:'+','.join(PHASE_GATES[g[0]])]+=1; continue
    if n.startswith(BLOCKED_PHASES): per[ph]['phase hold']+=1; continue
    if n in HOLD_PLANS: per[ph]['plan hold']+=1; continue
    miss=[d for d in deps if d not in done]
    if miss:
        per[ph]['deps']+=1
        for d in miss: notdone_deps[d]+=1
        continue
    per[ph]['READY auto='+a]+=1
for ph in sorted(per): print(ph, dict(per[ph]))
print('most-blocking unmet deps:', notdone_deps.most_common(15))
