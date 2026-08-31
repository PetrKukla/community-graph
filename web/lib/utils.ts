/**
 * Conditional class-name join. `shadcn-svelte init` replaces this with the
 * clsx + tailwind-merge version once the component library is installed.
 */
export function cn(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(' ');
}
