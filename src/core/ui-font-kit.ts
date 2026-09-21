import { UIKit } from '@iwsdk/core';
import { HUD_FONT_FAMILIES } from '../vfx/fonts/font-registry.js';

// Registered globally as index.ts's features.spatialUI.kits `span`/`button`
// entries so every .uikitml file's <span>/<button> — not just the
// hand-rolled <hudtext> in notification-hud.uikitml — picks up the game's
// MSDF font atlas. `fontFamilies` only takes effect at component
// construction time (setProperties() on an already-built element doesn't
// retroactively reshape its glyphs), and plain uikitml markup has no way to
// pass that itself, so it has to be injected here via defaultOverrides.
// Each file's own `font-family: hud;` / `font-weight: ...;` CSS still picks
// which entry of the map to use.
type ContainerCtorArgs = ConstructorParameters<typeof UIKit.Container>;

export class GameSpan extends UIKit.Container {
  constructor(inputProperties?: ContainerCtorArgs[0], initialClasses?: ContainerCtorArgs[1], config?: ContainerCtorArgs[2]) {
    super(inputProperties, initialClasses, {
      ...config,
      defaultOverrides: {
        fontFamilies: HUD_FONT_FAMILIES,
        ...config?.defaultOverrides,
      },
    });
  }
}

// Overriding the `button` kit entry replaces @pmndrs/uikitml's built-in
// mapping entirely (first match in the kit list wins), so this repeats its
// default button styling (verticalAlign/textAlign/cursor) alongside the
// font override rather than losing it.
export class GameButton extends UIKit.Container {
  constructor(inputProperties?: ContainerCtorArgs[0], initialClasses?: ContainerCtorArgs[1], config?: ContainerCtorArgs[2]) {
    super(inputProperties, initialClasses, {
      ...config,
      defaultOverrides: {
        verticalAlign: 'middle',
        textAlign: 'center',
        cursor: 'pointer',
        fontFamilies: HUD_FONT_FAMILIES,
        ...config?.defaultOverrides,
      },
    });
  }
}
