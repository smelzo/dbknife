/** Day 0 of Excel's 1900 date system, as Excel counts from 1 March 1900 (serial 61) on. */
const epoch = Date.UTC(1899, 11, 30)

/**
 * `YYYY-MM-DD` of an Excel date serial (whole days since the epoch), with ` HH:MM:SS` when it has a
 * fraction of a day; seconds rounded, computed in UTC.
 *
 * Limits:
 * - serials 1 to 60 come out one day earlier than Excel shows, because Excel counts 29 February 1900,
 *   a day that does not exist;
 * - the 1904 date system is not supported: d-spread does not say which system a workbook uses.
 */
export function excelSerialToIso(serial: number): string {
  const iso = new Date(epoch + Math.round(serial * 86_400) * 1000).toISOString()
  return Number.isInteger(serial) ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
}
