import { useEffect, useState } from 'react'

export default function App() {
  const [version, setVersion] = useState('')
  useEffect(() => {
    window.picoaide.version().then(setVersion)
  }, [])
  return <div style={{ padding: 24, fontFamily: 'sans-serif' }}>PicoAide v{version}</div>
}
