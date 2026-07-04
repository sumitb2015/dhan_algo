// Shared auth constants for login/status/logout routes and middleware.
// COOKIE_SECRET keeps cookie signatures consistent across restarts.
// For a local dev tool on localhost, a baked-in constant is acceptable.
export const COOKIE_SECRET  = 'dhan-dashboard-local-secret-v1';
export const SESSION_COOKIE = 'dhan_session';
export const SESSION_MAX_AGE = 86_400; // 24 h — matches Dhan token lifetime
