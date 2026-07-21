export function portableQueryValues(values: readonly unknown[]): unknown[] {
  return values.map((value) =>
    Object.prototype.toString.call(value) === "[object Date]"
      ? (value as Date).toISOString()
      : value
  )
}
