const puppeteer = await import(process.env.PUPPETEER_CORE || 'puppeteer-core');
import http from 'http';
import fs from 'fs';
import path from 'path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const chrome = process.env.CHROME_PATH || '/usr/local/bin/google-chrome';
const port = 8765;

function serve() {
  return http.createServer((req, res) => {
    let u = decodeURIComponent(req.url.split('?')[0]);
    if (u.endsWith('/')) u += 'index.html';
    const fp = path.join(root, u);
    if (!fp.startsWith(root) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404); res.end('404'); return;
    }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.xml': 'application/xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    res.writeHead(200, { 'content-type': types[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  });
}

function staticChecks() {
  const fails = [];
  for (const name of fs.readdirSync(root).filter(n => n.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(root, name), 'utf8');
    if (/href\s*=\s*["']\s*#?\s*["']/.test(html)) fails.push(name + ' empty or hash-only href');
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
    for (const href of hrefs) {
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [file, hash] = href.split('#');
      const target = path.join(root, file || name);
      if (file && !fs.existsSync(target)) fails.push(`${name} missing ${href}`);
      if (hash) {
        const body = fs.readFileSync(file ? target : path.join(root, name), 'utf8');
        if (!body.includes(`id="${hash}"`)) fails.push(`${name} missing id ${hash} for ${href}`);
      }
    }
  }
  return fails;
}

const server = serve();
await new Promise(r => server.listen(port, '127.0.0.1', r));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const failures = staticChecks();
const shots = path.join(root, '..', 'opt', 'cursor', 'artifacts');
fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });

async function run(width, height, label) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.setViewport({ width, height, isMobile: width < 500, hasTouch: width < 500 });
  await page.goto(`http://127.0.0.1:${port}/ai.html`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  const first = await page.$('main a.card');
  if (!first) failures.push(label + ' no AI card');
  else {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      first.click(),
    ]);
  }
  const url = page.url();
  if (!url.includes('week-01.html#d1')) failures.push(label + ' landed ' + url);
  await page.waitForSelector('#d1 details.know[open]');
  const opened = await page.$eval('#d1', el => ({
    open: el.querySelector('details.know').open,
    text: el.innerText,
    summaryHit: el.querySelector('summary h4')?.innerText || '',
  }));
  for (const phrase of ['模型决策', '工具执行', '环境反馈', '停止条件', '是什么']) {
    if (!opened.text.includes(phrase)) failures.push(label + ' missing ' + phrase);
  }
  if (!opened.open) failures.push(label + ' details closed');
  if (label === 'mobile') {
    await page.screenshot({ path: '/opt/cursor/artifacts/ai-first-card-mobile.png', fullPage: false });
  }
  const before = page.url();
  const openBefore = await page.$eval('#d1 details.know', d => d.open);
  await page.click('#d1 > .foot .fv');
  const afterFav = await page.evaluate(() => ({
    url: location.href,
    open: document.querySelector('#d1 details.know').open,
    star: document.querySelector('#d1 > .foot .fv').classList.contains('on'),
  }));
  if (afterFav.url !== before) failures.push(label + ' star navigated');
  if (!afterFav.open || afterFav.open !== openBefore) failures.push(label + ' star toggled details');
  if (!afterFav.star) failures.push(label + ' star did not toggle');
  await page.click('#d1 > .foot .rd');
  const afterRead = await page.evaluate(() => ({
    url: location.href,
    open: document.querySelector('#d1 details.know').open,
    read: document.querySelector('#d1 > .foot .rd').classList.contains('on'),
  }));
  if (afterRead.url !== before || !afterRead.open || !afterRead.read) failures.push(label + ' check misfired ' + JSON.stringify(afterRead));
  await page.focus('#d2 details.know > summary');
  await page.keyboard.press('Enter');
  const d2 = await page.$eval('#d2 details.know', d => d.open);
  if (!d2) failures.push(label + ' keyboard did not open d2');
  if (errors.length) failures.push(label + ' js ' + errors.join(' | '));
  await page.goto(`http://127.0.0.1:${port}/week-02.html#d1`, { waitUntil: 'networkidle0' });
  await page.goto(`http://127.0.0.1:${port}/week-03.html#d1`, { waitUntil: 'networkidle0' });
  await page.goto(`http://127.0.0.1:${port}/week-04.html#d1`, { waitUntil: 'networkidle0' });
  for (const file of ['week-02.html', 'week-03.html', 'week-04.html']) {
    await page.goto(`http://127.0.0.1:${port}/${file}#d1`, { waitUntil: 'networkidle0' });
    const info = await page.$eval('#d1', el => ({
      open: !!el.querySelector('details.know')?.open,
      len: (el.querySelector('.kbody')?.innerText || '').trim().length,
    }));
    if (!info.open || info.len < 40) failures.push(label + ' ' + file + ' ' + JSON.stringify(info));
  }
  for (const id of ['d2', 'd3', 'd4', 'd5']) {
    await page.goto(`http://127.0.0.1:${port}/week-01.html#${id}`, { waitUntil: 'networkidle0' });
    const len = await page.$eval('#' + id + ' .kbody', el => el.innerText.trim().length);
    if (len < 30) failures.push(label + ' week1 ' + id + ' short');
  }
  await page.close();
}

await run(1280, 900, 'desktop');
await run(390, 844, 'mobile');

await browser.close();
server.close();
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('click-nav ok');
