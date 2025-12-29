(() => {
  "use strict";

  // ---------------- DOM helpers ----------------
  function $(sel, root = document) { return root.querySelector(sel); }
  function el(tag, props = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k === "style") n.setAttribute("style", v);
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (k in n) n[k] = v;
      else n.setAttribute(k, String(v));
    }
    for (const c of children) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return n;
  }

  function clamp01(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }
  function clamp(x, lo, hi) {
    const n = Number(x);
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  function triggerEquationUpdate(eqInput) {
    eqInput.dispatchEvent(new Event("input", { bubbles: true }));
    eqInput.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ---------------- deterministic RNG (independent) ----------------
  function hash32(str) {
    let h = 2166136261 >>> 0;
    const s = String(str ?? "");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  function makeRng(seedStr) {
    let s = hash32(seedStr) || 0x9e3779b9;
    return function rng() {
      s ^= (s << 13) >>> 0;
      s ^= (s >>> 17) >>> 0;
      s ^= (s << 5) >>> 0;
      return (s >>> 0) / 4294967296;
    };
  }
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
  function chance(rng, p) { return rng() < p; }
  function formatNum(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return "0";
    const s = n.toFixed(6);
    return String(Number(s));
  }

  // ---------------- Safe expression building blocks ----------------
  const EPS = "0.000001";

  function safeExp(expr, k) {
    // Prevent infinity: exp(tanh(expr) * k) is always finite.
    return `exp(tanh(${expr}) * ${formatNum(k)})`;
  }

  function safeDiv(num, den) {
    // Prevent divide-by-0: abs(den)+eps
    return `((${num}) / (abs(${den}) + ${EPS}))`;
  }

  // ---------------- Broadening: mutate (type-aware) ----------------
  // Goal: keep "class" character but avoid fixed template repetition.
  function broadenEquation(existing, opts) {
    const {
      rng,
      type,
      amount,       // 0..1 broadening intensity
      complexity,   // 1..10 user complexity
      randomness    // 0..1
    } = opts;

    const base = String(existing || "").trim() || "x";
    const c = clamp(complexity, 1, 10);
    const r = clamp01(randomness);
    const a = clamp01(amount);

    // Complexity scaling: 8 complex but readable; 10 egregious.
    const cn = c / 10;
    const egregious = Math.pow(cn, 6); // spikes near 10
    const dense = Math.pow(cn, 3);

    // Type flavor knobs (bias only; still can do anything if you crank broadening)
    const flavor = (() => {
      switch (type) {
        case "Bass":
          return { wrap: 0.30, mul: 0.22, trig: 0.55, shaper: 0.65, log: 0.10, exp: 0.08, clamp: 0.70 };
        case "Lead":
          return { wrap: 0.35, mul: 0.18, trig: 0.65, shaper: 0.45, log: 0.10, exp: 0.10, clamp: 0.55 };
        case "Pad":
          return { wrap: 0.45, mul: 0.12, trig: 0.55, shaper: 0.35, log: 0.12, exp: 0.12, clamp: 0.45 };
        case "Pluck":
          return { wrap: 0.30, mul: 0.20, trig: 0.55, shaper: 0.25, log: 0.18, exp: 0.22, clamp: 0.35 };
        case "Perc":
          return { wrap: 0.40, mul: 0.28, trig: 0.55, shaper: 0.55, log: 0.10, exp: 0.08, clamp: 0.55 };
        case "Drone":
          return { wrap: 0.55, mul: 0.10, trig: 0.50, shaper: 0.35, log: 0.12, exp: 0.12, clamp: 0.40 };
        case "FX":
        default:
          return { wrap: 0.60, mul: 0.22, trig: 0.55, shaper: 0.45, log: 0.20, exp: 0.20, clamp: 0.30 };
      }
    })();

    // As broadening increases, we loosen "flavor" constraints.
    const loosen = a * 0.8 + r * 0.3 + egregious * 0.5;

    function coeff() {
      const mag = 0.15 + rng() * (1.7 + 6.0 * r + 4.0 * loosen);
      const sign = chance(rng, 0.5) ? -1 : 1;
      const snap = chance(rng, 0.18 + 0.45 * r);
      const v = snap ? Math.round(sign * mag) : sign * mag;
      return formatNum(v);
    }

    function randVar() {
      // Keep x dominant; include a/b/c/d
      return pick(rng, ["x", "x", "x", "a", "b", "c", "d"]);
    }

    function atom() {
      if (chance(rng, 0.55)) {
        const v = randVar();
        return chance(rng, 0.6) ? v : `${coeff()}*${v}`;
      }
      return coeff();
    }

    function wrap(expr) {
      // wrapper selection is safe (no unbounded exp)
      const ops = [];

      if (chance(rng, flavor.trig + loosen * 0.2)) {
        ops.push((e) => `sin(${e})`, (e) => `cos(${e})`, (e) => `tan(${e})`);
      }
      if (chance(rng, flavor.shaper + loosen * 0.2)) {
        ops.push((e) => `tanh(${e})`, (e) => `atan(${e})`);
      }
      if (chance(rng, flavor.log + loosen * 0.25)) {
        ops.push((e) => `log(abs(${e}) + ${EPS})`);
      }
      if (chance(rng, flavor.exp + loosen * 0.25)) {
        // bounded exp only
        const k = 0.6 + 1.8 * (dense + loosen);
        ops.push((e) => safeExp(e, k));
      }

      // Always allow abs/sqrt guards occasionally
      if (chance(rng, 0.25 + loosen * 0.25)) {
        ops.push((e) => `abs(${e})`, (e) => `sqrt(abs(${e}) + ${EPS})`);
      }

      if (!ops.length) return expr;
      return pick(rng, ops)(expr);
    }

    function term() {
      let expr = atom();

      const combos =
        1 +
        Math.floor(rng() * (1 + c * 0.7 + dense * 4 + egregious * 10) * (0.35 + 0.65 * a));

      for (let i = 0; i < combos; i++) {
        const op = pick(rng, ["+", "-", "+", "-", "*"]);
        expr = `(${expr} ${op} ${atom()})`;
        if (chance(rng, (0.06 + egregious * 0.35) * (0.4 + a))) {
          expr = `(${expr} ${pick(rng, ["+", "-", "*"])} (${atom()} ${pick(rng, ["+", "-", "*"])} ${atom()}))`;
        }
      }

      // Guarded div appears more at high broadening/complexity
      if (chance(rng, (0.08 + dense * 0.25 + egregious * 0.35) * (0.2 + 0.8 * a))) {
        expr = safeDiv(expr, atom());
      }

      // Small safe pow (avoid huge outputs): pow(abs(x)+eps, exp)
      if (chance(rng, (0.06 + dense * 0.20 + egregious * 0.30) * (0.2 + 0.8 * a))) {
        const expChoices = ["2", "3", "0.5", formatNum(1 + rng() * (1.2 + 2.0 * loosen))];
        expr = `pow(abs(${expr}) + ${EPS}, ${pick(rng, expChoices)})`;
      }

      const wraps =
        Math.floor(rng() * (c * 0.8 + dense * 8 + egregious * 22 + r * 5) * (0.25 + 0.75 * a));

      for (let k = 0; k < wraps; k++) expr = wrap(expr);

      return expr;
    }

    // Build a mutation around the base (keeps class feel but different each time)
    const mTerms =
      Math.max(
        1,
        Math.round((1 + c * 1.3 + dense * 6 + egregious * 18) * (0.15 + 0.85 * a))
      );

    let mod = term();
    for (let i = 1; i < mTerms; i++) {
      const multBias = flavor.mul + loosen * 0.25 + egregious * 0.25;
      const op = chance(rng, multBias) ? "*" : pick(rng, ["+", "-", "+", "-"]);
      mod = `(${mod} ${op} ${term()})`;
    }

    // Combine with base using safe blending
    const blend = formatNum(0.05 + 0.40 * a + 0.25 * dense);
    let out = `(${base} + (${blend} * (${mod})))`;

    // Optional soft clamp to avoid insane ranges; less clamping for FX
    if (chance(rng, flavor.clamp * (0.35 + 0.65 * (1 - loosen)))) {
      const scale = formatNum(0.8 + 0.25 * c + 0.6 * r);
      out = `(tanh(${out}) * ${scale})`;
    }

    return out;
  }

  // ---------------- Type-aware Advanced Range broadening ----------------
  // These ranges feed your "Randomize (safe)" button. :contentReference[oaicite:4]{index=4} :contentReference[oaicite:5]{index=5}
  function setAdvancedRangesForType(type, rng, amount) {
    // amount: 0..1. At 0: close to your current intent; at 1: significantly broader but still sane.
    const a = clamp01(amount);

    // Helper to write if element exists
    function set(id, v) {
      const n = document.getElementById(id);
      if (!n) return;
      n.value = String(v);
      n.dispatchEvent(new Event("input", { bubbles: true }));
      n.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Baselines by type (tight-ish), then broaden with amount.
    // Keep min/max symmetric-ish to avoid extreme asymmetry unless FX.
    const base = (() => {
      switch (type) {
        case "Bass":  return { A:[0.4, 3.2], B:[0.2, 2.8], C:[-1.0, 1.0], D:[-1.0, 1.0], XO:[-0.35, 0.35] };
        case "Lead":  return { A:[0.7, 3.8], B:[0.2, 3.6], C:[-1.6, 1.6], D:[-1.6, 1.6], XO:[-0.8, 0.8] };
        case "Pad":   return { A:[0.2, 2.8], B:[0.2, 2.8], C:[-2.0, 2.0], D:[-2.0, 2.0], XO:[-1.2, 1.2] };
        case "Pluck": return { A:[0.8, 4.2], B:[0.3, 4.0], C:[-2.2, 2.2], D:[-2.2, 2.2], XO:[-1.0, 1.0] };
        case "Perc":  return { A:[1.2, 6.0], B:[0.6, 6.5], C:[-2.5, 2.5], D:[-2.5, 2.5], XO:[-0.9, 0.9] };
        case "Drone": return { A:[0.1, 2.0], B:[0.1, 1.8], C:[-2.8, 2.8], D:[-2.8, 2.8], XO:[-1.6, 1.6] };
        case "FX":
        default:      return { A:[0.1, 8.0], B:[0.1, 8.0], C:[-6.0, 6.0], D:[-6.0, 6.0], XO:[-2.0, 2.0] };
      }
    })();

    // Broaden factor grows nonlinearly with amount (so small amount is gentle)
    const grow = 1 + Math.pow(a, 1.7) * 2.2;

    function widen([lo, hi], extraSym) {
      const mid = (lo + hi) * 0.5;
      const half = (hi - lo) * 0.5;
      // jitter prevents repeatability even with same type (unless you seed it)
      const jitter = 0.85 + rng() * 0.30;
      const newHalf = half * grow * jitter + extraSym * (a * 0.35);
      const nlo = mid - newHalf;
      const nhi = mid + newHalf;
      return [nlo, nhi];
    }

    // ExtraSym lets FX blow out more than others
    const extra = (type === "FX") ? 5.0 : 1.5;

    const A = widen(base.A, extra);
    const B = widen(base.B, extra);
    const C = widen(base.C, extra);
    const D = widen(base.D, extra);
    const XO = widen(base.XO, extra);

    // Write them
    set("paramARangeMin", formatNum(A[0]));
    set("paramARangeMax", formatNum(A[1]));
    set("paramBRangeMin", formatNum(B[0]));
    set("paramBRangeMax", formatNum(B[1]));
    set("paramCRangeMin", formatNum(C[0]));
    set("paramCRangeMax", formatNum(C[1]));
    set("paramDRangeMin", formatNum(D[0]));
    set("paramDRangeMax", formatNum(D[1]));
    set("xOffsetRangeMin", formatNum(XO[0]));
    set("xOffsetRangeMax", formatNum(XO[1]));
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
        el("span", { style: "opacity:0.75; font-size:12px;", textContent: "Keeps type rules, but makes equations/ranges vary more each run. Safe div/exp." })
      ]),

      el("div", { style: "margin-top:8px; display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:10px;" }, [
        el("div", {}, [
          el("label", { style: "display:block; font-size:12px; opacity:0.85;", textContent: "Broadening amount (0–1)" }),
          el("input", { id: "eqb_amount", type: "range", min: "0", max: "1", step: "0.01", value: "0.55", style: "width:100%;" }),
          el("div", { style: "display:flex; justify-content:space-between; font-size:12px; opacity:0.75;" }, [
            el("span", { textContent: "subtle" }),
            el("span", { id: "eqb_amount_val", textContent: "0.55" }),
            el("span", { textContent: "wild" })
          ])
        ]),
        el("div", {}, [
          el("label", { style: "display:block; font-size:12px; opacity:0.85;", textContent: "Complexity (1–10) — 8 complex, 10 egregious" }),
          el("input", { id: "eqb_complexity", type: "range", min: "1", max: "10", step: "1", value: "7", style: "width:100%;" }),
          el("div", { style: "display:flex; justify-content:space-between; font-size:12px; opacity:0.75;" }, [
            el("span", { textContent: "1" }),
            el("span", { id: "eqb_complexity_val", textContent: "7" }),
            el("span", { textContent: "10" })
          ])
        ]),
        el("div", {}, [
          el("label", { style: "display:block; font-size:12px; opacity:0.85;", textContent: "Randomness (0–1)" }),
          el("input", { id: "eqb_randomness", type: "range", min: "0", max: "1", step: "0.01", value: "0.50", style: "width:100%;" }),
          el("div", { style: "display:flex; justify-content:space-between; font-size:12px; opacity:0.75;" }, [
            el("span", { textContent: "stable" }),
            el("span", { id: "eqb_randomness_val", textContent: "0.50" }),
            el("span", { textContent: "chaos" })
          ])
        ]),
        el("div", {}, [
          el("label", { style: "display:block; font-size:12px; opacity:0.85;", textContent: "Broadening seed (optional; blank uses main Seed)" }),
          el("input", { id: "eqb_seed", type: "text", placeholder: "blank = use main Seed field", style: "width:100%;" })
        ])
      ]),

      el("div", { style: "margin-top:10px; display:flex; flex-wrap:wrap; gap:10px;" }, [
        el("button", { type: "button", id: "eqb_apply_now", textContent: "Broaden Current Equation + Ranges" }),
      ]),

      el("div", { id: "eqb_status", style: "margin-top:8px; font-size:12px; opacity:0.8;", textContent: "" })
    ]);

    eqInput.insertAdjacentElement("afterend", container);

    const style = el("style", { textContent: `
      .eqgen-inject button {
        padding: 6px 10px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.18);
        background: rgba(255,255,255,0.06);
        color: inherit;
        cursor: pointer;
      }
      .eqgen-inject button:hover { background: rgba(255,255,255,0.10); }
      .eqgen-inject input[type="text"] {
        padding: 6px 8px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.18);
        background: rgba(0,0,0,0.18);
        color: inherit;
        box-sizing: border-box;
      }
    `});
    document.head.appendChild(style);

    // Value labels
    const amt = $("#eqb_amount");
    const amtv = $("#eqb_amount_val");
    const comp = $("#eqb_complexity");
    const compv = $("#eqb_complexity_val");
    const rnd = $("#eqb_randomness");
    const rndv = $("#eqb_randomness_val");

    function sync() {
      if (amtv) amtv.textContent = String(Number(amt.value).toFixed(2));
      if (compv) compv.textContent = String(comp.value);
      if (rndv) rndv.textContent = String(Number(rnd.value).toFixed(2));
    }
    [amt, comp, rnd].forEach((x) => x && x.addEventListener("input", sync));
    sync();

    function status(msg) {
      const s = $("#eqb_status");
      if (s) s.textContent = msg;
    }

    function getSeed() {
      const local = ($("#eqb_seed")?.value || "").trim();
      if (local) return local;
      const main = (seedInput?.value || "").trim();
      return main || String(Date.now());
    }

    function broadenNow(tag) {
      const seed = getSeed();
      const rng = makeRng(seed);

      const type = (typeSel?.value || "Any");
      const t = (type === "Any" || type === "Random") ? "FX" : type; // if UI is random/any, treat as wide

      const amount = clamp01(amt.value);
      const complexity = clamp(comp.value, 1, 10);
      const randomness = clamp01(rnd.value);

      // 1) broaden advanced ranges for class-driven safe randomize
      setAdvancedRangesForType(t, rng, amount);

      // 2) broaden equation safely (no div-by-0, bounded exp)
      const out = broadenEquation(eqInput.value, {
        rng,
        type: t,
        amount,
        complexity,
        randomness
      });

      eqInput.value = out;
      triggerEquationUpdate(eqInput);
      status(`${tag} (type=${t}, seed=${seed})`);
    }

    // Manual apply
    $("#eqb_apply_now")?.addEventListener("click", () => broadenNow("Broadened"));

    // Hook instrument generator button: run AFTER original click handler (no changes to original file)
    if (btnGenInstr) {
      btnGenInstr.addEventListener("click", () => {
        // Let original generateInstrument() run first, then broaden the result.
        setTimeout(() => broadenNow("Generated + broadened"), 0);
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  } else {
    inject();
  }
})();