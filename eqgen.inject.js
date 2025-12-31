(() => {
  "use strict";

  // ---------------- DOM helpers ----------------
  const $ = (sel, root = document) => root.querySelector(sel);

  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "style") n.setAttribute("style", v);
      else if (k in n) n[k] = v;
      else n.setAttribute(k, v);
    }
    for (const c of children) n.appendChild(c);
    return n;
  }

  function clamp(n, lo, hi) {
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }
  function clamp01(n) { return clamp(n, 0, 1); }

  function formatNum(n) {
    if (!Number.isFinite(n)) return "0";
    const s = (Math.round(n * 1e6) / 1e6).toString();
    return s;
  }

  // ---------------- Seeded RNG (xmur3 + sfc32) ----------------
  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
  }

  function sfc32(a, b, c, d) {
    return function () {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }

  function makeRng(seedStr) {
    if (!seedStr) return Math.random;
    const seed = xmur3(seedStr);
    return sfc32(seed(), seed(), seed(), seed());
  }

  function rand(rng, lo, hi) { return lo + (hi - lo) * rng(); }
  function irand(rng, lo, hi) { return Math.floor(rand(rng, lo, hi + 1)); }
  function choose(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

  // ---------------- Read/write page parameters ----------------
  function getVal(id, fallback = "") {
    const n = document.getElementById(id);
    if (!n) return fallback;
    return (n.value ?? fallback).toString();
  }

  function setVal(id, v) {
    const n = document.getElementById(id);
    if (!n) return;
    n.value = String(v);
    n.dispatchEvent(new Event("input", { bubbles: true }));
    n.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function compileEquation(expr) {
    // Prefer the page's version if it exists.
    if (typeof window.compileEquation === "function") return window.compileEquation(expr);
    return new Function("x", "a", "b", "c", "d", `with (Math) { return (${expr}); }`);
  }

  function analyzeEquation(expr, a, b, c, d, xScale, yScale, xOffset, mirrorMask) {
    let fn;
    try { fn = compileEquation(expr); }
    catch { return { ok: false, reason: "compile" }; }

    const N = 1024;
    let sum2 = 0, sum = 0;
    let peak = 0;
    let valid = 0;

    for (let i = 0; i < N; i++) {
      let x = (i / (N - 1)) * 2 * Math.PI - Math.PI;
      x = (x * xScale) + xOffset;

      if (mirrorMask & 1) x = Math.abs(x);
      if (mirrorMask & 2) x = -Math.abs(x);

      let y = fn(x, a, b, c, d);
      if (!Number.isFinite(y)) continue;

      // Apply yScale here (that's what actually hits the synth)
      y *= yScale;

      // Clamp pathological spikes so one bad sample doesn't dominate
      if (y > 50) y = 50;
      if (y < -50) y = -50;

      sum += y;
      sum2 += y * y;
      const ay = Math.abs(y);
      if (ay > peak) peak = ay;
      valid++;
    }

    if (valid < N * 0.90) return { ok: false, reason: "nan_inf" };
    const mean = sum / valid;
    const rms = Math.sqrt(sum2 / valid);

    return { ok: true, rms, peak, mean };
  }

  function softShape(expr, k) {
    // Keep the wave in a friendly range without hard clipping.
    const kk = formatNum(k);
    return `tanh(${kk}*(${expr}))`;
  }

  function mutateEquation(expr, rng, type, amount, complexity, randomness) {
    let out = String(expr || "sin(x)");

    // If it's already shaped, avoid infinite wrapping.
    const alreadyShaped = /(^|\W)(tanh|atan)\s*\(/.test(out);

    const passes = clamp(Math.round(1 + amount * 3 + complexity * 0.6), 1, 10);

    for (let p = 0; p < passes; p++) {
      const r = rng();

      // Add a harmonic / subharmonic term
      if (r < 0.35 + randomness * 0.25) {
        const mult = clamp(rand(rng, 0.25, 6.0), 0.1, 12);
        const amp = clamp(rand(rng, 0.08, 0.45) * (0.6 + amount * 0.8), 0.05, 0.65);
        const ph = rand(rng, -Math.PI, Math.PI);
        const term = `${formatNum(amp)}*sin(x*${formatNum(mult)} + ${formatNum(ph)})`;
        out = `(${out}) + (${term})`;
        continue;
      }

      // Mild ring-mod / AM
      if (r < 0.55 + randomness * 0.20) {
        const mult = clamp(rand(rng, 0.5, 8.0), 0.1, 16);
        const depth = clamp(rand(rng, 0.15, 0.75) * (0.4 + amount), 0.08, 0.95);
        out = `(${out}) * (1 - ${formatNum(depth)} + ${formatNum(depth)}*sin(x*${formatNum(mult)}))`;
        continue;
      }

      // Symmetry tweaks (can help bass/perc)
      if (r < 0.75) {
        if (type === "Bass" || type === "Perc" || rng() < 0.35) out = `(${out}) - (${formatNum(rand(rng, 0.1, 0.5))})*abs(${out})`;
        else out = `(${out}) + (${formatNum(rand(rng, 0.05, 0.35))})*cos(${out})`;
        continue;
      }

      // Safer nonlinear shaping
      if (!alreadyShaped || rng() < 0.5) {
        const k = clamp(0.65 + amount * 1.2 + rand(rng, -0.25, 0.25), 0.4, 2.1);
        out = softShape(out, k);
      }
    }

    // Final gentle shaping to prevent harsh spikes.
    if (!alreadyShaped) {
      const kFinal = clamp(0.85 + amount * 0.8, 0.6, 1.6);
      out = softShape(out, kFinal);
    }

    // Keep it readable-ish.
    if (out.length > 380) out = out.slice(0, 380);

    return out;
  }

  function improveSound(type, rng) {
    const eqInput = $("#equation");
    if (!eqInput) return;

    const eq = (eqInput.value || "").trim();
    if (!eq) return;

    // Pull params from the page (these IDs exist in eqtest.html)
    const a = parseFloat(getVal("paramA", "1"));
    const b = parseFloat(getVal("paramB", "1"));
    const c = parseFloat(getVal("paramC", "0"));
    const d = parseFloat(getVal("paramD", "0"));
    const xS = parseFloat(getVal("xScale", "1"));
    const yS0 = parseFloat(getVal("yScale", "1"));
    const xO = parseFloat(getVal("xOffset", "0"));
    const mir = parseInt(getVal("mirrorBitmask", "0"), 10) || 0;
    const mainVol0 = parseFloat(getVal("mainVolume", "0.95"));

    const analysis0 = analyzeEquation(eq, a, b, c, d, xS, yS0, xO, mir);
    if (!analysis0.ok) return;

    const targets = {
      Bass: 0.18,
      Lead: 0.22,
      Pad: 0.20,
      Pluck: 0.22,
      Perc: 0.26,
      FX:   0.24
    };
    const t = targets[type] ?? 0.21;

    // RMS normalize via yScale (bounded)
    let scale = t / Math.max(1e-6, analysis0.rms);
    scale = clamp(scale, 0.55, 1.35);
    let yS = yS0 * scale;

    // Peak safety via mainVolume first, then a small yScale trim if needed
    const peakCap = 0.98;
    const estPeak = analysis0.peak * scale;

    let mainVol = mainVol0;
    if (estPeak > peakCap) mainVol = Math.min(mainVol0, peakCap / estPeak);
    mainVol = clamp(mainVol, 0.55, 0.98);

    // If still scary, trim yScale a little more
    if (estPeak * mainVol > 1.05) {
      const trim = 1.05 / (estPeak * mainVol);
      yS *= clamp(trim, 0.7, 1.0);
    }

    setVal("yScale", formatNum(yS));
    setVal("mainVolume", formatNum(mainVol));

    // Filter sanity (avoid "telephone" or "whistling")
    const fc0 = parseFloat(getVal("filterCutoff", "0.5"));
    const fr0 = parseFloat(getVal("filterResonance", "0.15"));

    const ranges = {
      Bass: { c: [0.12, 0.38], r: [0.05, 0.22] },
      Lead: { c: [0.32, 0.85], r: [0.05, 0.28] },
      Pad:  { c: [0.18, 0.55], r: [0.05, 0.25] },
      Pluck:{ c: [0.25, 0.75], r: [0.05, 0.30] },
      Perc: { c: [0.40, 0.90], r: [0.03, 0.20] },
      FX:   { c: [0.15, 0.95], r: [0.05, 0.45] }
    };
    const rr = ranges[type] ?? ranges.Pad;

    setVal("filterCutoff", formatNum(clamp(fc0, rr.c[0], rr.c[1])));
    setVal("filterResonance", formatNum(clamp(fr0, rr.r[0], rr.r[1])));

    // Tiny bit of glide randomness for life (but keep controlled)
    const glide0 = parseFloat(getVal("glideTime", "0"));
    if (glide0 === 0 && (type === "Lead" || type === "FX") && rng() < 0.35) {
      setVal("glideTime", formatNum(rand(rng, 0.01, 0.07)));
    }
  }

  // ---------------- UI + hooking ----------------
  function inject() {
    const eqInput = $("#equation");
    if (!eqInput) return;

    const seedInput = $("#seed");
    const typeSel = $("#instrType");
    const btnGenInstr = $("#btnGenerateInstrument");

    const container = el("div", {
      class: "eqgen-inject",
      style: [
        "margin-top:10px",
        "padding:10px",
        "border:1px solid rgba(255,255,255,0.12)",
        "border-radius:10px",
        "background:rgba(255,255,255,0.03)"
      ].join(";")
    }, [
      el("div", { style: "display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;" }, [
        el("strong", { textContent: "Instrument Broadening (injected)" }),
        el("span", {
          style: "opacity:0.75; font-size:12px;",
          textContent: "Keeps the UI identical, but fixes harsh/clippy results and increases novelty safely."
        })
      ]),

      el("div", { style: "margin-top:8px; display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:10px;" }, [
        el("div", {}, [
          el("label", {
            style: "display:block; font-size:12px; opacity:0.85;",
            textContent: "Amount (0–1) — how far from the base patch"
          }),
          el("input", {
            id: "eqb_amount",
            type: "range",
            min: "0",
            max: "1",
            step: "0.01",
            value: "0.55",
            style: "width:100%;"
          }),
          el("div", { style: "display:flex; justify-content:space-between; font-size:12px; opacity:0.75;" }, [
            el("span", { textContent: "safe" }),
            el("span", { id: "eqb_amount_val", textContent: "0.55" }),
            el("span", { textContent: "wild" })
          ])
        ]),
        el("div", {}, [
          el("label", {
            style: "display:block; font-size:12px; opacity:0.85;",
            textContent: "Complexity (1–10) — more structure, not more clipping"
          }),
          el("input", {
            id: "eqb_complexity",
            type: "range",
            min: "1",
            max: "10",
            step: "1",
            value: "7",
            style: "width:100%;"
          }),
          el("div", { style: "display:flex; justify-content:space-between; font-size:12px; opacity:0.75;" }, [
            el("span", { textContent: "1" }),
            el("span", { id: "eqb_complexity_val", textContent: "7" }),
            el("span", { textContent: "10" })
          ])
        ]),
        el("div", {}, [
          el("label", {
            style: "display:block; font-size:12px; opacity:0.85;",
            textContent: "Randomness (0–1) — more variation per click"
          }),
          el("input", {
            id: "eqb_randomness",
            type: "range",
            min: "0",
            max: "1",
            step: "0.01",
            value: "0.60",
            style: "width:100%;"
          }),
          el("div", { style: "display:flex; justify-content:space-between; font-size:12px; opacity:0.75;" }, [
            el("span", { textContent: "stable" }),
            el("span", { id: "eqb_randomness_val", textContent: "0.60" }),
            el("span", { textContent: "chaos" })
          ])
        ]),
        el("div", {}, [
          el("label", {
            style: "display:block; font-size:12px; opacity:0.85;",
            textContent: "Broadening seed (optional; blank uses main Seed)"
          }),
          el("input", {
            id: "eqb_seed",
            type: "text",
            placeholder: "blank = use main Seed field",
            style: "width:100%;"
          })
        ])
      ]),

      el("div", { style: "margin-top:10px; display:flex; flex-wrap:wrap; gap:10px;" }, [
        el("button", { type: "button", id: "eqb_apply_now", textContent: "Broaden Current Equation + Ranges" })
      ]),

      el("div", { id: "eqb_status", style: "margin-top:8px; font-size:12px; opacity:0.8;", textContent: "" })
    ]);

    // Insert after the equation box (keeps look consistent)
    eqInput.insertAdjacentElement("afterend", container);

    const amt = $("#eqb_amount");
    const comp = $("#eqb_complexity");
    const rnd = $("#eqb_randomness");
    const seedBox = $("#eqb_seed");
    const status = $("#eqb_status");
    const applyBtn = $("#eqb_apply_now");

    function updateLabels() {
      $("#eqb_amount_val").textContent = amt.value;
      $("#eqb_complexity_val").textContent = comp.value;
      $("#eqb_randomness_val").textContent = rnd.value;
    }
    amt.addEventListener("input", updateLabels);
    comp.addEventListener("input", updateLabels);
    rnd.addEventListener("input", updateLabels);
    updateLabels();

    function getBroadSeed() {
      const s = (seedBox.value || "").trim();
      if (s) return s;
      const main = (seedInput?.value || "").trim();
      if (main) return main;
      // No seed provided: include timestamp so consecutive clicks are genuinely different
      return `t=${Date.now()}`;
    }

    function getType() {
      const type = (typeSel?.value || "Any");
      if (type === "Any") return "FX";
      if (type === "Random") return choose(Math.random, ["Bass", "Lead", "Pad", "Pluck", "Perc", "FX"]);
      return type;
    }

    function broadenNow(tag) {
      const type = getType();
      const seed = getBroadSeed();
      const rng = makeRng(seed);

      const amount = clamp01(parseFloat(amt.value));
      const complexity = clamp(parseInt(comp.value, 10), 1, 10);
      const randomness = clamp01(parseFloat(rnd.value));

      // Mutate equation safely for novelty
      const before = (eqInput.value || "").trim();
      const after = mutateEquation(before, rng, type, amount, complexity, randomness);
      eqInput.value = after;
      eqInput.dispatchEvent(new Event("input", { bubbles: true }));
      eqInput.dispatchEvent(new Event("change", { bubbles: true }));

      // Improve sound (normalization + filter sanity)
      improveSound(type, rng);

      status.textContent = `${tag}: ${type} | seed=${seed}`;
    }

    // Manual apply
    applyBtn.addEventListener("click", () => broadenNow("Broadened"));

    // Auto: after Generate Instrument runs, clean up harshness + add controlled novelty
    if (btnGenInstr) {
      btnGenInstr.addEventListener("click", () => {
        setTimeout(() => broadenNow("Generated + improved"), 0);
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  } else {
    inject();
  }
})();