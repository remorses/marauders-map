#!/usr/bin/env node
// marauders-map CLI: log in to iCloud, then serve the map on localhost with live Find My data.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as clack from '@clack/prompts'
import { colors, goke, openInBrowser } from 'goke'
import { z } from 'zod'
import { createFindMy, deleteSession, loadSession, login, type TwoFactorPrompt } from './icloud.ts'
import { ingestDevices, startServer } from './server.ts'

const DIST_DIR = fileURLToPath(new URL('../dist', import.meta.url))
const DEFAULT_PORT = 5317
const MIN_POLL_S = 15

const cli = goke('marauders-map')



function requireTerminal(command: string) {
  if (process.stdin.isTTY) return
  console.error(`${command} needs an interactive terminal for the password and the 2FA code.`)
  process.exit(1)
}

// Asks for the code Apple pushes to trusted devices; typing `sms` sends a text instead.
const askTwoFactorCode: TwoFactorPrompt = (() => {
  let smsPhoneId: number | undefined
  return async ({ phoneNumbers }) => {
    const hint = smsPhoneId === undefined && phoneNumbers.length ? ' Type `sms` to get a text message instead.' : ''
    const code = await clack.text({
      message: smsPhoneId === undefined ? `Enter the 6 digit code shown on your Apple device.${hint}` : 'Enter the 6 digit code from the text message.',
      validate: (value) => (/^\d{6}$/.test(value?.trim() ?? '') || value?.trim() === 'sms' ? undefined : 'Six digits, or `sms`'),
    })
    if (clack.isCancel(code)) return undefined
    if (code.trim() !== 'sms') return { kind: 'code', code: code.trim(), phoneId: smsPhoneId }
    const phone =
      phoneNumbers.length === 1
        ? phoneNumbers[0].id
        : await clack.select({ message: 'Send the code to', options: phoneNumbers.map((p) => ({ value: p.id, label: p.number })) })
    if (clack.isCancel(phone)) return undefined
    smsPhoneId = phone
    return { kind: 'sms', phoneId: phone }
  }
})()

cli
  .command('login', 'Log in to iCloud so the map can show your devices and your family devices')
  .option('--apple-id [appleId]', z.string().optional().describe('Apple ID email'))
  .example('marauders-map login --apple-id you@icloud.com')
  .action(async (options) => {
    requireTerminal('`marauders-map login`')
    clack.intro('I solemnly swear that I am up to no good')
    const saved = await loadSession()
    const appleId = options.appleId ?? (await clack.text({ message: 'Apple ID', initialValue: saved?.appleId ?? '' }))
    if (clack.isCancel(appleId)) process.exit(0)
    // ICLOUD_PASSWORD lets a secrets manager inject it, e.g. `sigillo run -- marauders-map login`
    const password = process.env.ICLOUD_PASSWORD ?? (await clack.password({ message: 'Password' }))
    if (clack.isCancel(password)) process.exit(0)
    const spinner = clack.spinner()
    spinner.start('Signing in to iCloud')
    const controller = new AbortController()
    const session = await login({
      appleId: appleId.trim(),
      password,
      askCode: async (input) => {
        spinner.stop('Apple wants a two factor code')
        const answer = await askTwoFactorCode(input)
        spinner.start('Checking the code')
        return answer
      },
      signal: controller.signal,
    })
    if (session instanceof Error) {
      spinner.stop(colors.red(session.message))
      process.exit(1)
    }
    spinner.stop('Signed in')
    const devices = await createFindMy({ session }).devices({ signal: controller.signal })
    if (devices instanceof Error) {
      clack.outro(colors.yellow(`Logged in, but Find My failed: ${devices.message}`))
      process.exit(1)
    }
    clack.outro(`Mischief managed. Find My shows ${devices.length} devices with a location. Run \`marauders-map\` to open the map.`)
  })

cli.command('logout', 'Forget the saved iCloud session').action(async () => {
  await deleteSession()
  console.log('Logged out of iCloud.')
})

cli
  .command('devices', 'Print the devices Find My knows about, with their last location')
  .option('--json', 'Print JSON')
  .action(async (options) => {
    const session = await loadSession()
    if (!session) {
      console.error('Not logged in. Run `marauders-map login` first.')
      process.exit(1)
    }
    const devices = await createFindMy({ session }).devices({ signal: AbortSignal.timeout(60_000) })
    if (devices instanceof Error) {
      console.error(devices.message)
      process.exit(1)
    }
    if (options.json) return console.log(JSON.stringify(devices, null, 2))
    for (const d of devices) {
      const ago = Math.round((Date.now() - d.timestamp) / 60_000)
      console.log(`${d.name.padEnd(28)} ${d.model.padEnd(18)} ${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}  ${ago} min ago`)
    }
  })

cli
  .command('', 'Serve the map on localhost with live Find My locations')
  .option('--port [port]', z.number().default(DEFAULT_PORT).describe('Port for the map'))
  .option('--interval [seconds]', z.number().default(60).describe('How often to ask Find My for new locations'))
  .option('--open', 'Open the map in the browser')
  .example('marauders-map --open')
  .action(async (options) => {
    const server = await startServer({ port: options.port, distDir: path.resolve(DIST_DIR) })
    if (server instanceof Error) {
      console.error(`${server.message}. Try another one: marauders-map --port ${options.port + 1}`)
      process.exit(1)
    }
    const url = `http://localhost:${options.port}/`
    console.log(`The Marauder's Map is open at ${colors.bold(url)}`)

    const session = await loadSession()
    if (!session) {
      console.log(colors.dim('Not logged in to iCloud, showing demo walkers. Run `marauders-map login` to see your devices.'))
    }
    if (options.open) await openInBrowser(url)
    if (!session) return

    const findMy = createFindMy({ session })
    const intervalMs = Math.max(MIN_POLL_S, options.interval) * 1000
    const controller = new AbortController()
    process.once('SIGINT', () => {
      controller.abort()
      server.close()
      process.exit(0)
    })
    while (!controller.signal.aborted) {
      const devices = await findMy.devices({ signal: controller.signal })
      if (devices instanceof Error) console.error(colors.yellow(`Find My: ${devices.message}`))
      else ingestDevices(devices)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs)
        controller.signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
      })
    }
  })

cli.help()
cli.completions()
cli.version('0.1.0')
void cli.parse()
