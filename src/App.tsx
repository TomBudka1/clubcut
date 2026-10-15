import { useMemo, useRef, useState, type MouseEvent } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, Clapperboard, Clock3, Download, Film, Flag, FolderOpen, LoaderCircle, Pause, Play, Plus, ScanLine, Scissors, SkipForward, Sparkles, Trash2, Upload, Volume2, X } from 'lucide-react'
import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import { activityProfile, analyzeActivity, findPlays, smoothActivity, type ActivityTrack, type Range } from './deadTime'
import { locate, probeDuration, sortByName, splitRange, withOffsets, type Piece, type Source } from './footage'

type PlayTag = 'Live' | 'Scoring' | 'Defense' | 'Transition' | 'Skill'
type Clip = { id: string; title: string; start: number; end: number; tag: PlayTag }

const tags: PlayTag[] = ['Live', 'Scoring', 'Defense', 'Transition', 'Skill']
const tagClass: Record<PlayTag, string> = { Live: 'live', Scoring: 'scoring', Defense: 'defense', Transition: 'transition', Skill: 'skill' }
const OUTPUT_NAME = 'clubcut_output.mp4'

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function formatTime(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const remaining = safeSeconds % 60
  return hours ? `${hours}:${pad(minutes)}:${pad(remaining)}` : `${pad(minutes)}:${pad(remaining)}`
}

function formatPreciseTime(seconds: number) {
  return `${formatTime(seconds)}.${String(Math.floor((seconds % 1) * 10))}`
}

function formatEta(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'estimating…'
  return seconds < 60 ? `about ${Math.ceil(seconds)}s left` : `about ${Math.ceil(seconds / 60)} min left`
}

function isMp4(file: File) {
  return file.name.toLowerCase().endsWith('.mp4') || file.type === 'video/mp4'
}

// Mounting reads the files lazily, so multi-gigabyte games never have to be copied into FFmpeg's memory.
async function mountSources(ffmpeg: FFmpeg, sources: Source[]) {
  const names = sources.map((_, index) => `source${index}.mp4`)
  try {
    await ffmpeg.createDir('/input')
    await ffmpeg.mount(FFFSType.WORKERFS, { files: sources.map((source, index) => new File([source.file], names[index], { type: 'video/mp4' })) }, '/input')
    return names.map((name) => `/input/${name}`)
  } catch {
    for (let index = 0; index < sources.length; index += 1) await ffmpeg.writeFile(names[index], await fetchFile(sources[index].file))
    return names
  }
}

