export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const isWindows = isDesktop && navigator.userAgent.includes("Windows");
export const isLinux = isDesktop && !isWindows && /Linux|X11/.test(navigator.userAgent);
