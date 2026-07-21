/** Replaced with the package version string by standard and publication builds. */
declare const __MAILLAYERS_PACKAGE_VERSION__: string;

export const SDK_PACKAGE_VERSION = typeof __MAILLAYERS_PACKAGE_VERSION__ !== 'undefined'
  ? __MAILLAYERS_PACKAGE_VERSION__
  : '0.1.0';
export const SDK_PACKAGE_NAME = '@maillayers/svelte-email-editor';
