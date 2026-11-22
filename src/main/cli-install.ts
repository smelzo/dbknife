import { app, BrowserWindow, dialog, type MessageBoxOptions } from 'electron'
import { execFile } from 'node:child_process'
import { access, constants, rm, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { t } from '@shared/i18n'

// "Install 'dbknife' Command in PATH" of the macOS app menu: links the script of
// resources/cli/dbknife, packaged inside the bundle, as /usr/local/bin/dbknife.
// On Linux the .deb already installs /usr/bin/dbknife.

const DEST = '/usr/local/bin/dbknife'

async function show(o: MessageBoxOptions): Promise<void> {
  const win = BrowserWindow.getFocusedWindow()
  await (win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o))
}

/** Shell quoting in single quotes. */
const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
/** Escaping inside an AppleScript string literal. */
const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

async function writable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Runs the command as root, after the macOS password prompt; false when the prompt is cancelled. */
function asAdmin(command: string): Promise<boolean> {
  const script = `do shell script "${esc(command)}" with administrator privileges`
  return new Promise((resolve, reject) =>
    execFile('osascript', ['-e', script], (err, _stdout, stderr) => {
      if (!err) resolve(true)
      // -128: "User canceled."
      else if (stderr.includes('(-128)')) resolve(false)
      else reject(new Error(stderr.trim() || err.message))
    })
  )
}

export async function installCliCommand(): Promise<void> {
  // from the dmg or translocated by Gatekeeper the bundle has a temporary path: the link would break
  if (!app.isInApplicationsFolder()) {
    await show({ type: 'warning', message: t('cli.install.moveFirst') })
    return
  }
  const src = join(process.resourcesPath, 'cli', 'dbknife')
  try {
    if (await writable(dirname(DEST))) {
      await rm(DEST, { force: true })
      await symlink(src, DEST)
    } else if (!(await asAdmin(`mkdir -p ${dirname(DEST)} && ln -sf ${sq(src)} ${DEST}`))) return
    await show({ type: 'info', message: t('cli.install.done', { path: DEST }) })
  } catch (e) {
    await show({ type: 'error', message: t('cli.install.failed', { error: (e as Error).message }) })
  }
}
