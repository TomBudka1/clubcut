// A game can arrive as several MP4s (camera chapter files, separate halves). The editor treats them as
// one continuous timeline: each file sits at an offset, and "game time" = file offset + time within the file.

export type Source = { id: string; file: File; url: string; duration: number; offset: number }
export type Piece = { index: number; start: number; end: number }

export function probeDuration(file: File) {
  return new Promise<number>((resolve, reject) => {
    const video = document.createElement('video')
    const url = URL.createObjectURL(file)
    const finish = () => {
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(url)
    }
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      const duration = video.duration
      finish()
      if (Number.isFinite(duration) && duration > 0) resolve(duration)
      else reject(new Error(`${file.name} has no readable length.`))
    }
    video.onerror = () => {
      finish()
      reject(new Error(`${file.name} can't be played in this browser.`))
    }
    video.src = url
  })
}

export function sortByName(files: File[]) {
  // Numeric sort keeps chapter files like GH010042, GH020042 and "Game part 2", "Game part 10" in order.
  return [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

export function withOffsets(sources: Omit<Source, 'offset'>[]): Source[] {
  let offset = 0
  return sources.map((source) => {
    const placed = { ...source, offset }
    offset += source.duration
    return placed
  })
}

export function locate(sources: Source[], time: number) {
  for (let index = sources.length - 1; index >= 0; index -= 1) {
    const source = sources[index]
    if (time >= source.offset) return { index, local: Math.min(time - source.offset, source.duration) }
  }
  return { index: 0, local: 0 }
}

// Splits a range of game time into pieces that each sit inside a single file.
export function splitRange(sources: Source[], start: number, end: number): Piece[] {
  const pieces: Piece[] = []
  sources.forEach((source, index) => {
    const from = Math.max(start, source.offset)
    const to = Math.min(end, source.offset + source.duration)
    if (to - from > 0.05) pieces.push({ index, start: from - source.offset, end: to - source.offset })
  })
  return pieces
}
