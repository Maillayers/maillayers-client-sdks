declare module '*.svelte' {
  import type { SvelteComponent } from 'svelte';
  export default class Component extends SvelteComponent {}
}

declare const __MAILLAYERS_PACKAGE_VERSION__: string;
