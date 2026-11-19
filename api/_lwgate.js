// LearnWow member check for this tool's server. Asks the shared LearnWow Gate before any paid AI call.
// If the gate can't be reached, the tool keeps working (it never breaks the tool).
// Optional Vercel setting: LW_GATE_URL (defaults to the gate in the mr-pauls-classroom project).
const GATE_URL = process.env.LW_GATE_URL || "https://mr-pauls-classroom.vercel.app/api/gate";

module.exports = async function lwGate(req, res, tool) {
  if (req.method === "OPTIONS") return true;
  const hd = req.headers || {};
  const ip = String(hd["x-forwarded-for"] || hd["x-real-ip"] || "").split(",")[0].trim();
  const body = { pass: hd["x-lw-pass"] || "", vid: hd["x-lw-vid"] || "", act: hd["x-lw-act"] === "1", ip, tool };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 2500);
  try {
    const r = await fetch(GATE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
    const j = await r.json();
    if (!j || j.ok !== false) return true;
    res.statusCode = 402;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ lwgate: j.reason || "tries", left: j.left || 0, error: "Members only" }));
    return false;
  } catch (e) {
    return true;
  } finally {
    clearTimeout(t);
  }
};
