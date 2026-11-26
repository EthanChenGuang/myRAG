import os,sys
exec(open(os.path.join(os.path.dirname(__file__),'ready2.py')).read().split('for n,(deps,a) in plans.items():')[0])
def roots(n,seen=None):
    seen=seen or set(); out=set()
    for d in plans.get(n,([],''))[0]:
        if d in done or d in seen: continue
        seen.add(d); r=roots(d,seen); out|= r if r else {d}
    return out
for n in sys.argv[1:]: print(n,'-> blocked at', sorted(roots(n)), [(r,plans.get(r,([],'?'))[1], r in HOLD_PLANS) for r in sorted(roots(n))])
