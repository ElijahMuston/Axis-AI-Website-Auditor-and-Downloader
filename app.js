/* app.js — Axis app logic
   - Fetches a site (via demo CORS proxy)
   - Extracts inline CSS/JS and external assets
   - Downloads images & fonts (best-effort)
   - Builds a project folder structure inside a zip
   - Runs a heuristic "AI" scan and emits audit/report.md
   - Names the zip after the site's domain (example.com.zip)
*/

/* ======= Configuration ======= */
/* WARNING: public proxies are unreliable. For production, replace with server-side fetch. */
const PROXY = 'https://api.allorigins.win/raw?url='; // demo proxy
const LOG_MAX = 2000;

/* ======= UI elements ======= */
const scanBtn = document.getElementById('scanBtn');
const downloadBtn = document.getElementById('downloadBtn');
const statusText = document.getElementById('statusText');
const progressEl = document.getElementById('progress');
const quickKVs = document.getElementById('quickKVs');
const quickReport = document.getElementById('quickReport');
const reportEl = document.getElementById('report');
const htmlPreview = document.getElementById('htmlPreview');
const logArea = document.getElementById('log');
const issuesCount = document.getElementById('issuesCount');
const timeTaken = document.getElementById('timeTaken');

let lastZipBlob = null;
let lastDomainName = null;

/* ======= Utility Logging ======= */
function log(msg){
  const ts = new Date().toLocaleTimeString();
  logArea.value = `${ts} — ${msg}\n` + logArea.value;
  if(logArea.value.length > LOG_MAX) logArea.value = logArea.value.slice(0, LOG_MAX);
}

/* Simple fetch wrappers using proxy */
async function fetchText(url){
  try {
    const res = await fetch(PROXY + encodeURIComponent(url));
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return text;
  } catch(e) {
    log(`fetchText failed: ${url} — ${e.message}`);
    return '';
  }
}
async function fetchBlob(url){
  try {
    const res = await fetch(PROXY + encodeURIComponent(url));
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const b = await res.blob();
    return b;
  } catch(e){
    log(`fetchBlob failed: ${url} — ${e.message}`);
    return null;
  }
}

/* Resolve relative URLs against a base domain */
function resolveUrl(base, relative){
  try{ return new URL(relative, base).href; }
  catch(e){ return relative; }
}

/* Extract url(...) tokens from CSS content */
function extractUrlsFromCss(css){
  const urls = [];
  const re = /url\((?:'|")?([^'")]+)(?:'|")?\)/g;
  let m;
  while((m = re.exec(css)) !== null){
    urls.push(m[1]);
  }
  return urls;
}

/* Create a safe filename from a URL */
function fileNameFromUrl(url){
  try{
    const u = new URL(url);
    let name = u.pathname.split('/').filter(Boolean).pop() || 'index';
    name = name.split('?')[0];
    if(!name.includes('.')) {
      // try to guess extension from pathname or return 'asset'
      const ext = (u.pathname.split('.').pop() || '').toLowerCase();
      if(ext && ext.length <= 5) name = `${name}.${ext}`;
    }
    return name || 'asset';
  } catch(e){
    return 'asset';
  }
}

