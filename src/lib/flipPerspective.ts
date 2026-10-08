/** Today's depth for a card of any size: the camera never sits closer than this. */
export const MIN_FLIP_PERSPECTIVE_PX = 1200;

/** How far, in px, a flipping card's outline may reach past its own box at any angle. Inside the page's 24 px mobile padding. */
export const FLIP_OVERFLOW_BOUND_PX = 12;

/**
 * The CSS `perspective` for a card of this layout size flipping on its
 * horizontal axis (rotateX), so its projected outline never reaches more
 * than `bound` px past its own box at any angle.
 *
 * With the camera at distance p from the card's centre, a point lifted
 * toward the viewer by z is drawn p / (p − z) times larger. Two edges of the
 * outline grow:
 *
 * - Sideways, the near edge. Edge-on (90°), it comes forward by h/2, so the
 *   card's half-width w/2 is drawn w/2 · p / (p − h/2). Keeping that within
 *   w/2 + bound gives p ≥ h/2 + w·h / (4·bound). This is the one that bites:
 *   it grows with width, which is why a full-width hero spilled off screen.
 * - Up or down, the edge swinging toward the viewer, drawn at half-height
 *   h/2 · cos θ · p / (p − h/2 · sin θ). Its peak over θ is h/2 / √(1 − k²)
 *   with k = h / (2p); keeping that within h/2 + bound gives
 *   p ≥ (h/2) / √(1 − r²), r = (h/2) / (h/2 + bound). Only matters for a
 *   tall, narrow card.
 *
 * Takes layout size (offsetWidth/offsetHeight), never a transformed
 * bounding box: mid-flip that box is the very projection being bounded.
 * A size that isn't a positive finite number (jsdom, a detached node)
 * returns the floor.
 */
export function flipPerspectivePx(
  width: number,
  height: number,
  bound: number = FLIP_OVERFLOW_BOUND_PX
): number {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return MIN_FLIP_PERSPECTIVE_PX;
  }
  const halfHeight = height / 2;
  const sideways = halfHeight + (width * height) / (4 * bound);
  const r = halfHeight / (halfHeight + bound);
  const upDown = halfHeight / Math.sqrt(1 - r * r);
  return Math.ceil(Math.max(MIN_FLIP_PERSPECTIVE_PX, sideways, upDown));
}
