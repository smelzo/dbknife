// Records the app window for the demos of the site: screenshots taken one after the other
// (about 15 a second) through the Chrome DevTools protocol, drawn at 2x whatever the display
// (the DevTools screencast stays at the display's scale), saved as JPEG with a list that
// ffmpeg turns into a video (e2e/demo-video.sh).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function recorder(page, dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const cdp = await page.context().newCDPSession(page)
  // width/height 0: the window's own size, drawn at twice the pixels
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: 2, mobile: false })
  const frames = []
  let recording = false
  let loop
  return {
    /** Starts taking frames. */
    start() {
      recording = true
      loop = (async () => {
        while (recording) {
          const time = Date.now() / 1000
          const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, optimizeForSpeed: true }).catch(() => undefined)
          // the app closed: the script failed before stop()
          if (!shot) break
          const { data } = shot
          const file = `f${String(frames.length).padStart(5, '0')}.jpg`
          writeFileSync(join(dir, file), Buffer.from(data, 'base64'))
          frames.push({ file, time })
        }
      })()
    },
    /** Saves the window as it is now, as a 2x PNG: the screenshots of the README and the site. */
    async still(file) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(file, Buffer.from(data, 'base64'))
    },
    /** Ends the video after `hold` ms more; writes the ffmpeg concat list and returns the frame count. */
    async stop(hold = 1500) {
      await page.waitForTimeout(hold)
      recording = false
      await loop
      const end = Date.now() / 1000
      const lines = frames.flatMap((f, i) => [`file '${f.file}'`, `duration ${((frames[i + 1]?.time ?? end) - f.time).toFixed(4)}`])
      // the concat demuxer ignores the duration of the last entry
      lines.push(`file '${frames.at(-1).file}'`)
      writeFileSync(join(dir, 'frames.txt'), lines.join('\n') + '\n')
      return frames.length
    }
  }
}
