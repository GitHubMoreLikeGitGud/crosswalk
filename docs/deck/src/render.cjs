// Renders docs/deck/src/Crosswalk.html to docs/deck/Crosswalk.pdf (16:9, 1920x1080 px pages).
// Needs the `playwright` package and its Chromium build (not a dependency of the agent):
//   npm install --no-save playwright && npx playwright install chromium
//   node docs/deck/src/render.cjs [--png <dir>]
// or point NODE_PATH at a node_modules folder that already holds playwright.
// It prints one LAYOUT line per element that leaves its slide or runs into the slide footer
// (none is the expected output). With --png <dir>, it also writes one PNG per slide.
// The PDF carries the document title only; the renderer's own Creator and Producer strings
// are blanked afterwards (both live in the PDF's Info dictionary as plain text).
// Adapted from Weather-or-Not (same author, Apache-2.0).
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

(async () => {
  const src = path.join(__dirname, "Crosswalk.html");
  const out = path.join(__dirname, "..", "Crosswalk.pdf");
  const pngIdx = process.argv.indexOf("--png");
  const pngDir = pngIdx > 0 ? process.argv[pngIdx + 1] : null;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto("file:///" + src.replace(/\\/g, "/"), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);

  const report = await page.evaluate(() => {
    const issues = [];
    const missing = [];
    document.querySelectorAll("img").forEach((im) => { if (!im.complete || im.naturalWidth === 0) missing.push(im.getAttribute("src")); });
    document.querySelectorAll(".slide").forEach((s, i) => {
      const sr = s.getBoundingClientRect();
      s.querySelectorAll("*").forEach((e) => {
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        if (r.right > sr.right + 0.5 || r.bottom > sr.bottom + 0.5) issues.push(`slide ${i + 1}: <${e.tagName.toLowerCase()} class="${e.className}"> ends at ${Math.round(r.right - sr.left)}x${Math.round(r.bottom - sr.top)}`);
        if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === "hidden" && e !== s) issues.push(`slide ${i + 1}: <${e.tagName.toLowerCase()} class="${e.className}"> clips its content sideways`);
      });
      const body = s.querySelector(".body");
      const foot = s.querySelector(".foot");
      if (body && foot) {
        const fr = foot.getBoundingClientRect();
        body.querySelectorAll("*").forEach((e) => {
          const r = e.getBoundingClientRect();
          if (r.height > 0 && r.bottom > fr.top + 0.5) issues.push(`slide ${i + 1}: <${e.tagName.toLowerCase()} class="${e.className}"> runs into the footer by ${Math.round(r.bottom - fr.top)} px`);
        });
      }
    });
    return { issues, missing, slides: document.querySelectorAll(".slide").length };
  });
  report.issues.forEach((m) => console.log("LAYOUT " + m));
  report.missing.forEach((m) => console.log("MISSING IMAGE " + m));
  console.log(`slides ${report.slides}, layout issues ${report.issues.length}, missing images ${report.missing.length}`);

  if (pngDir) {
    fs.mkdirSync(pngDir, { recursive: true });
    const n = await page.locator(".slide").count();
    for (let i = 0; i < n; i++) {
      await page.locator(".slide").nth(i).screenshot({ path: path.join(pngDir, `slide-${String(i + 1).padStart(2, "0")}.png`) });
    }
  }

  await page.emulateMedia({ media: "print" });
  await page.pdf({ path: out, width: "1920px", height: "1080px", printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  await browser.close();

  // Blank the Creator and Producer strings in place (same byte length, so the xref stays valid).
  const buf = fs.readFileSync(out);
  let blanked = 0;
  for (const key of ["/Creator", "/Producer"]) {
    let from = 0;
    for (;;) {
      const at = buf.indexOf(key + " (", from);
      if (at < 0) break;
      const open = at + key.length + 1;
      let close = open + 1;
      while (close < buf.length && !(buf[close] === 0x29 && buf[close - 1] !== 0x5c)) close++;
      if (close >= buf.length) break;
      buf.fill(0x20, open + 1, close);
      blanked++;
      from = close;
    }
  }
  fs.writeFileSync(out, buf);
  console.log(`wrote ${path.relative(path.join(__dirname, "..", "..", ".."), out)} (${blanked} metadata string(s) blanked)`);
})().catch((e) => { console.error(e); process.exit(1); });
