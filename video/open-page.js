// playwriter helper: opens the capture page with a seeded Math.random and waits for tiles + walkers
export async function openVideoPage({ context }) {
  const page = await context.newPage()
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.addInitScript(() => {
    let s = 1234567
    Math.random = () => {
      s = (s * 16807) % 2147483647
      return (s - 1) / 2147483646
    }
  })
  await page.goto('http://localhost:5316/?capture&video&demo&lat=44.3168&lon=9.3222&mpp=0.21&ui=2&names=Tommy,Giulia,Luca,Sofia,Marco,Chiara,Pietro', { waitUntil: 'domcontentloaded' })
  for (let i = 0; i < 80; i++) {
    const ok = await page.evaluate(() => Boolean(window.videoReady) && (window.videoFrame(0), window.videoReady()))
    if (ok) break
    await page.waitForTimeout(500)
  }
  return page
}
