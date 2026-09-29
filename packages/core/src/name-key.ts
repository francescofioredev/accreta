/** How a title or alias is compared: in JS, so no lookup depends on which SQLite build lowers what. */
export function nameKey(name: string): string {
  return name.trim().toLowerCase().normalize("NFC");
}
