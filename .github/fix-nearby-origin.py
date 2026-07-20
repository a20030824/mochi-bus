from pathlib import Path

path = Path('web/map/main.ts')
text = path.read_text()
old = 'unifiedStopMarker(origin, true, stopFillAccent).addTo(nearbyLayer)'
new = 'unifiedStopMarker([...origin], true, stopFillAccent).addTo(nearbyLayer)'
if old in text:
    if text.count(old) != 1:
        raise RuntimeError(f'expected one marker origin match, found {text.count(old)}')
    path.write_text(text.replace(old, new, 1))
elif text.count(new) != 1:
    raise RuntimeError('unexpected marker origin state')
