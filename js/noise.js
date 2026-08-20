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

  // Gradient (Perlin-style) noise, not value noise. Value noise interpolates
  // hashed *values* at each grid corner, and that interpolation is what gives
  // it its telltale look: every cell settles smoothly toward whatever its
  // four corners happen to be, so maxima/minima come out as round, plateau-
  // topped blobs with no preferred direction — exactly the "blobby" coastline
  // complaint this was written to fix. Gradient noise instead hashes a
  // *direction* at each corner and dots it against the offset to the sample
  // point, so each cell's contribution is a signed ramp/saddle rather than a
  // bump — the classic fix for blob-prone terrain noise, independent of
  // anything OpenFront-specific (OpenFront doesn't generate coastlines
  // procedurally at all; see map.js's generate() for why).
  //
  // 8-direction gradient table (classic Perlin) instead of hashing an angle
  // through cos/sin per corner: a map-sized grid needs 4 of these per octave
  // per tile, and trig calls at that volume are measurably the difference
  // between sub-second and multi-second generation.
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

    // Perlin noise ranges roughly [-0.7, 0.7] (bounded by sqrt(2)/2 for a
    // unit gradient dotted against a diagonal offset); remap to 0..1 so
    // every existing caller — which was written against value noise's
    // native 0..1 range — keeps working unchanged.
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

  // Ridged multifractal (Musgrave's terrain trick, standard for mountain-
  // range texture). Plain fbm — what `fractal` above computes — is still a
  // sum of smooth bumps at every octave, so any percentile slice through it
  // reads as a handful of round blobs, just smaller ones the more octaves
  // you add; that's what happened tuning the mountain/highland tiers off
  // `fractal` directly. Folding each octave via `1 - abs(2v-1)` turns its
  // smooth bumps into creases (zero at each ridge, not at each valley), and
  // weighting every octave's amplitude by the previous octave's ridge value
  // makes fine ridges cluster along coarse ones instead of scattering
  // independently — the cascading, vein-like structure real mountain ranges
  // (and OpenFront's own hand-authored highland texture) show, in contrast
  // to fbm's isolated rounded lumps.
  function ridged(x, y, seed, octaves = 6) {
    let sum = 0, amp = 0.5, freq = 1, prev = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
      let n = (value(x * freq, y * freq, seed + i * 17) - 0.5) * 2; // -1..1
      n = 1 - Math.abs(n);
      n *= n;
      sum += n * amp * prev;
      norm += amp;
      prev = n;
      freq *= 2;
      amp *= 0.5;
    }
    return sum / norm;
  }

  return { fractal, ridged };
})();
