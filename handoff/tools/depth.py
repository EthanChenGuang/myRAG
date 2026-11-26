import os,functools,collections
exec(open(os.path.join(os.path.dirname(__file__),'ready2.py')).read().split('for n,(deps,a) in plans.items():')[0])
@functools.lru_cache(None)
def d(n):
    if n in done: return 0
    return 1+max([d(x) for x in plans.get(n,([],''))[0] if x in plans]+[0])
rem=[n for n in plans if n not in done]
print('remaining',len(rem),'max depth',max(d(n) for n in rem))
c=collections.Counter(d(n) for n in rem); print(sorted(c.items()))
print('human (autonomous:false) remaining:', sorted(n for n in rem if plans[n][1]=='false'))
