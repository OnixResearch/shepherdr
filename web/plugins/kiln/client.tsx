// onix: Kiln's CI (lib/addons.json "kiln"). On the web, Kiln is its own website: when onix.kiln.url is set (the
// service's /api/kiln, read by core/kiln.js), the sidebar's foot has Kiln, which opens that website in a new tab. The
// window's side panel (mods/kiln) shows Kiln's CI pages itself.
import { useEffect, useState } from 'react'
import { definePlugin } from '@client/kernel.ts'
import { FootButton } from '@client/ui.tsx'
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'

function KilnLink() {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    fetch('api/kiln')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setUrl(typeof d?.url === 'string' && d.url ? d.url : null))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  if (!url) return null
  return (
    <FootButton onClick={() => window.open(url, '_blank', 'noopener')} aria-label="Kiln, in a new tab">
      <ArrowTopRightOnSquareIcon className="size-4 shrink-0 text-fg3 coarse:text-fg2 phone:size-5 phone:text-fg2" />
      <span className="truncate">Kiln</span>
    </FootButton>
  )
}

export default definePlugin({
  name: 'kiln',
  setup(reg) {
    reg.sideFoot.push({ order: 40, View: KilnLink })
  },
})