/* Extract domain-only for zip name: example.com */
function domainFromUrl(fullUrl){
  try{
    const u = new URL(fullUrl);
    return u.hostname;
  }catch(e){
    // fallback: remove protocol and path
    return fullUrl.replace(/^https?:\/\//,'').split('/')[0];
  }
}

/* ======= Heuristic AI Scan (returns structured result + markdown) ======= */
function runHeuristicScan(doc, domain, meta){
  // meta: {cssFiles, jsFiles, images, fonts, inlineCss, inlineJs}
  const findings = [];
  const suggestions = [];
  const kv = {};

  // Basic meta checks
  const title = (doc.querySelector('title') || {innerText:''}).innerText.trim();
  const metaDescEl = doc.querySelector('meta[name="description"]');
  const metaDesc = metaDescEl ? (metaDescEl.getAttribute('content') || '') : '';
  const hasViewport = !!doc.querySelector('meta[name="viewport"]');
  const lang = doc.documentElement.getAttribute('lang') || '';
  const charset = !!doc.querySelector('meta[charset]');

  if(!title){ findings.push({level:'warn', text:'Missing <title> tag'}); suggestions.push('Add a clear title tag for SEO and usability.'); }
  if(!metaDesc){ findings.push({level:'warn', text:'Missing meta description'}); suggestions.push('Add a meta description for previews.'); }
  if(!hasViewport){ findings.push({level:'warn', text:'Missing viewport meta'}); suggestions.push('Add viewport meta for mobile-friendliness.'); }
  if(!lang){ findings.push({level:'warn', text:'Missing html lang attribute'}); suggestions.push('Add <html lang="en"> or appropriate locale.'); }
  if(!charset){ findings.push({level:'info', text:'No charset meta tag; default will be used'}); }

  // Images/alt
  const imgs = Array.from(doc.querySelectorAll('img'));
  const missingAlt = imgs.filter(i => !(i.getAttribute('alt') || '').trim());
  if(missingAlt.length){
    findings.push({level:'warn', text:`${missingAlt.length} image(s) missing alt attribute`});
    suggestions.push('Add alt attributes to images for accessibility.');
  } else {
    findings.push({level:'ok', text:`All ${imgs.length} images have alt text (or none present).`});
  }

  // Headings
  const h1s = Array.from(doc.querySelectorAll('h1'));
  if(h1s.length === 0) { findings.push({level:'warn', text:'No H1 found'}); suggestions.push('Add a single H1 for page structure.'); }
  else if(h1s.length > 1) { findings.push({level:'info', text:`Multiple H1 tags (${h1s.length}) — check semantics`}); }
  else { findings.push({level:'ok', text:'Single H1 found'}); }

  // Inline code heuristics
  if(meta.inlineCssBlocks > 0) findings.push({level:'info', text:`${meta.inlineCssBlocks} inline <style> block(s)`});
  if(meta.inlineJsBlocks > 0) findings.push({level:'info', text:`${meta.inlineJsBlocks} inline <script> block(s)`});

  // Assets count
  const totalAssets = meta.cssFiles.length + meta.jsFiles.length + meta.images.length + meta.fonts.length;
  findings.push({level: totalAssets>40 ? 'warn':'ok', text:`${totalAssets} external assets detected`});
  if(totalAssets>40) suggestions.push('Consider bundling, lazy-loading, or using CDNs for large counts of assets.');

  // Forms labels
  const forms = Array.from(doc.querySelectorAll('form'));
  let formsIssues = 0;
  forms.forEach(f=>{
    const controls = Array.from(f.querySelectorAll('input,textarea,select'));
    const unlabeled = controls.filter(c=>{
      const id = c.id;
      if(id && doc.querySelector(`label[for="${id}"]`)) return false;
      if(c.closest('label')) return false;
      return true;
    });
    if(unlabeled.length) formsIssues++;
  });
  if(formsIssues) { findings.push({level:'warn', text:`${formsIssues} form(s) with unlabeled controls`}); suggestions.push('Label form controls for accessibility.'); }
  else findings.push({level:'ok', text:'Forms appear labeled (if any).'});

  // Bad anchors
  const anchors = Array.from(doc.querySelectorAll('a'));
  const badAnchors = anchors.filter(a=>{
    const href = (a.getAttribute('href')||'').trim();
    return !href || href === '#' || href.toLowerCase().startsWith('javascript:');
  });
  if(badAnchors.length) { findings.push({level:'warn', text:`${badAnchors.length} anchor(s) have empty or javascript: href`}); }

  // Large inline heuristics
  if(meta.inlineCssSize > 20000) { findings.push({level:'warn', text:'Large inline CSS (>20KB)'}); }
  if(meta.inlineJsSize > 50000) { findings.push({level:'warn', text:'Large inline JS (>50KB)'}); }

  // Prepare report markdown
  const md = [];
  md.push(`# AI Scan Report — ${domain}`);
  md.push(`Scan date: ${new Date().toISOString()}`);
  md.push('');
  md.push('## Summary');
  md.push(`- Title: ${title || '(missing)'}`);
  md.push(`- Description: ${metaDesc ? metaDesc.slice(0,140) : '(missing)'}`);
  md.push(`- Lang: ${lang || '(missing)'}`);
  md.push(`- Assets: ${totalAssets}`);
  md.push('');
  md.push('## Findings');
  findings.forEach(f => md.push(`- [${f.level.toUpperCase()}] ${f.text}`));
  md.push('');
  md.push('## Suggestions');
  suggestions.forEach(s => md.push(`- ${s}`));
  md.push('');
  md.push('---');
  md.push('Copy this file into `audit/report.md` for developer guidance.');

  // Build a simple kv summary for UI
  const summary = {
    title, description: metaDesc, lang, images: meta.images.length, css: meta.cssFiles.length,
    js: meta.jsFiles.length, fonts: meta.fonts.length, inlineCssBlocks: meta.inlineCssBlocks,
    inlineJsBlocks: meta.inlineJsBlocks, findings, suggestions, mdReport: md.join('\n')
  };
  return summary;
}

/* ======= Main process (fetch, parse, download assets, package) ======= */
async function processSite(url){
  const t0 = Date.now();
  statusText.textContent = 'Fetching HTML...';
  progressEl.style.display = 'block';
  progressEl.value = 5;
  log(`Starting fetch for ${url}`);

  // fetch HTML
  const htmlText = await fetchText(url);
  if(!htmlText){
    statusText.textContent = 'Failed to fetch HTML. Check URL or proxy.';
    progressEl.style.display = 'none';
    return null;
  }
  progressEl.value = 15;
  statusText.textContent = 'Parsing HTML...';

  // Parse DOM
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlText, 'text/html');

  // Prepare zip structure
  const zip = new JSZip();
  const root = zip.folder('website');
  const cssFolder = root.folder('css');
  const jsFolder = root.folder('js');
  const imgFolder = root.folder('images');
  const fontsFolder = root.folder('fonts');
  const auditFolder = root.folder('audit');

  // Collect inline code
  statusText.textContent = 'Extracting inline CSS/JS...';
  progressEl.value = 20;
  let combinedCSS = '';
  let combinedJS = '';

  const styleEls = Array.from(doc.querySelectorAll('style'));
  styleEls.forEach(s => { combinedCSS += s.textContent + '\n\n'; s.remove(); });

  const inlineScriptEls = Array.from(doc.querySelectorAll('script')).filter(s => !s.src);
  inlineScriptEls.forEach(s => { combinedJS += s.textContent + '\n\n'; s.remove(); });

  // Keep track of meta info
  const metaInfo = {
    cssFiles: [], jsFiles: [], images: [], fonts: [],
    inlineCssBlocks: styleEls.length, inlineJsBlocks: inlineScriptEls.length,
    inlineCssSize: combinedCSS.length, inlineJsSize: combinedJS.length
  };

  // Add combined files
  if(combinedCSS.trim()){
    cssFolder.file('inline-styles.css', combinedCSS);
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'css/inline-styles.css';
    doc.head.appendChild(link);
  }
  if(combinedJS.trim()){
    jsFolder.file('inline-scripts.js', combinedJS);
    const s = doc.createElement('script');
    s.src = 'js/inline-scripts.js';
    doc.body.appendChild(s);
  }

  // Fetch external CSS files
  statusText.textContent = 'Fetching external CSS...';
  progressEl.value = 30;
  const cssEls = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'));
  for(const el of cssEls){
    let href = el.getAttribute('href') || el.href;
    const resolved = resolveUrl(url, href);
    log(`Fetching CSS: ${resolved}`);
    const cssText = await fetchText(resolved);
    const fname = fileNameFromUrl(resolved) || 'style.css';
    cssFolder.file(fname, cssText || '');
    metaInfo.cssFiles.push({url:resolved, fname});
    el.setAttribute('href', 'css/' + fname);

    // parse url(...) inside CSS and try to fetch images/fonts referenced
    const cssUrls = extractUrlsFromCss(cssText || '');
    for(const u of cssUrls){
      const assetUrl = resolveUrl(resolved, u);
      const ext = (assetUrl.split('.').pop() || '').split('?')[0].toLowerCase();
      if(['woff','woff2','ttf','otf','eot'].includes(ext)){
        // font
        const b = await fetchBlob(assetUrl);
        if(b){ const fn = fileNameFromUrl(assetUrl); fontsFolder.file(fn,b); metaInfo.fonts.push({url:assetUrl,fname:fn}); }
      } else if(['png','jpg','jpeg','gif','svg','webp','avif'].includes(ext)){
        const b = await fetchBlob(assetUrl);
        if(b){ const fn = fileNameFromUrl(assetUrl); imgFolder.file(fn,b); metaInfo.images.push({url:assetUrl,fname:fn}); }
      } else {
        // skip other types for now
      }
    }
  }

  progressEl.value = 55;
  statusText.textContent = 'Fetching external JS...';
  // Fetch external JS files
  const scriptEls = Array.from(doc.querySelectorAll('script[src]'));
  for(const el of scriptEls){
    let src = el.getAttribute('src') || el.src;
    const resolved = resolveUrl(url, src);
    log(`Fetching JS: ${resolved}`);
    const jsText = await fetchText(resolved);
    const fname = fileNameFromUrl(resolved) || 'script.js';
    jsFolder.file(fname, jsText || '');
    metaInfo.jsFiles.push({url:resolved,fname});
    el.setAttribute('src', 'js/' + fname);
  }

  progressEl.value = 70;
  statusText.textContent = 'Fetching images...';
  // Fetch images referenced by <img>
  const imgEls = Array.from(doc.querySelectorAll('img'));
  for(const img of imgEls){
    const src = img.getAttribute('src') || img.src;
    const resolved = resolveUrl(url, src);
    log(`Fetching image: ${resolved}`);
    const b = await fetchBlob(resolved);
    const fn = fileNameFromUrl(resolved);
    if(b){
      imgFolder.file(fn, b);
      img.setAttribute('src', 'images/' + fn);
      metaInfo.images.push({url:resolved,fname:fn});
    } else {
      // leave original src if fetch fails
      metaInfo.images.push({url:resolved,fname:null});
    }
  }

  progressEl.value = 80;
  statusText.textContent = 'Fetching favicons & fonts (preload)...';
  // Try to fetch common favicon links
  const iconLink = doc.querySelector('link[rel~="icon"], link[rel~="shortcut icon"]');
  if(iconLink){
    const href = iconLink.getAttribute('href') || iconLink.href;
    const resolved = resolveUrl(url, href);
    const iconBlob = await fetchBlob(resolved);
    if(iconBlob){
      const fn = fileNameFromUrl(resolved) || 'favicon.ico';
      root.file(fn, iconBlob);
      iconLink.setAttribute('href', fn);
      log('Fetched favicon: ' + resolved);
    }
  } else {
    // try root /favicon.ico
    const tryFav = resolveUrl(url, '/favicon.ico');
    const b = await fetchBlob(tryFav);
    if(b){ root.file('favicon.ico', b); log('Fetched fallback favicon'); }
  }

  // Try to fetch font preload links
  const preloadFonts = Array.from(doc.querySelectorAll('link[rel="preload"][as="font"]'));
  for(const l of preloadFonts){
    const href = l.getAttribute('href') || l.href;
    const resolved = resolveUrl(url, href);
    const b = await fetchBlob(resolved);
    if(b){
      const fn = fileNameFromUrl(resolved);
      fontsFolder.file(fn, b);
      l.setAttribute('href', 'fonts/' + fn);
      metaInfo.fonts.push({url:resolved,fname:fn});
    }
  }

  // Also parse inline CSS combined for url(...) fonts
  const inlineCssUrls = extractUrlsFromCss(combinedCSS || '');
  for(const u of inlineCssUrls){
    const resolved = resolveUrl(url, u);
    const ext = (resolved.split('.').pop()||'').split('?')[0].toLowerCase();
    if(['woff','woff2','ttf','otf','eot'].includes(ext)){
      const b = await fetchBlob(resolved);
      if(b){ const fn = fileNameFromUrl(resolved); fontsFolder.file(fn,b); metaInfo.fonts.push({url:resolved,fname:fn}); }
    }
  }

  progressEl.value = 90;
  statusText.textContent = 'Building final project files...';

  // Build final index.html from modified doc
  const finalHTML = '<!doctype html>\n' + doc.documentElement.outerHTML;
  root.file('index.html', finalHTML);

  // Write combined CSS/JS files if produced earlier (already added but ensure)
  if(combinedCSS.trim()) cssFolder.file('inline-styles.css', combinedCSS);
  if(combinedJS.trim()) jsFolder.file('inline-scripts.js', combinedJS);

  // Run heuristic scan
  statusText.textContent = 'Running AI audit...';
  const scanResult = runHeuristicScan(doc, url, metaInfo);

  // Create audit files
  auditFolder.file('report.md', scanResult.mdReport || '');
  auditFolder.file('report.json', JSON.stringify(scanResult, null, 2));

  // README
  const readme = `# Website Project (generated)
This project was generated from ${url}
Open in VS Code to inspect & edit:
- index.html
- css/
- js/
- images/
- fonts/
- audit/report.md

Notes:
- Some assets may not have been fetched due to cross-origin restrictions.
- Review audit/report.md for suggested fixes.
`;
  root.file('README.md', readme);

  // Generate zip
  statusText.textContent = 'Packaging ZIP...';
  progressEl.value = 95;

  const blob = await zip.generateAsync({type:'blob'}, function updateMeta(metadata){
    // optional progress callback (metadata.percent)
    progressEl.value = Math.min(95 + Math.round(metadata.percent/1.25), 99);
  });

  const domainName = domainFromUrl(url) || 'site';
  const safeName = domainName.replace(/[:\/\\?%*\|"<> ]+/g,'-');
  const zipName = `${safeName}.zip`;

  lastZipBlob = blob;
  lastDomainName = zipName;
  downloadBtn.disabled = false;

  progressEl.value = 100;
  progressEl.style.display = 'none';
  const took = Math.round((Date.now() - t0)/1000);
  timeTaken.textContent = ` (${took}s)`;
  statusText.textContent = `Done — project ready: ${zipName}`;
  htmlPreview.value = finalHTML.slice(0,2500) + (finalHTML.length>2500 ? '\n\n... (truncated)' : '');
  renderScanResult(scanResult);

  log('Packaging complete: ' + zipName);

  return {blob, zipName};
}

/* Render scan result into UI */
function renderScanResult(scan){
  reportEl.innerHTML = '';
  quickKVs.innerHTML = '';

  quickKVs.appendChild(kvEl('Title', scan.title || '(missing)'));
  quickKVs.appendChild(kvEl('Description', (scan.description || '').slice(0,80) || '(missing)'));
  quickKVs.appendChild(kvEl('Lang', scan.lang || '(missing)'));
  quickKVs.appendChild(kvEl('Images', String(scan.images || 0)));
  quickKVs.appendChild(kvEl('CSS', String(scan.css || 0)));
  quickKVs.appendChild(kvEl('JS', String(scan.js || 0)));
  quickKVs.appendChild(kvEl('Fonts', String(scan.fonts || 0)));

  quickReport.textContent = (scan.suggestions||[]).slice(0,4).join(' · ') || 'No quick suggestions';

  const frag = document.createDocumentFragment();
  (scan.findings||[]).forEach(f=>{
    const d = document.createElement('div');
    d.className = 'report-item';
    d.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
      <div><strong>${escapeHtml(f.text)}</strong></div>
      <div style="font-size:12px;color:${f.level==='warn' ? 'var(--warn)' : (f.level==='ok' ? 'var(--ok)' : 'var(--muted)')}">${f.level.toUpperCase()}</div>
    </div>`;
    frag.appendChild(d);
  });
  reportEl.appendChild(frag);
  const issues = (scan.findings || []).filter(f=>f.level==='warn').length;
  issuesCount.textContent = issues + ' issues';
  issuesCount.style.background = issues ? 'rgba(245,158,11,0.10)' : 'rgba(16,185,129,0.06)';
}

/* small UI helpers */
function kvEl(k,v){
  const d = document.createElement('div'); d.className='kv'; d.textContent = `${k}: ${v}`; return d;
}
function escapeHtml(s){ return (s+'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* ======= Event wiring ======= */
scanBtn.addEventListener('click', async ()=>{
  const url = document.getElementById('url').value.trim();
  if(!url){
    alert('Please enter a URL including protocol (https://)');
    return;
  }
  // reset UI
  downloadBtn.disabled = true;
  reportEl.innerHTML = '';
  htmlPreview.value = '';
  logArea.value = '';
  quickKVs.innerHTML = '';
  quickReport.textContent = '';
  issuesCount.textContent = '-';
  timeTaken.textContent = '';

  try{
    await processSite(url);
  }catch(e){
    console.error(e);
    statusText.textContent = 'Error: ' + (e.message || e);
    log('Fatal error: ' + (e.stack || e.message || e));
    progressEl.style.display = 'none';
  }
});

downloadBtn.addEventListener('click', ()=>{
  if(lastZipBlob && lastDomainName){
    saveAs(lastZipBlob, lastDomainName);
  }
});
