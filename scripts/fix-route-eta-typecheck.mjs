import fs from 'node:fs'

const path = 'src/domain/route-eta-status.ts'
let source = fs.readFileSync(path, 'utf8')
source = source.replace(
  'const TDX_STOP_STATUS = {',
  'const TDX_STOP_STATUS: Record<number, RouteEtaStatus> = {',
)
source = source.replace(
  '} as const satisfies Record<number, RouteEtaStatus>',
  '}',
)
fs.writeFileSync(path, source)
