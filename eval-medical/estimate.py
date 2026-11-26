import csv, sys, os, re, json, subprocess, statistics, collections
import tiktoken

MAN, BASE = sys.argv[1], sys.argv[2]
enc = tiktoken.get_encoding('cl100k_base')
T = lambda s: len(enc.encode(s, disallowed_special=()))
WM = 'Agenzia Italiana del Farmaco'
FOOTER = [re.compile(p) for p in (
    r'^Documento reso disponibile da AIFA il \d{2}/\d{2}/\d{4}',
    r'^Esula dalla competenza dell.AIFA',
    r'^medicinali e, pertanto, l.Agenzia non pu',
    r'^all.immissione in commercio \(o titolare AIC\)',
)]
PAGENUM = re.compile(r'^\d{1,3}$')
RCP_TOP = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}
RCP_SUB = {4: range(1, 10), 5: range(1, 4), 6: range(1, 7)}
FI_TITLES = {1: r'^che cos', 2: r'^(cosa deve sapere|prima di)', 3: r'^come ', 4: r'^possibili effetti', 5: r'^come conservare', 6: r'^contenuto della confezione'}
HEAD = re.compile(r'^(\d{1,2})(?:\.(\d{1,2}))?\.?(?:\s+(\S.{0,140}))?$')

def text_of(pdf):
    cache = f'{BASE}/work/txt/' + os.path.basename(pdf)[:-4] + '.txt'
    if os.path.exists(cache):
        return open(cache, encoding='utf-8').read()
    t = subprocess.run(['pdftotext', '-layout', pdf, '-'], capture_output=True, text=True, timeout=120).stdout
    open(cache, 'w', encoding='utf-8').write(t)
    return t

def clean(raw):
    out, noise = [], []
    for line in raw.split('\n'):
        s = line.strip()
        if s and ((len(s) <= 6 and s in WM) or PAGENUM.match(s) or any(p.match(s) for p in FOOTER)):
            noise.append(s); continue
        out.append(re.sub(r'\s{2,}', ' ', s))
    return out, noise

def sections(lines, doc_type):
    """Split cleaned lines into (key, title, lines). Returns secs, restarts."""
    secs = [((0, 0), 'preamble', [])]
    last = (0, 0); restarts = 0
    i = 0
    while i < len(lines):
        s = lines[i]; m = HEAD.match(s)
        key = None
        if m:
            a = int(m.group(1)); b = int(m.group(2)) if m.group(2) else 0; title = m.group(3)
            if title is None:
                j = i + 1
                while j < len(lines) and not lines[j]: j += 1
                title = lines[j] if j < len(lines) else ''
                consumed = j
            else:
                consumed = i
            ok = bool(title) and title[:1].isalpha()
            if doc_type == 'RCP':
                ok = ok and a in RCP_TOP and (b == 0 or (a in RCP_SUB and b in RCP_SUB[a])) and (m.group(3) is None or title[:1].isupper())
            else:
                ok = ok and b == 0 and a in FI_TITLES and re.match(FI_TITLES[a], title.lower()) is not None
            if ok:
                k = (a, b)
                if k > last:
                    key = k
                elif k == (1, 0) and last >= ((6, 0) if doc_type == 'RCP' else (4, 0)):
                    key = k; restarts += 1
                elif k == (1, 0) and doc_type == 'FI':
                    # table of contents followed by the real section 1
                    toc = [x for x in secs if x[0] != (0, 0)]
                    if toc and all(T(' '.join(x[2])) < 40 for x in toc):
                        for x in toc: secs[0][2].extend([x[1]] + x[2])
                        secs[:] = [secs[0]]
                        key = k
        if key:
            secs.append((key, title, [])); last = key; i = consumed + 1; continue
        secs[-1][2].append(s); i += 1
    return secs, restarts

def paragraphs(lines):
    paras, cur = [], []
    for s in lines:
        if not s:
            if cur: paras.append(' '.join(cur)); cur = []
        else:
            cur.append(s)
    if cur: paras.append(' '.join(cur))
    return paras

SENT = re.compile(r'(?<=[.;:!?])\s+')

def units(paras, cap):
    out = []
    for p in paras:
        n = T(p)
        if n <= cap: out.append((p, n)); continue
        for s in SENT.split(p):
            ns = T(s)
            if ns <= cap: out.append((s, ns)); continue
            ids = enc.encode(s, disallowed_special=())
            for k in range(0, len(ids), cap):
                piece = enc.decode(ids[k:k + cap]); out.append((piece, len(ids[k:k + cap])))
    return out

def pack(paras, cap, overlap, min_tokens=0):
    """Greedy pack of units to cap tokens; carry trailing units up to `overlap` tokens into the next chunk."""
    us = units(paras, cap)
    chunks, cur, cur_n = [], [], 0
    for u, n in us:
        if cur and cur_n + n > cap:
            chunks.append(cur)
            carry, cn = [], 0
            for cu, cun in reversed(cur):
                if cn + cun > overlap: break
                carry.insert(0, (cu, cun)); cn += cun
            if cn + n > cap: carry, cn = [], 0
            cur, cur_n = list(carry), cn
        cur.append((u, n)); cur_n += n
    if cur: chunks.append(cur)
    texts = [' '.join(u for u, _ in c) for c in chunks]
    if min_tokens and len(texts) > 1:
        merged = []
        for t in texts:
            if merged and T(t) < min_tokens: merged[-1] += ' ' + t
            else: merged.append(t)
        texts = merged
    return texts