export default function App() {
  const fileInput = useRef<HTMLInputElement>(null)
  const appendInput = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const analysisAbort = useRef<AbortController | null>(null)
  // Where to jump once the next file's video element has loaded.
  const pendingSeek = useRef<{ local: number; play: boolean } | null>(null)
  const [sources, setSources] = useState<Source[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [isLoadingFootage, setIsLoadingFootage] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [clips, setClips] = useState<Clip[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [isPlaying, setIsPlaying] = useState(false)
  const [skipDeadTime, setSkipDeadTime] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [preciseExport, setPreciseExport] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)
  const [exportMessage, setExportMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [track, setTrack] = useState<ActivityTrack | null>(null)
  const [analysisProgress, setAnalysisProgress] = useState<number | null>(null)
  const [analysisEta, setAnalysisEta] = useState('')
  const [strictness, setStrictness] = useState(0.45)
  const [leadIn, setLeadIn] = useState(2)

  const active = sources[activeIndex] ?? null
  const duration = sources.reduce((total, source) => total + source.duration, 0)
  const selectedClip = clips.find((clip) => clip.id === selectedId) ?? null
  const totalSelected = clips.reduce((total, clip) => total + Math.max(0, clip.end - clip.start), 0)
  const canExport = sources.length > 0 && (clips.length > 0 || sources.length > 1)

  const smoothed = useMemo(() => track ? smoothActivity(track) : null, [track])
  const detection = useMemo(() => track && smoothed ? findPlays(track, smoothed, { strictness, leadIn }) : null, [track, smoothed, strictness, leadIn])
  const profile = useMemo(() => smoothed && detection ? activityProfile(smoothed, detection.threshold) : null, [smoothed, detection])
  const detectedTotal = detection?.plays.reduce((total, play) => total + play.end - play.start, 0) ?? 0

  // Plays are stored in game time, so they stay valid when files are appended but not when files move.
  function setFootage(next: Source[], keepPlays: boolean) {
    analysisAbort.current?.abort()
    pendingSeek.current = null
    setSources(next)
    setTrack(null)
    setErrorMessage('')
    setExportMessage('')
    if (!keepPlays) {
      setActiveIndex(0)
      setCurrentTime(0)
      setIsPlaying(false)
      setClips([])
      setSelectedId('')
      setSkipDeadTime(false)
    }
  }

  async function addFootage(list: FileList | File[] | null | undefined, append: boolean) {
    const chosen = Array.from(list ?? [])
    if (fileInput.current) fileInput.current.value = ''
    if (appendInput.current) appendInput.current.value = ''
    if (!chosen.length) return
    const videos = sortByName(chosen.filter(isMp4))
    if (videos.length < chosen.length) {
      setErrorMessage(videos.length ? 'Skipped files that are not MP4s.' : 'Choose MP4 video files.')
      if (!videos.length) return
    }
    setIsLoadingFootage(true)
    try {
      const added = await Promise.all(videos.map(async (file) => ({ id: crypto.randomUUID(), file, duration: await probeDuration(file), url: URL.createObjectURL(file) })))
      if (!append) sources.forEach((source) => URL.revokeObjectURL(source.url))
      setFootage(withOffsets([...(append ? sources : []), ...added]), append)
      if (append && clips.length) setExportMessage(`Added ${added.length} ${added.length === 1 ? 'file' : 'files'} to the end. Run auto-cut again to find plays in the new footage.`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not read that footage.')
    } finally {
      setIsLoadingFootage(false)
    }
  }

  function moveSource(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= sources.length) return
    const reordered = [...sources]
    ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
    setFootage(withOffsets(reordered), false)
    if (clips.length) setExportMessage('Footage order changed, so plays were cleared. Run auto-cut again.')
  }

  function removeSource(index: number) {
    URL.revokeObjectURL(sources[index].url)
    setFootage(withOffsets(sources.filter((_, position) => position !== index)), false)
  }

  function seek(time: number, play = isPlaying) {
    if (!sources.length) return
    const clamped = Math.max(0, Math.min(duration, time))
    const { index, local } = locate(sources, clamped)
    setCurrentTime(clamped)
    if (index === activeIndex && videoRef.current) {
      videoRef.current.currentTime = local
      return
    }
    pendingSeek.current = { local, play }
    setActiveIndex(index)
  }

  function handleLoaded(video: HTMLVideoElement) {
    const pending = pendingSeek.current
    pendingSeek.current = null
    if (!pending) return
    video.currentTime = pending.local
    if (pending.play) void video.play()
  }

  function handleEnded() {
    if (activeIndex < sources.length - 1) {
      pendingSeek.current = { local: 0, play: true }
      setActiveIndex(activeIndex + 1)
    } else {
      setIsPlaying(false)
    }
  }

  function handleTimeUpdate(video: HTMLVideoElement) {
    if (!active) return
    const time = active.offset + video.currentTime
    setCurrentTime(time)
    if (!skipDeadTime || video.paused || clips.length === 0) return
    const ordered = [...clips].sort((a, b) => a.start - b.start)
    if (ordered.some((clip) => time >= clip.start && time < clip.end)) return
    const next = ordered.find((clip) => clip.start > time)
    if (next) seek(next.start, true)
    else video.pause()
  }

  function applyPlays(plays: Range[]) {
    setClips(plays.map((play, index) => ({ id: crypto.randomUUID(), title: `Play ${pad(index + 1)}`, start: play.start, end: play.end, tag: 'Live' })))
    setSelectedId('')
    setSkipDeadTime(true)
    const kept = plays.reduce((total, play) => total + play.end - play.start, 0)
    setExportMessage(`${plays.length} plays kept · ${formatTime(duration - kept)} of dead time cut. Press play to watch the cut version.`)
  }

  async function analyzeFootage() {
    if (!sources.length || analysisProgress !== null) return
    const controller = new AbortController()
    analysisAbort.current = controller
    const startedAt = performance.now()
    setAnalysisProgress(0)
    setAnalysisEta('')
    setErrorMessage('')
    setExportMessage('')
    try {
      const result = await analyzeActivity(sources, (fraction) => {
        setAnalysisProgress(fraction)
        const elapsed = (performance.now() - startedAt) / 1000
        setAnalysisEta(fraction > 0.02 ? formatEta((elapsed / fraction) * (1 - fraction)) : 'estimating…')
      }, controller.signal)
      if (controller.signal.aborted) return
      setTrack(result)
      applyPlays(findPlays(result, smoothActivity(result), { strictness, leadIn }).plays)
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setErrorMessage(error instanceof Error ? error.message : 'Could not scan this video.')
      }
    } finally {
      if (analysisAbort.current === controller) analysisAbort.current = null
      setAnalysisProgress(null)
    }
  }

  function seekFromStrip(event: MouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    seek(((event.clientX - bounds.left) / bounds.width) * duration)
  }

  function addClip() {
    if (!duration) return
    const start = Math.min(currentTime, Math.max(0, duration - 1))
    const end = Math.min(duration, start + Math.min(10, duration - start))
    const nextClip: Clip = {
      id: crypto.randomUUID(),
      title: `Play ${pad(clips.length + 1)}`,
      start,
      end,
      tag: 'Scoring',
    }
    setClips((current) => [...current, nextClip])
    setSelectedId(nextClip.id)
  }

  function updateClip(id: string, updates: Partial<Omit<Clip, 'id'>>) {
    setClips((current) => current.map((clip) => clip.id === id ? { ...clip, ...updates } : clip))
  }

  function setClipBoundary(boundary: 'start' | 'end') {
    if (!selectedClip) return
    const value = Math.max(0, Math.min(duration, currentTime))
    if (boundary === 'start') {
      updateClip(selectedClip.id, { start: Math.min(value, selectedClip.end - 0.25) })
    } else {
      updateClip(selectedClip.id, { end: Math.max(value, selectedClip.start + 0.25) })
    }
  }

  function moveClip(id: string, direction: -1 | 1) {
    setClips((current) => {
      const index = current.findIndex((clip) => clip.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= current.length) return current
      const reordered = [...current]
      ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
      return reordered
    })
  }

  async function exportCompilation() {
    if (!canExport || isExporting) return
    setIsExporting(true)
    setExportProgress(0)
    setExportMessage('Preparing editor…')
    setErrorMessage('')
    const ffmpeg = new FFmpeg()
    // With no plays marked, export joins every file end to end.
    const joinOnly = clips.length === 0
    const pieces: Piece[] = joinOnly
      ? sources.map((source, index) => ({ index, start: 0, end: source.duration }))
      : clips.flatMap((clip) => splitRange(sources, clip.start, clip.end))

    try {
      const base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd'
      await ffmpeg.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
      })
      ffmpeg.on('progress', ({ progress }) => setExportProgress(Math.max(0, Math.min(99, Math.round(progress * 100)))))
      setExportMessage('Reading game film…')
      const paths = await mountSources(ffmpeg, sources)

      if (preciseExport) {
        const pieceFiles: string[] = []
        for (let index = 0; index < pieces.length; index += 1) {
          const piece = pieces[index]
          const outputName = `piece_${String(index).padStart(3, '0')}.mp4`
          pieceFiles.push(outputName)
          setExportMessage(`Encoding part ${index + 1} of ${pieces.length}…`)
          const result = await ffmpeg.exec([
            '-ss', piece.start.toFixed(3), '-i', paths[piece.index], '-t', (piece.end - piece.start).toFixed(3),
            '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart', outputName,
          ])
          if (result !== 0) throw new Error(`Could not encode part ${index + 1} from ${sources[piece.index].file.name}.`)
        }

        const concatList = pieceFiles.map((name) => `file '${name}'`).join('\n')
        await ffmpeg.writeFile('pieces.txt', new TextEncoder().encode(concatList))
        setExportMessage('Joining everything into one video…')
        const result = await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', 'pieces.txt', '-c', 'copy', '-movflags', '+faststart', OUTPUT_NAME])
        if (result !== 0) throw new Error('The parts could not be joined into one video.')
      } else {
        // Stream copy: no re-encoding, so a full game exports in about the time it takes to read the files.
        // Cuts land on the nearest keyframe (usually within a second or two), which the lead-in absorbs.
        const concatList = ['ffconcat version 1.0', ...pieces.flatMap((piece) => joinOnly
          ? [`file '${paths[piece.index]}'`]
          : [`file '${paths[piece.index]}'`, `inpoint ${piece.start.toFixed(3)}`, `outpoint ${piece.end.toFixed(3)}`])].join('\n')
        await ffmpeg.writeFile('pieces.txt', new TextEncoder().encode(concatList))
        setExportMessage(joinOnly ? `Joining ${sources.length} files…` : `Joining ${clips.length} ${clips.length === 1 ? 'play' : 'plays'}…`)
        const result = await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', 'pieces.txt', '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', OUTPUT_NAME])
        if (result !== 0) {
          throw new Error(sources.length > 1
            ? 'Fast export failed. If these files came from different cameras or settings, turn on "Frame-accurate" and export again.'
            : 'Fast export failed for this file. Turn on "Frame-accurate" and export again.')
        }
      }

      const output = await ffmpeg.readFile(OUTPUT_NAME)
      const blob = new Blob([output as Uint8Array<ArrayBuffer>], { type: 'video/mp4' })
      const downloadUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = downloadUrl
      link.download = `${sources[0].file.name.replace(/\.mp4$/i, '')}_${joinOnly ? 'full' : 'cut'}.mp4`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 60_000)
      setExportProgress(100)
      setExportMessage('Video downloaded')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Export failed. Try smaller files or fewer plays.')
      setExportMessage('Export stopped')
    } finally {
      await ffmpeg.terminate()
      setIsExporting(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#home" aria-label="ClubCut home">
          <span className="brand-mark"><Clapperboard size={19} strokeWidth={2.3} /></span>
          <span>clubcut<span className="brand-period">.</span></span>
        </a>
        <div className="project-label"><span className="live-dot" /> GAME DAY EDIT <span className="top-divider">/</span> <span className="muted">New project</span></div>
        <div className="top-actions">
          {sources.length > 0 && <span className="save-state"><Check size={13} /> Processed locally</span>}
          <label className="export-mode" title="Re-encodes every play so cuts land on the exact frame. Much slower for full games.">
            <input type="checkbox" checked={preciseExport} onChange={(event) => setPreciseExport(event.target.checked)} disabled={isExporting} />
            Frame-accurate
          </label>
          <button className="export-button" onClick={exportCompilation} disabled={!canExport || isExporting} title={clips.length ? 'Export your plays as one video' : 'Join all files into one video'}>
            {isExporting ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}
            {isExporting ? `Export ${exportProgress}%` : clips.length || sources.length < 2 ? 'Export video' : 'Export joined'}
          </button>
        </div>
      </header>

      <div className="editor-layout">
        <aside className="rail">
          <button className="rail-button active" title="Editor"><Scissors size={18} /></button>
          <button className="rail-button" title="Media"><Film size={18} /></button>
          <div className="rail-bottom"><span className="avatar">CC</span></div>
        </aside>

        <main className="main-panel">
          <div className="page-heading">
            <div>
              <div className="eyebrow"><span>01</span> / GAME FILM</div>
              <h1>Cut the dead time. <em>Keep the game.</em></h1>
            </div>
            <button className="source-button" onClick={() => fileInput.current?.click()} disabled={isLoadingFootage}>
              {isLoadingFootage ? <LoaderCircle size={16} className="spin" /> : <FolderOpen size={16} />} {sources.length ? 'Replace footage' : 'Add game footage'}
            </button>
            <input ref={fileInput} className="visually-hidden" type="file" accept="video/mp4,.mp4" multiple onChange={(event) => addFootage(event.target.files, false)} />
            <input ref={appendInput} className="visually-hidden" type="file" accept="video/mp4,.mp4" multiple onChange={(event) => addFootage(event.target.files, true)} />
          </div>

          {(errorMessage || exportMessage) && (
            <div className={`notice ${errorMessage ? 'notice-error' : ''}`}>
              <span>{errorMessage || exportMessage}</span>
              {isExporting && <div className="progress-track"><span style={{ width: `${exportProgress}%` }} /></div>}
              {!isExporting && errorMessage && <button onClick={() => setErrorMessage('')} aria-label="Dismiss error"><X size={15} /></button>}
            </div>
          )}

          {sources.length > 0 && (
            <section className="footage-bar" aria-label="Game footage files">
              <span className="section-kicker">FOOTAGE</span>
              <ol className="footage-list">
                {sources.map((source, index) => (
                  <li key={source.id} className={`footage-chip ${index === activeIndex ? 'footage-chip-active' : ''}`}>
                    <button className="footage-name" onClick={() => seek(source.offset)} title={`${source.file.name} · starts at ${formatTime(source.offset)}`}>
                      <span className="footage-index">{index + 1}</span>
                      <span className="footage-file">{source.file.name}</span>
                      <span className="footage-length">{formatTime(source.duration)}</span>
                    </button>
                    {sources.length > 1 && (
                      <>
                        <button className="footage-action" onClick={() => moveSource(index, -1)} disabled={index === 0} aria-label={`Move ${source.file.name} earlier`}><ArrowLeft size={12} /></button>
                        <button className="footage-action" onClick={() => moveSource(index, 1)} disabled={index === sources.length - 1} aria-label={`Move ${source.file.name} later`}><ArrowRight size={12} /></button>
                      </>
                    )}
                    <button className="footage-action footage-remove" onClick={() => removeSource(index)} aria-label={`Remove ${source.file.name}`}><X size={12} /></button>
                  </li>
                ))}
              </ol>
              <button className="footage-add" onClick={() => appendInput.current?.click()} disabled={isLoadingFootage}><Plus size={13} /> Add file</button>
            </section>
          )}

          {sources.length > 0 && (
            <section className="autocut" aria-label="Automatic dead-time removal">
              <div className="autocut-copy">
                <span className="section-kicker">AUTO-CUT</span>
                <h2>Remove dead time</h2>
                <p>{track ? 'Lime areas are kept. Drag the sliders until only live play is lime, then apply.' : `Scans ${sources.length > 1 ? `all ${sources.length} files` : 'the whole game'} for movement and keeps the stretches where play is live. Runs on this device.`}</p>
              </div>
              {analysisProgress !== null ? (
                <div className="autocut-scan">
                  <div className="autocut-scan-label"><span>Scanning footage · {Math.round(analysisProgress * 100)}%</span><span className="muted">{analysisEta}</span></div>
                  <div className="progress-track"><span style={{ width: `${analysisProgress * 100}%` }} /></div>
                  <button className="text-button" onClick={() => analysisAbort.current?.abort()}>Cancel</button>
                </div>
              ) : !track || !detection || !profile ? (
                <button className="analyze-button" onClick={analyzeFootage} disabled={!duration}><ScanLine size={15} /> Find live play</button>
              ) : (
                <div className="autocut-controls">
                  <div className="autocut-strip" onClick={seekFromStrip} title="Click to jump to this moment">
                    <svg viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true">
                      {detection.plays.map((play, index) => <rect key={index} className="strip-kept" x={(play.start / track.duration) * 1000} width={((play.end - play.start) / track.duration) * 1000} y="0" height="40" />)}
                      <path className="strip-activity" d={`M0 40 ${profile.values.map((value, index) => `L${(index / Math.max(1, profile.values.length - 1)) * 1000} ${40 - value * 36}`).join(' ')} L1000 40 Z`} />
                      <line className="strip-threshold" x1="0" x2="1000" y1={40 - profile.threshold * 36} y2={40 - profile.threshold * 36} />
                    </svg>
                    <span className="strip-playhead" style={{ left: `${duration ? (currentTime / duration) * 100 : 0}%` }} />
                  </div>
                  <div className="autocut-settings">
                    <label className="range-field">
                      <span className="field-label">STRICTNESS <b>{Math.round(strictness * 100)}%</b></span>
                      <input type="range" min="0" max="1" step="0.01" value={strictness} onChange={(event) => setStrictness(Number(event.target.value))} />
                      <span className="range-ends"><span>Keep more</span><span>Cut more</span></span>
                    </label>
                    <label className="range-field">
                      <span className="field-label">LEAD-IN <b>{leadIn}s</b></span>
                      <input type="range" min="0" max="8" step="0.5" value={leadIn} onChange={(event) => setLeadIn(Number(event.target.value))} />
                      <span className="range-ends"><span>Tight</span><span>See the setup</span></span>
                    </label>
                    <div className="autocut-stats">
                      <strong>{formatTime(detectedTotal)}</strong>
                      <span>of {formatTime(track.duration)} · {detection.plays.length} plays</span>
                    </div>
                    <button className="analyze-button" onClick={() => applyPlays(detection.plays)}><Scissors size={14} /> Apply cuts</button>
                  </div>
                </div>
              )}
            </section>
          )}

          <section className="workbench" aria-label="Video editor">
            <div className="preview-column">
              <div className="preview-heading">
                <div><span className="section-kicker">SOURCE MONITOR</span><span className="source-name">{active ? `${active.file.name}${sources.length > 1 ? ` · file ${activeIndex + 1} of ${sources.length}` : ''}` : 'No game footage loaded'}</span></div>
                {active && <span className="format-pill">{sources.length > 1 ? `${sources.length} FILES` : 'MP4'} <span>·</span> {formatTime(duration)}</span>}
              </div>
              <div className={`video-stage ${!active ? 'is-empty' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFootage(event.dataTransfer.files, sources.length > 0) }}>
                {active ? (
                  <video
                    key={active.id}
                    ref={videoRef}
                    src={active.url}
                    onLoadedMetadata={(event) => handleLoaded(event.currentTarget)}
                    onTimeUpdate={(event) => handleTimeUpdate(event.currentTarget)}
                    onPlay={() => setIsPlaying(true)}
                    onPause={(event) => { if (!event.currentTarget.ended) setIsPlaying(false) }}
                    onEnded={handleEnded}
                    playsInline
                  />
                ) : (
                  <button className="empty-upload" onClick={() => fileInput.current?.click()} disabled={isLoadingFootage}>
                    <span className="upload-icon">{isLoadingFootage ? <LoaderCircle size={21} className="spin" /> : <Upload size={21} />}</span>
                    <strong>{isLoadingFootage ? 'Reading footage…' : 'Drop in the full game'}</strong>
                    <span>One MP4 or several · they play back to back · processed on this device</span>
                    <span className="browse-link">Browse files <ChevronDown size={13} className="browse-arrow" /></span>
                  </button>
                )}
                {active && <span className="timecode">{formatPreciseTime(currentTime)} <i>/</i> {formatTime(duration)}</span>}
              </div>
              <div className="transport">
                <button className="transport-play" onClick={() => videoRef.current?.paused ? videoRef.current.play() : videoRef.current?.pause()} disabled={!active} aria-label={isPlaying ? 'Pause video' : 'Play video'}>
                  {isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
                </button>
                <span className="transport-time">{formatPreciseTime(currentTime)}</span>
                <input className="scrubber" aria-label="Scrub video" type="range" min="0" max={duration || 1} step="0.1" value={Math.min(currentTime, duration || 0)} disabled={!active} onChange={(event) => seek(Number(event.target.value))} />
                <span className="transport-time muted">{formatTime(duration)}</span>
                <button className={`skip-toggle ${skipDeadTime ? 'skip-toggle-on' : ''}`} onClick={() => setSkipDeadTime((value) => !value)} disabled={clips.length === 0} aria-pressed={skipDeadTime} title="Skip everything outside your plays while watching">
                  <SkipForward size={13} /> Skip dead time
                </button>
                <Volume2 size={16} className="volume-icon" />
              </div>
              <div className="play-markers" aria-label="Marked plays on video timeline">
                {clips.map((clip) => <button key={clip.id} title={`${clip.title} · ${formatTime(clip.start)}`} style={{ left: `${duration ? (clip.start / duration) * 100 : 0}%` }} className={`marker ${selectedId === clip.id ? 'marker-active' : ''}`} onClick={() => { setSelectedId(clip.id); seek(clip.start) }} />)}
              </div>
              <div className="source-footer">
                <span><Clock3 size={14} /> {sources.length ? `${formatTime(duration)} total${sources.length > 1 ? ` across ${sources.length} files` : ''}` : 'Full-length source video'}</span>
                <span><Sparkles size={14} /> Local editing</span>
              </div>
            </div>

            <aside className="clip-sidebar">
              <div className="sidebar-heading">
                <div><span className="section-kicker">PLAYBOOK</span><h2>Your plays <span className="count-badge">{clips.length}</span></h2></div>
                <button className="icon-button add-button" onClick={addClip} disabled={!active} title="Mark play at current time"><Plus size={17} /></button>
              </div>
              <p className="sidebar-help">Auto-cut fills this list. Trim, rename, or remove any play.</p>
              <div className="clip-list">
                {clips.length === 0 ? (
                  <div className="empty-clips"><Flag size={18} /><span>No plays yet</span><small>Run auto-cut, or mark a moment by hand.</small></div>
                ) : clips.map((clip, index) => (
                  <button key={clip.id} className={`clip-row ${selectedId === clip.id ? 'clip-selected' : ''}`} onClick={() => { setSelectedId(clip.id); seek(clip.start) }}>
                    <span className="clip-index">{pad(index + 1)}</span>
                    <span className="clip-info"><strong>{clip.title}</strong><span className="clip-meta"><i className={`tag-dot ${tagClass[clip.tag]}`} />{clip.tag}<i className="meta-separator">·</i>{formatTime(clip.start)}–{formatTime(clip.end)}</span></span>
                    <span className="clip-length">{formatTime(clip.end - clip.start)}</span>
                  </button>
                ))}
              </div>
              {selectedClip && (
                <div className="clip-inspector">
                  <div className="inspector-title"><span className="section-kicker">SELECTED PLAY</span><button className="icon-button delete-button" onClick={() => { setClips((current) => current.filter((clip) => clip.id !== selectedClip.id)); setSelectedId('') }} title="Remove play"><Trash2 size={15} /></button></div>
                  <input className="title-input" aria-label="Play name" value={selectedClip.title} onChange={(event) => updateClip(selectedClip.id, { title: event.target.value })} />
                  <label className="field-label">PLAY TYPE</label>
                  <div className="tag-options">{tags.map((tag) => <button key={tag} className={`tag-option ${selectedClip.tag === tag ? 'tag-option-active' : ''} ${tagClass[tag]}`} onClick={() => updateClip(selectedClip.id, { tag })}>{tag}</button>)}</div>
                  <div className="trim-heading"><span className="field-label">TRIM POINTS</span><span className="trim-hint">Adjust at playhead</span></div>
                  <div className="trim-controls">
                    <button onClick={() => setClipBoundary('start')} title="Set clip start at playhead"><span>IN</span><strong>{formatTime(selectedClip.start)}</strong></button>
                    <button onClick={() => setClipBoundary('end')} title="Set clip end at playhead"><span>OUT</span><strong>{formatTime(selectedClip.end)}</strong></button>
                  </div>
                  <div className="reorder-controls">
                    <button onClick={() => moveClip(selectedClip.id, -1)} disabled={clips[0]?.id === selectedClip.id}><ArrowUp size={13} /> Move earlier</button>
                    <button onClick={() => moveClip(selectedClip.id, 1)} disabled={clips[clips.length - 1]?.id === selectedClip.id}><ArrowDown size={13} /> Move later</button>
                  </div>
                </div>
              )}
              <div className="sidebar-bottom">
                <div className="reel-total"><span>CUT LENGTH</span><strong>{formatTime(totalSelected)}</strong></div>
                <button className="add-play-button" onClick={addClip} disabled={!active}><Plus size={15} /> Mark a play <span>at playhead</span></button>
              </div>
            </aside>
          </section>

          <section className="timeline-section">
            <div className="timeline-heading"><div><span className="section-kicker">EDIT TIMELINE</span><h2>Game sequence</h2></div><span className="timeline-note">{clips.length} {clips.length === 1 ? 'play' : 'plays'} <i>·</i> {formatTime(totalSelected)} total</span></div>
            <div className={`timeline-ruler ${!sources.length ? 'timeline-disabled' : ''}`}>
              <div className="ruler-labels"><span>00:00</span><span>{formatTime(duration / 2)}</span><span>{formatTime(duration)}</span></div>
              <div className="ruler-track">
                <div className="source-track" />
                {sources.slice(1).map((source) => <span key={source.id} className="file-boundary" style={{ left: `${(source.offset / duration) * 100}%` }} title={`${source.file.name} starts`} />)}
                {clips.map((clip, index) => <button key={clip.id} className={`timeline-clip ${tagClass[clip.tag]} ${selectedId === clip.id ? 'timeline-clip-active' : ''}`} style={{ left: `${duration ? (clip.start / duration) * 100 : 0}%`, width: `${duration ? Math.max((clip.end - clip.start) / duration * 100, 0.4) : 0}%` }} onClick={() => { setSelectedId(clip.id); seek(clip.start) }} title={`${index + 1}. ${clip.title}`}><span>{clip.title}</span></button>)}
                {active && <span className="playhead" style={{ left: `${duration ? (currentTime / duration) * 100 : 0}%` }} />}
              </div>
              <div className="timeline-foot"><span><i className="legend-source" /> Full game</span><span><i className="legend-selected" /> Kept plays</span>{sources.length > 1 && <span><i className="legend-boundary" /> File break</span>}<span className="timeline-foot-spacer" /><span>{sources.length ? sources.map((source) => source.file.name).join(' + ') : 'Import a video to get started'}</span></div>
            </div>
          </section>

          <footer className="workspace-footer"><span>BUILT FOR THE BENCH, THE BUS, AND WHAT'S NEXT.</span><span>CLUBCUT <b>·</b> 01</span></footer>
        </main>
      </div>
    </div>
  )
}
