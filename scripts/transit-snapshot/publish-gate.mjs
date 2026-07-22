export class PublishGateError extends Error {
  constructor(code) {
    super('Snapshot publish gate failed')
    this.name = 'PublishGateError'
    this.code = code
  }
}

export async function publishWithRollback(options) {
  await options.stage()
  await options.validate()
  const activated = await options.activate(options.targetVersion, options.previousVersion)
  if (activated !== true) throw new PublishGateError('activation_conflict')

  try {
    await options.smoke(options.targetVersion)
  } catch {
    if (!options.previousVersion) throw new PublishGateError('restore_failed')
    let restored = false
    try {
      restored = await options.rollback(options.previousVersion, options.targetVersion) === true
    } catch {
      restored = false
    }
    if (!restored) throw new PublishGateError('restore_failed')
    throw new PublishGateError('smoke_failed_restored')
  }

  try {
    await options.finalize()
  } catch {
    throw new PublishGateError('state_write_failed_reconcile_required')
  }

  try {
    await options.cleanup()
  } catch {
    throw new PublishGateError('cleanup_failed')
  }
}
