// The pre-hydration theme stamp rendered inline in the root layout. It runs
// before first paint so a visitor with a stored light or system preference
// never sees a dark flash, while first-time visitors keep the server-rendered
// dark default. It reads one fixed localStorage key and writes fixed attribute
// values, no untrusted data flows through it.
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem("pulse-theme");if(t==="system"){t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}if(t==="light"||t==="dark"){var r=document.documentElement;r.setAttribute("data-theme",t);r.style.colorScheme=t}}catch(e){}})()`

/**
 * CSP hash of THEME_BOOT_SCRIPT for the status page policy, which is nonce
 * based and would otherwise block the root layout's inline script. The status
 * page forces its own theme on its container, so the stamp is inert there,
 * but it must not spray console violations on the public page. A unit test
 * asserts this constant matches the script, so editing one without the other
 * fails the build.
 */
export const THEME_BOOT_SCRIPT_SHA256 =
  "sha256-O2Feu5fjsIxnhLtPfeR97Zo+ga89fulOyXNn1kDdvlQ="
