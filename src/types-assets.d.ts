// Vite can import any file as a string with the `?raw` suffix. Text presets are bundled
// this way rather than fetched at runtime — see DESIGN.md Q4, which is still open on
// whether they should eventually be a user-editable folder instead.
declare module '*.txt?raw' {
  const content: string;
  export default content;
}
