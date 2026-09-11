// Same uniform-area disc sample ArtTestVfxSystem's own scatterDisc() uses
// (sqrt(random) so points don't bunch toward the center) — copied in rather
// than imported since these are currently private helpers of a dev-test
// file, not a shared module. Used by StardustSystem to lay out its
// collectible swirl field (see stardust-system.ts's _buildSwirlSpawnPoint) —
// this file now only exports the raw position math, not a static
// class/builder, since the swirl needs live per-point gather state instead
// of a pre-baked immutable Points cloud (see the swirl finale's own plan).
export function scatterDisc(radius: number, depthJitter: number): [number, number, number] {
  const r = radius * Math.sqrt(Math.random());
  const theta = Math.random() * Math.PI * 2;
  return [Math.cos(theta) * r, Math.sin(theta) * r, (Math.random() * 2 - 1) * depthJitter];
}

// Same galaxy-arm sample ArtTestVfxSystem's own scatterGalaxyArm() uses —
// radius grows linearly with t, angle winds `turns` times, arms offset
// evenly around the center, perpendicular jitter widens with radius.
export function scatterGalaxyArm(
  armIndex: number,
  armCount: number,
  turns: number,
  maxRadius: number,
  spreadFactor: number,
  depthJitter: number,
): [number, number, number] {
  const t = Math.random();
  const angle = t * turns * Math.PI * 2 + armIndex * ((Math.PI * 2) / armCount);
  const radius = t * maxRadius;
  const spread = spreadFactor * radius * (Math.random() * 2 - 1);
  const perpAngle = angle + Math.PI / 2;
  return [
    Math.cos(angle) * radius + Math.cos(perpAngle) * spread,
    Math.sin(angle) * radius + Math.sin(perpAngle) * spread,
    (Math.random() * 2 - 1) * depthJitter,
  ];
}
