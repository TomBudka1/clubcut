// Finds live play in game film by measuring how much of the picture changes between sampled frames.
// Live play (players running, the camera panning to follow the ball) changes much more of the frame
// than dead time (players walking back, huddles, injury stoppages, waiting on a pull or a free kick).

export type ActivityTrack = { duration: number; interval: number; scores: Float32Array }
export type Range = { start: number; end: number }
export type CutSettings = { strictness: number; leadIn: number }

const FRAME_WIDTH = 96
const FRAME_HEIGHT = 54
const PIXEL_CHANGE = 18 // luminance delta (0-255) that counts as a changed pixel; filters compression noise
const SMOOTHING = 3 // seconds of activity averaged together so one still frame does not split a play
const MIN_GAP = 4 // pauses shorter than this stay inside the surrounding play
const MIN_PLAY = 3 // bursts shorter than this are treated as noise, such as a quick camera bump
const TAIL = 1.5 // seconds kept after the motion settles

function abortError() {
  return new DOMException('Analysis cancelled', 'AbortError')
}

function seekTo(video: HTMLVideoElement, time: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('seeked', done)
      video.removeEventListener('error', fail)
      signal.removeEventListener('abort', cancel)
    }
    const done = () => { cleanup(); resolve() }
    const fail = () => { cleanup(); reject(new Error('The browser could not read frames from this video.')) }
    const cancel = () => { cleanup(); reject(abortError()) }
    video.addEventListener('seeked', done)
    video.addEventListener('error', fail)
    signal.addEventListener('abort', cancel)
    video.currentTime = time
  })
}

// Scans every file in order and joins the results into one activity track covering the whole game.
export async function analyzeActivity(footage: { file: File; duration: number }[], onProgress: (fraction: number) => void, signal: AbortSignal): Promise<ActivityTrack> {
  const duration = footage.reduce((total, part) => total + part.duration, 0)
  // One sample per second is plenty for a full game; shorter clips get finer detail.
  const interval = duration > 1800 ? 1 : 0.5
  const counts = footage.map((part) => Math.max(2, Math.round(part.duration / interval)))
  const scores = new Float32Array(counts.reduce((total, count) => total + count, 0))

  let offset = 0
  for (let index = 0; index < footage.length; index += 1) {
    const start = offset
    const count = counts[index]
    await scanFile(footage[index].file, interval, scores.subarray(start, start + count), (fraction) => onProgress((start + fraction * count) / scores.length), signal)
    offset += count
  }

  onProgress(1)
  return { duration, interval, scores }
}

async function scanFile(file: File, interval: number, scores: Float32Array, onProgress: (fraction: number) => void, signal: AbortSignal) {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve()
      video.onerror = () => reject(new Error(`${file.name} could not be decoded by your browser.`))
      video.src = url
    })

    const duration = video.duration
    const count = scores.length
    const canvas = document.createElement('canvas')
    canvas.width = FRAME_WIDTH
    canvas.height = FRAME_HEIGHT
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Your browser blocked the canvas needed to scan video frames.')

    const pixels = FRAME_WIDTH * FRAME_HEIGHT
    let previous = new Uint8Array(pixels)
    let current = new Uint8Array(pixels)

    for (let index = 0; index < count; index += 1) {
      if (signal.aborted) throw abortError()
      await seekTo(video, Math.min(index * interval + 0.01, duration - 0.05), signal)
      context.drawImage(video, 0, 0, FRAME_WIDTH, FRAME_HEIGHT)
      const { data } = context.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT)
      let changed = 0
      for (let pixel = 0; pixel < pixels; pixel += 1) {
        const offset = pixel * 4
        const luma = (data[offset] * 77 + data[offset + 1] * 150 + data[offset + 2] * 29) >> 8
        current[pixel] = luma
        if (index > 0 && Math.abs(luma - previous[pixel]) > PIXEL_CHANGE) changed += 1
      }
      scores[index] = changed / pixels
      ;[previous, current] = [current, previous]
      if (index % 5 === 0) onProgress(index / count)
    }

    // The first frame of a file has nothing to compare against, so borrow its neighbour's score.
    scores[0] = scores[1]
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

export function smoothActivity(track: ActivityTrack) {
  const { interval, scores } = track
  const radius = Math.max(1, Math.round(SMOOTHING / interval / 2))
  const prefix = new Float64Array(scores.length + 1)
  for (let index = 0; index < scores.length; index += 1) prefix[index + 1] = prefix[index] + scores[index]
  const smoothed = new Float32Array(scores.length)
  for (let index = 0; index < scores.length; index += 1) {
    const from = Math.max(0, index - radius)
    const to = Math.min(scores.length, index + radius + 1)
    smoothed[index] = (prefix[to] - prefix[from]) / (to - from)
  }
  return smoothed
}

function quantile(sorted: Float32Array, q: number) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]
}

export function findPlays(track: ActivityTrack, smoothed: Float32Array, settings: CutSettings) {
  const sorted = Float32Array.from(smoothed).sort()
  const low = quantile(sorted, 0.1)
  const high = quantile(sorted, 0.9)
  // Strictness 0 keeps almost anything that moves; 1 keeps only the busiest stretches.
  const threshold = low + (high - low) * (0.1 + 0.8 * settings.strictness)
  const { interval, duration } = track

  const bursts: Range[] = []
  let runStart = -1
  for (let index = 0; index <= smoothed.length; index += 1) {
    const active = index < smoothed.length && smoothed[index] >= threshold
    if (active && runStart < 0) runStart = index
    if (!active && runStart >= 0) {
      bursts.push({ start: runStart * interval, end: index * interval })
      runStart = -1
    }
  }

  const bridged: Range[] = []
  for (const burst of bursts) {
    const last = bridged[bridged.length - 1]
    if (last && burst.start - last.end < MIN_GAP) last.end = burst.end
    else bridged.push({ ...burst })
  }

  const plays: Range[] = []
  for (const burst of bridged) {
    if (burst.end - burst.start < MIN_PLAY) continue
    const start = Math.max(0, burst.start - settings.leadIn)
    const end = Math.min(duration, burst.end + TAIL)
    const last = plays[plays.length - 1]
    if (last && start <= last.end) last.end = Math.max(last.end, end)
    else plays.push({ start, end })
  }

  return { plays, threshold }
}

// Downsamples the activity curve for drawing, normalized so the busiest moments reach 1.
export function activityProfile(smoothed: Float32Array, threshold: number, buckets = 400) {
  const peak = quantile(Float32Array.from(smoothed).sort(), 0.98) || 1
  const count = Math.min(buckets, smoothed.length)
  const values: number[] = []
  for (let bucket = 0; bucket < count; bucket += 1) {
    const from = Math.floor((bucket * smoothed.length) / count)
    const to = Math.max(from + 1, Math.floor(((bucket + 1) * smoothed.length) / count))
    let max = 0
    for (let index = from; index < to; index += 1) max = Math.max(max, smoothed[index])
    values.push(Math.min(1, max / peak))
  }
  return { values, threshold: Math.min(1, threshold / peak) }
}
