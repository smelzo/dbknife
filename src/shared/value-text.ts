/**
 * A value of a `Row`, as the driver returns it, as text: '' for null and undefined, binary data as
 * UTF-8, other objects (JSON columns, arrays) as JSON, dates and scalars as String() writes them.
 * Unlike String(), never '[object Object]', and in the renderer, where a Buffer arrives as a
 * Uint8Array, not its bytes as '1,2,3'.
 */
export function valueText(v: unknown): string {
  switch (typeof v) {
    case 'string':
      return v
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(v)
    case 'object':
      if (v === null) return ''
      if (v instanceof Uint8Array) return new TextDecoder().decode(v)
      return v instanceof Date ? String(v) : JSON.stringify(v)
    default:
      return ''
  }
}
