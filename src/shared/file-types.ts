// Files the app opens directly (File menu, drop on the home screen, Finder);
// mac.fileAssociations in electron-builder.yml lists the same extensions.

/** Opened as SQLite databases. */
export const sqliteExtensions = ['db', 'sqlite', 'sqlite3', 'sq3']

/** Opened as the only table of a hidden SQLite database. */
export const csvExtensions = ['csv']

const ending = (extensions: string[]): RegExp => new RegExp(`\\.(${extensions.join('|')})$`, 'i')
const sqlitePattern = ending(sqliteExtensions)
const csvPattern = ending(csvExtensions)

export const isSqliteFile = (path: string): boolean => sqlitePattern.test(path)
export const isCsvFile = (path: string): boolean => csvPattern.test(path)
