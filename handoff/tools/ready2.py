import re,glob,os,subprocess,sys
def sh(c): return subprocess.run(c,shell=True,capture_output=True,text=True).stdout
done={}
trunk='origin/claude/ecstatic-hamilton-86gtwv'
refs=[trunk]+[b for b in sh("git branch -r --format='%(refname:short)'").split() if b.startswith('origin/exec/') or b.startswith('origin/ci/')]
for b in refs:
    for f in sh(f"git ls-tree -r --name-only {b} .planning/phases").split():
        m=re.search(r'/(\d+(?:\.\d+)*-\d+)-SUMMARY\.md$',f)
        if m and m.group(1) not in done: done[m.group(1)]='trunk' if b==trunk else b
running=set(sys.argv[1:])
plans={}
for f in sorted(glob.glob('.planning/phases/*/*-PLAN.md')):
    n=os.path.basename(f)[:-8]
    if not re.match(r'^\d+(\.\d+)*-\d+$',n): continue
    t=open(f).read(); m=re.search(r'^depends_on:\s*(\[.*?\])',t,re.M); a=re.search(r'^autonomous:\s*(\w+)',t,re.M)
    plans[n]=(eval(m.group(1)) if m else [], a.group(1) if a else '?')
def anc(b,c): return subprocess.run(f"git merge-base --is-ancestor {c} {b}",shell=True).returncode==0
HOLD_PLANS={'06.2-13','06.2-19','06.2-33','05.3-49','05.3-50','04.3-53','04.3-54','05.2-39','05.2-40','05.2.1-25','07-22','07-23','07-26','07-29'}  # per-plan holds (planning/phase-7 workers)
BLOCKED_PHASES=('06.1-',)  # planning session hold, 2026-11-25
PHASE_GATES={'06.2-':['06-','06.1-','04.1.1-'],'03.2.1-':['03.1.1-','03.2-'],'06.3-':['06-'],'05.3-':['05.1.1-22'],'04.3-':['03.2-','04.2-'],'05.2-':['05-','05.1-','05.1.1-','03.2-']}  # phase starts only when the whole gating phase is on trunk/done
def phase_done(pref): return all(k in done for k in plans if k.startswith(pref))
for n,(deps,a) in plans.items():
    if any(n.startswith(g) and not all(phase_done(r) for r in rs) for g,rs in PHASE_GATES.items()): continue
    if n in done or n in running: continue
    if n.startswith(BLOCKED_PHASES) or n in HOLD_PLANS: continue
    if all(d in done for d in deps):
        srcs=sorted({done[d] for d in deps if done[d]!='trunk'})
        # reduce: drop branches that are ancestors of another
        red=[s for s in srcs if not any(o!=s and anc(o,s) for o in srcs)]
        # every dep must be reachable from the chosen base (trunk-merged deps too)
        def has(base,d):
            ref = base if base!='trunk' else trunk
            out=sh(f"git ls-tree -r --name-only {ref} .planning/phases | grep -c '/{d}-SUMMARY.md$'").strip()
            return out not in ('','0')
        missing=[d for d in deps if red and len(red)==1 and not has(red[0],d)]
        note=(" NEEDS-TRUNK-MERGE:"+",".join(missing)) if missing else ""
        print("READY",n,"auto="+a,"bases:",red,note)
