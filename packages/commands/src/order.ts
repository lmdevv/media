/**
 * Orders strings by UTF-16 code units, the same on every host. `localeCompare` follows the host's
 * locale, which would make generated files differ between machines.
 */
export const byCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
