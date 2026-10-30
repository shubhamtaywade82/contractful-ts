#!/usr/bin/env node
// Publish the v0.4.1 draft release with proper notes; delete the stale v0.4.0 draft.
const fs = require('fs');
const https = require('https');

const GH_TOKEN = fs.readFileSync('/home/z/my-project/upload/folder/5df75513/github-token.txt', 'utf8')
  .replace(/^GH_TOKEN=/, '').trim();
const REPO = 'shubhamtaywade82/contractful-ts';

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${REPO}/${path}`,
      method,
      headers: {
        'Authorization': `token ${GH_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'release-finalizer',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const j = d ? JSON.parse(d) : {};
        if (res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 300)}`));
        resolve(j);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  // 1. Update the v0.4.1 draft with real notes and publish it.
  const body = fs.readFileSync('/home/z/my-project/scripts/release-body-v0.4.1.md', 'utf8');
  const pub = await api('PATCH', 'releases/428698253', { body, draft: false });
  console.log('v0.4.1 published:', pub.html_url, '| draft:', pub.draft);
  console.log('  assets:', pub.assets.map(a => `${a.name} (${Math.round(a.size / 1024)}KB, ${a.state})`).join(', '));

  // 2. Delete the stale duplicate v0.4.0 draft (published v0.4.0 = #428133452 remains).
  await api('DELETE', 'releases/428084516');
  console.log('stale v0.4.0 draft #428084516 deleted');

  // 3. Final list.
  const list = await api('GET', 'releases?per_page=10');
  list.forEach(r => console.log(`#${r.id} | ${r.tag_name} | draft:${r.draft} | assets:${r.assets.map(a => a.name).join(',')}`));
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
