// Gate for the agent-testing hooks (DevPerfLoggerSystem's frame logging,
// DevJumpSystem's remote phase controls). Always on in dev; in a production
// build only with `?perfhooks` AND served from localhost — i.e. a local
// `vite preview` reached over `adb reverse`, for profiling the real
// production bundle on a headset. The localhost check keeps the phase-jump
// hooks (which could skip straight to achievements / leaderboard releases)
// unreachable on any deployed copy of the game.
export const PERF_HOOKS_ENABLED =
  import.meta.env.DEV ||
  (location.hostname === 'localhost' && new URLSearchParams(location.search).has('perfhooks'));
