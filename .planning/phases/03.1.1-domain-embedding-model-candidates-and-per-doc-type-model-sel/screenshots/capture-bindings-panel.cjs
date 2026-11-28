const { chromium } = require('playwright');
const OUT = process.argv[2];
const T = 'o:00000000-0000-4000-8000-0000000000c1';
const b = (id, o={}) => ({ id, doc_type:'contract_legal', tenant_key:null, profile_id:'scoped-b-1024', model:'model-b', status:'available', stale:false, has_evidence:false, baseline_global_profile:null, previous_binding_id:null, activated_at:null, activated_by:null, created_at:'2026-11-02T00:00:00.000Z', completeness:null, ...o });
const base = (o={}) => ({ success:true, switch:'on', profiles_switch:'on', global_active:'global-a-1536',
  doc_types:['general','financial_report','contract_legal','invoice_receipt','product_technical','scanned_image'],
  profiles:[ {id:'global-a-1536',provider:'openai',model:'model-a',dims:1536,status:'active',doc_types:null},
    {id:'scoped-b-1024',provider:'voyage',model:'model-b',dims:1024,status:'available',doc_types:['contract_legal']},
    {id:'scoped-c-1024',provider:'voyage',model:'model-c',dims:1024,status:'available',doc_types:['financial_report']} ],
  bindings:[ b('00000000-0000-4000-8000-0000000000d3',{doc_type:'financial_report',profile_id:'scoped-c-1024',model:'model-c'}),
    b('00000000-0000-4000-8000-0000000000d2',{tenant_key:T,status:'backfilling',completeness:{state:'measured',chunks:10,missing:4,percent:60}}),
    b('00000000-0000-4000-8000-0000000000d1',{status:'active',has_evidence:true,baseline_global_profile:'global-a-1536',previous_binding_id:'00000000-0000-4000-8000-0000000000d3',activated_at:'2026-11-03T00:00:00.000Z',activated_by:'admin:placeholder',completeness:{state:'measured',chunks:1000,missing:1,percent:99.9}}),
    b('00000000-0000-4000-8000-0000000000d4',{doc_type:'financial_report',status:'active',stale:true,has_evidence:true,profile_id:'scoped-c-1024',model:'model-c',completeness:{state:'measured',chunks:200,missing:20,percent:90}}) ], ...o });
const scenarios = {
  'real-unmocked': null,
  'signed-out': { status: 401, body: { error: 'Unauthorized' } },
  'registry-503': { status: 503, body: { error: 'unavailable' } },
  'populated': { status: 200, body: base() },
  'switch-off': { status: 200, body: base({ switch:'off' }) },
  'empty': { status: 200, body: base({ bindings: [] }) },
  'no-scoped-profile': { status: 200, body: base({ bindings: [], profiles:[{id:'global-a-1536',provider:'openai',model:'model-a',dims:1536,status:'active',doc_types:null}] }) },
  'form-open': { status: 200, body: base(), action: 'form' },
  'confirm-dialog': { status: 200, body: base(), action: 'confirm' },
};
(async () => {
  const browser = await chromium.launch();
  for (const [name, sc] of Object.entries(scenarios)) {
    for (const [vw, vh, tag, theme] of [[1440, 900, 'desktop', null], [390, 844, 'mobile', null]]) {
      if (tag === 'mobile' && !['populated','form-open','empty'].includes(name)) continue;
      const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2 });
      if (sc) await page.route('**/api/rag/admin/embedding-bindings**', r => r.request().method()==='GET' ? r.fulfill({ status: sc.status, contentType:'application/json', body: JSON.stringify(sc.body) }) : r.fulfill({status:200,contentType:'application/json',body:'{"success":true}'}));
      await page.goto('http://localhost:3333/', { waitUntil: 'networkidle' }).catch(()=>{});
      await page.evaluate(() => { const a = document.querySelector('a.menu-item[data-tab="rag-administration"]'); a && a.click(); });
      await page.waitForTimeout(1500);
      const sec = page.locator('#rag-administration-bindings');
      await sec.scrollIntoViewIfNeeded().catch(()=>{});
      if (sc?.action === 'form') { await page.locator('[data-rag-bindings-new]').click().catch(e=>console.log('form',e.message)); await page.waitForTimeout(500); }
      if (sc?.action === 'confirm') { const btn = sec.locator('button', { hasText: /Roll back|Deactivate/ }).first(); await btn.click().catch(e=>console.log('confirm',e.message)); await page.waitForTimeout(500); }
      const file = `${OUT}/03.1.1-bindings-${name}-${tag}.png`;
      if (sc?.action === 'confirm') await page.screenshot({ path: file, fullPage: false });
      else await sec.screenshot({ path: file }).catch(async e => { console.log(name, e.message); await page.screenshot({ path: file }); });
      if (name==='populated' && tag==='desktop') { const html = await sec.innerText(); require('fs').writeFileSync(`${OUT}/../populated-text.txt`, html); const ov = await page.evaluate(()=>document.documentElement.scrollWidth); console.log('scrollWidth', ov); }
      if (tag==='mobile') console.log(name, 'mobile scrollWidth', await page.evaluate(()=>document.documentElement.scrollWidth));
      console.log('shot', file);
      await page.close();
    }
  }
  await browser.close();
})();
