// "I solemnly swear that I am up to no good" opens the map, "Mischief managed" wipes it.
const TITLE_HIDE_AFTER_MS = 9_000

export function startIntro({ onOpen, onClose }: { onOpen: () => void; onClose: () => void }) {
  const cover = document.getElementById('cover')!
  const oath = document.getElementById('oath')!
  const title = document.getElementById('title')!
  const close = document.getElementById('mischief')!
  const list = document.getElementById('people')!
  let opened = false
  let timers: ReturnType<typeof setTimeout>[] = []

  // the ink starts spreading on the click itself, no waiting
  const open = () => {
    if (opened) return
    opened = true
    timers.forEach(clearTimeout)
    timers = []
    oath.textContent = ''
    cover.classList.add('hidden')
    title.classList.add('shown')
    close.classList.add('shown')
    list.classList.add('shown')
    onOpen()
    timers.push(setTimeout(() => title.classList.remove('shown'), TITLE_HIDE_AFTER_MS))
  }

  cover.addEventListener('click', open)
  close.addEventListener('click', () => {
    opened = false
    timers.forEach(clearTimeout)
    timers = []
    oath.textContent = 'Mischief managed.'
    title.classList.remove('shown')
    close.classList.remove('shown')
    list.classList.remove('shown')
    cover.classList.remove('hidden')
    onClose()
    timers.push(setTimeout(() => (oath.textContent = ''), 2_500))
  })

  return { open }
}
