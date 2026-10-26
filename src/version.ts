declare const __VERSION__: string;

/** The version of this command, from package.json at build time. */
export const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0';
