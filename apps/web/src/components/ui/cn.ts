/**
 * Joins class names, dropping falsy entries. Deliberately not `clsx` or
 * `tailwind-merge` — nothing in the kit conditionally applies two classes
 * that target the same Tailwind property, so there is nothing for a merge
 * step to resolve. A dependency earns its place when that stops being true.
 */
export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}
