export async function publishWithRollback(options) {
  await options.stage()
  await options.validate()
  await options.activate(options.targetVersion)
  try {
    await options.smoke(options.targetVersion)
  } catch (error) {
    if (options.previousVersion) await options.rollback(options.previousVersion)
    throw error
  }
  await options.cleanup()
}
