// playwriter helper: renders every frame of the launch video into video/frames/

const FPS = 30

export async function renderFrames({ context, outDir }) {
  // cache busted: the playwriter sandbox keeps imported modules between runs
  const { openVideoPage } = await import(`./open-page.js?v=${Date.now()}`)
  const page = await openVideoPage({ context })
  // warm up: load every tile the camera will visit, then restart the page at t=0
  const length = await page.evaluate(() => window.videoLength)
  for (let t = 0; t < length; t += 0.5) await page.evaluate((t) => window.videoFrame(t), t)
  for (let i = 0; i < 60 && (await page.evaluate(() => window.mapCapture.pendingTiles())) > 0; i++) await page.waitForTimeout(500)
  await page.reload({ waitUntil: 'domcontentloaded' })
  for (let i = 0; i < 80; i++) {
    const ok = await page.evaluate(() => Boolean(window.videoReady) && window.videoReady())
    if (ok) break
    await page.waitForTimeout(500)
  }
  const frames = Math.round(length * FPS)
  for (let f = 0; f < frames; f++) {
    await page.evaluate((t) => window.videoFrame(t), f / FPS)
    // a tile still loading would pop in on a later frame: wait for it and draw this frame again
    if ((await page.evaluate(() => window.mapCapture.pendingTiles())) > 0) {
      for (let i = 0; i < 40 && (await page.evaluate(() => window.mapCapture.pendingTiles())) > 0; i++) await page.waitForTimeout(250)
      await page.evaluate((t) => window.videoFrame(t), f / FPS)
    }
    await page.screenshot({ path: `${outDir}/f${String(f).padStart(4, '0')}.jpg`, type: 'jpeg', quality: 95 })
    if (f % 60 === 0) console.log(`frame ${f}/${frames}`)
  }
  await page.close()
  return frames
}
