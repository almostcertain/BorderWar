// Seeded value noise with fractal octaves. Enough for continent shapes.
const Noise = (() => {
  function hash2(x, y, seed) {
    let h = x * 374761393 + y * 668265263 + seed * 1442695041;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // Quintic fade (Perlin's, not smoothstep) — matches zero second derivative
  // at each end, which is what keeps gradient noise from showing seams where
  // grid cells meet.
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

  // Gradient (Perlin-style) noise, not value noise: value noise gives
  // round, plateau-topped blobs, which made blobby coastlines.
  //
  // An 8-direction gradient table instead of cos/sin per corner: trig at
  // four calls per octave per tile made generation several times slower.
  const GRADIENTS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
  function grad(xi, yi, seed, dx, dy) {
    const g = GRADIENTS[(hash2(xi, yi, seed) * 8) | 0];
    return g[0] * dx + g[1] * dy;
  }

  function value(x, y, seed) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);

    const a = grad(xi, yi, seed, xf, yf);
    const b = grad(xi + 1, yi, seed, xf - 1, yf);
    const c = grad(xi, yi + 1, seed, xf, yf - 1);
    const d = grad(xi + 1, yi + 1, seed, xf - 1, yf - 1);

    const top = a + (b - a) * u;
    const bottom = c + (d - c) * u;
    const n = top + (bottom - top) * v;

    // Perlin noise ranges roughly [-0.7, 0.7]; remap to 0..1, which every
    // caller expects.
    return n * 0.7 + 0.5;
  }

  function fractal(x, y, seed, octaves = 5) {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += value(x * freq, y * freq, seed + i * 17) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }

  // Same gradient noise as `value`, but also returns its analytic slope, in
  // -1..1 (not remapped to 0..1). Written into a shared scratch array rather
  // than allocated: this runs several times per tile across millions of tiles.
  // Slope is what lets `eroded` below tell steep ground from gentle ground
  // without sampling neighbours.
  const nd = [0, 0, 0];
  function valueWithSlope(x, y, seed) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);
    // d/dt of the quintic fade: 30 t^2 (t-1)^2
    const du = 30 * xf * xf * (xf - 1) * (xf - 1);
    const dv = 30 * yf * yf * (yf - 1) * (yf - 1);

    const ga = GRADIENTS[(hash2(xi, yi, seed) * 8) | 0];
    const gb = GRADIENTS[(hash2(xi + 1, yi, seed) * 8) | 0];
    const gc = GRADIENTS[(hash2(xi, yi + 1, seed) * 8) | 0];
    const gd = GRADIENTS[(hash2(xi + 1, yi + 1, seed) * 8) | 0];
    const a = ga[0] * xf + ga[1] * yf;
    const b = gb[0] * (xf - 1) + gb[1] * yf;
    const c = gc[0] * xf + gc[1] * (yf - 1);
    const d = gd[0] * (xf - 1) + gd[1] * (yf - 1);

    const top = a + (b - a) * u;
    const bottom = c + (d - c) * u;
    nd[0] = (top + (bottom - top) * v) * 1.4;
    nd[1] = ((ga[0] * (1 - u) + gb[0] * u) * (1 - v) + (gc[0] * (1 - u) + gd[0] * u) * v
      + du * ((b - a) * (1 - v) + (d - c) * v)) * 1.4;
    nd[2] = ((ga[1] * (1 - u) + gb[1] * u) * (1 - v) + (gc[1] * (1 - u) + gd[1] * u) * v
      + dv * (bottom - top)) * 1.4;
    return nd;
  }

  // Each octave gets its own fixed rotation so no octave lines up with the
  // lattice (8-direction gradients otherwise leave faint axis-aligned creases).
  // Unit vectors, hand-picked, all exact in + - * / so results are identical
  // on every client.
  const OCTAVE_ROT = [[1, 0], [0.8, 0.6], [0.28, 0.96], [-0.6, 0.8], [0.96, 0.28], [0.6, -0.8], [-0.8, 0.6], [0.36, 0.93]];

  // Height field with the character of real terrain, for slicing into
  // mountain/highland/plains tiers. Each octave is divided by
  // 1 + damp * |slope so far|: steep ground stays smooth and fine detail
  // builds up only where the ground is gentle (an erosion look, with no
  // erosion simulation).
  function eroded(x, y, seed, octaves = 5, damp = 0.5, gain = 0.45) {
    let sum = 0, amp = 1, norm = 0, freq = 1, sx = 0, sy = 0;
    for (let i = 0; i < octaves; i++) {
      const r = OCTAVE_ROT[i % OCTAVE_ROT.length];
      const n = valueWithSlope((x * r[0] - y * r[1]) * freq, (x * r[1] + y * r[0]) * freq, seed + i * 17);
      // Slope back into the un-rotated frame, per unit of the caller's coordinates.
      sx += (n[1] * r[0] + n[2] * r[1]) * freq * amp;
      sy += (-n[1] * r[1] + n[2] * r[0]) * freq * amp;
      sum += amp * n[0] / (1 + damp * (sx * sx + sy * sy));
      norm += amp;
      amp *= gain;
      freq *= 2;
    }
    return sum / norm;
  }

  return { fractal, eroded };
})();