rows = list(csv.DictReader(open(MAN, newline='', encoding='utf-8')))
agg = collections.defaultdict(float); per_doc = []
child_tok, child_bytes, parent_tok = [], [], []
qrd_complete = collections.Counter(); multi = 0; fi_unstructured = 0
for r in rows:
    key = f"{r['aic']}_{r['doc_type']}"; pdf = f'{BASE}/pdf/{key}.pdf'
    if not os.path.exists(pdf): continue
    raw = text_of(pdf)
    lines, noise = clean(raw)
    raw_t = T(re.sub(r'[ \t]{2,}', ' ', raw)); clean_text = '\n'.join(lines); clean_t = T(clean_text)
    noise_t = T('\n'.join(noise))
    dt = r['doc_type']
    secs, restarts = sections(lines, dt)
    if restarts: multi += 1
    keys = {k for k, _, _ in secs}
    if dt == 'RCP':
        top = {a for a, b in keys if a}
        qrd_complete['RCP_all_1_10' if set(range(1, 11)) <= top else 'RCP_incomplete'] += 1
    else:
        top = {a for a, b in keys if a}
        if not top: fi_unstructured += 1
        qrd_complete['FI_all_1_6' if set(range(1, 7)) <= top else ('FI_none' if not top else 'FI_partial')] += 1
    prod = f"{r['product_name'].title()} {r['strength'].split(' | ')[0]}"
    # A: parents = QRD subsections (level-2 where present, else level-1), children ~300 tok, 12% overlap, header prefix
    nA = nP = 0
    for (a, b), title, sl in secs:
        paras = paragraphs(sl)
        if not paras and a == 0: continue
        body = ' '.join(paras)
        if not body.strip():
            continue
        if dt == 'FI' and a == 0 and not top:
            # unnumbered FI: fall back to ~1024-token parents
            groups = pack(paras, 1024, 0)
        else:
            groups = [body]
        for g in groups:
            nP += 1; pt = T(g); parent_tok.append(pt)
            agg['parent_text_bytes'] += len(g.encode('utf-8'))
            sec = 'preambolo' if a == 0 else (f'{a}.{b}' if b else f'{a}')
            prefix = f"[{prod} | {dt} | {sec} {title[:80]}]"
            ptk = T(prefix)
            for c in pack([g] if len(groups) > 1 else paras, 300, 36):
                nA += 1; ct = T(c); child_tok.append(ct)
                agg['A_content_tokens'] += ct; agg['A_embed_tokens'] += ct + ptk + 1
                agg['A_content_bytes'] += len(c.encode('utf-8')); child_bytes.append(len(c.encode('utf-8')))
    # B: repo default general@1 markdown_sections 512/64/min 32, split at every heading, no prefix
    nB = 0
    for (a, b), title, sl in secs:
        paras = paragraphs(sl)
        if not paras: continue
        spt = T(f"{a}.{b} {title[:80]}\n\n") if a else 0
        for c in pack([title] + paras if title != 'preamble' else paras, 512, 64, 32):
            nB += 1; ct = T(c); agg['B_tokens'] += ct; agg['B_embed_tokens'] += ct + spt; agg['B_bytes'] += len(c.encode('utf-8'))
    # C: legacy createTokenBasedChunks 600/100 over the whole text
    nC = 0
    for c in pack(paragraphs(lines), 600, 100):
        nC += 1; ct = T(c); agg['C_tokens'] += ct; agg['C_bytes'] += len(c.encode('utf-8'))
    agg['raw_tokens'] += raw_t; agg['clean_tokens'] += clean_t; agg['noise_tokens'] += noise_t
    agg['clean_bytes'] += len(clean_text.encode('utf-8'))
    agg['A_chunks'] += nA; agg['A_parents'] += nP; agg['B_chunks'] += nB; agg['C_chunks'] += nC
    agg['pages'] += int(r['page_count']); agg['docs'] += 1
    per_doc.append(dict(key=key, dt=dt, pages=int(r['page_count']), raw_t=raw_t, clean_t=clean_t, noise_t=noise_t, A=nA, P=nP, B=nB, C=nC, restarts=restarts))

pc = sorted(parent_tok)
res = dict(agg)
res.update(
    qrd=dict(qrd_complete), multi_rcp_docs=multi, fi_unstructured=fi_unstructured,
    child_tok_mean=statistics.mean(child_tok), child_bytes_mean=statistics.mean(child_bytes),
    parent_tok_mean=statistics.mean(pc), parent_tok_p50=pc[len(pc) // 2], parent_tok_p95=pc[int(len(pc) * .95)], parent_tok_max=pc[-1],
    parents_over_2048=sum(1 for x in pc if x > 2048),
    by_type={dt: {k: sum(d[k] for d in per_doc if d['dt'] == dt) for k in ('pages', 'raw_t', 'clean_t', 'noise_t', 'A', 'P', 'B', 'C')} for dt in ('RCP', 'FI')},
)
json.dump(res, open(f'{BASE}/work/estimate.json', 'w'), indent=1)
json.dump(per_doc, open(f'{BASE}/work/estimate-per-doc.json', 'w'))
print(json.dumps(res, indent=1))
