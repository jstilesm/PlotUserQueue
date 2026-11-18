// Step 5 check file: proves .ts files are served as JavaScript with the
// types removed. Delete once the kiosk's own .ts files are covered.
export const greeting: string = 'hi';
export function shout(word: string): string {
  return word.toUpperCase();
}
