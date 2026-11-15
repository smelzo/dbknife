// Language packs: loading from the languages folder, Preferences, install and remove. node e2e/i18n.mjs
// fi_FI only hosts the test: its texts are placeholders, no such pack exists in the repo.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker, launch, menu, shot, uiText } from './lib.mjs'

const result = checker()
const { check } = result
const userData = mkdtempSync(join(tmpdir(), 'dbm-e2e-'))
const languages = join(userData, 'languages')
mkdirSync(languages)
const pack = (locale, messages) => ({ locale, name: 'Test', nativeName: 'Test', messages })
const writePack = (file, json) => writeFileSync(file, JSON.stringify(json))
writePack(join(languages, 'fi_FI.json'), pack('fi_FI', { 'menu.file': 'Fxx', 'prefs.title': 'Pxx', 'no.such.key': 'Nxx' }))
writePack(join(languages, 'FF_44.json'), pack('FF_44', { 'menu.file': 'Gxx' })) // code outside the closed list
writePack(join(languages, 'de_DE.json'), pack('it_IT', { 'menu.file': 'Dxx' })) // file name and locale disagree
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ language: 'fi_FI' }))
// a browser may save a download under another name: it is installed as it_IT.json
const download = join(mkdtempSync(join(tmpdir(), 'dbm-e2e-')), 'it_IT (1).json')
writePack(download, pack('it_IT', { 'prefs.removeLanguage': 'Rimuovi' }))

const { app, page, errors } = await launch(userData)
try {
  const fileMenu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[1].label)
  check('menu translated by the selected pack', fileMenu === 'Fxx', fileMenu)

  await menu(app, 'app.preferences')
  const modal = page.locator('.panel[role=dialog]')
  await modal.waitFor()
  const title = await modal.locator('.title').innerText()
  check('Preferences title translated', title === 'Pxx', title)
  check('message missing from the pack stays English', (await modal.locator('h4', { hasText: uiText('prefs.sqlEditor') }).count()) === 1)
  const rows = modal.locator('table.languages tr')
  const rowTexts = () => rows.allInnerTexts()
  const installed = await rowTexts()
  check('only the valid pack is listed', installed.length === 1 && installed[0].includes('suomi'), installed.join(' / '))
  const languageOptions = () => modal.locator('#pr-language option').evaluateAll((os) => os.map((o) => o.value))
  const options = await languageOptions()
  check('language choice offers system, English, the valid pack and the built-in language', options.join() === 'system,en_US,fi_FI,it_IT', options.join())
  check('saved language selected', (await modal.locator('#pr-language').inputValue()) === 'fi_FI')
  const restartButton = modal.getByRole('button', { name: 'Restart' })
  check('no restart offered for the language in use', (await restartButton.count()) === 0)

  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, download)
  await modal.getByRole('button', { name: 'Install Language…' }).click()
  await rows.filter({ hasText: 'italiano' }).waitFor()
  check('installed under its locale', existsSync(join(languages, 'it_IT.json')))
  check('installed language listed', (await rowTexts()).length === 2, (await rowTexts()).join(' / '))

  // confirm() of the renderer goes through ui:message, i.e. dialog.showMessageBox: answer with the first button
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  })
  await rows.filter({ hasText: 'italiano' }).getByRole('button').click()
  await rows.filter({ hasText: 'italiano' }).waitFor({ state: 'detached' })
  check('removed pack file deleted', !existsSync(join(languages, 'it_IT.json')))
  check('built-in language still offered after removing its pack', (await languageOptions()).includes('it_IT'))

  // removing the language in use resets the choice, and OK must not save it back
  await rows.filter({ hasText: 'suomi' }).getByRole('button').click()
  await rows.filter({ hasText: 'suomi' }).waitFor({ state: 'detached' })
  check('language in use removed', !existsSync(join(languages, 'fi_FI.json')))
  check('choice back to system', (await modal.locator('#pr-language').inputValue()) === 'system')
  check('restart offered for another language', (await restartButton.count()) === 1)
  await shot(page, 'i18n-preferences')
  check('no renderer errors', errors.length === 0, errors.join('\n'))
  // Restart saves the choice and ends the app (tests do not relaunch it)
  const exited = new Promise((resolve) => app.process().once('exit', resolve))
  await restartButton.click()
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('app still running after Restart')), 10000))])
  const saved = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).language
  check('Restart saves the setting', saved === 'system', saved)
} finally {
  await app.close().catch(() => {})
}
console.log(result.failures ? `\n${result.failures} failure(s)` : '\nall checks passed')
process.exit(result.failures ? 1 : 0)
