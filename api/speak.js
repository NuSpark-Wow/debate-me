// Debate Me voices — ElevenLabs text-to-speech with word timing (for the read-along caption)
// Env: ELEVENLABS_API_KEY (required for real voices; without it the page uses the browser voice)
// Optional voice swaps: VOICE_YOUNG, VOICE_WOMAN, VOICE_OLDER, VOICE_SMOOTH, VOICE_JUDGE, ELEVENLABS_MODEL
// Only the debater's own words are sent here. No visitor audio ever reaches this server.

const VOICES = {
  young: process.env.VOICE_YOUNG || "bIHbv24MWmeRgasZH58o",   // Will - young American man
  woman: process.env.VOICE_WOMAN || "XrExE9yKIg1WjnnlVkGX",   // Matilda - confident alto
  older: process.env.VOICE_OLDER || "pqHfZKP75CvOlQylNhV4",   // Bill - wise, mature
  smooth: process.env.VOICE_SMOOTH || "cjVigY5qzO86Huf0OWal", // Eric - smooth, 40s
  judge: process.env.VOICE_JUDGE || "SAz9YHcvj6GT2YYXdXww"    // River - neutral announcer
};
// Each personality gets its own delivery: lower stability = more emotional and punchy.
const STYLE = {
  professor:   { stability: 0.62, style: 0.15, speed: 0.97 },
  radio:       { stability: 0.28, style: 0.75, speed: 1.08 },
  drama:       { stability: 0.25, style: 0.85, speed: 1.0 },
  lawyer:      { stability: 0.5,  style: 0.35, speed: 1.03 },
  storyteller: { stability: 0.6,  style: 0.3,  speed: 0.93 },
  smooth:      { stability: 0.55, style: 0.45, speed: 0.98 },
  judge:       { stability: 0.5,  style: 0.4,  speed: 1.0 }
};
const cache = new Map();

module.exports = async (req, res) => {
  const key = process.env.ELEVENLABS_API_KEY;
  if (req.method === "GET") {
    const out = { api_key_set: !!key, voices: VOICES };
    if (key) {
      try {
        const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICES.young}?output_format=mp3_22050_32`, {
          method: "POST", headers: { "xi-api-key": key, "content-type": "application/json" },
          body: JSON.stringify({ text: "Hi.", model_id: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5" })
        });
        out.voice = r.ok ? "working" : `error ${r.status}: ${(await r.text()).slice(0, 200)}`;
      } catch (e) { out.voice = "error: " + e.message; }
    }
    return res.json(out);
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!key) return res.status(501).json({ error: "voice_off" });
  const b = req.body || {};
  const face = VOICES[b.face] ? b.face : "young";
  const persona = STYLE[b.persona] ? b.persona : (face === "judge" ? "judge" : "professor");
  const text = String(b.text || "").trim().slice(0, 1500);
  if (!text) return res.status(400).json({ error: "empty" });
  const st = STYLE[persona];
  const ck = face + "|" + persona + "|" + text;
  if (cache.has(ck)) return res.json(cache.get(ck));
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICES[face]}/with-timestamps?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
        voice_settings: { stability: st.stability, similarity_boost: 0.8, style: st.style, speed: st.speed, use_speaker_boost: true }
      })
    });
    if (!r.ok) return res.status(502).json({ error: "voice_failed" });
    const d = await r.json();
    const out = { audio: d.audio_base64, alignment: d.alignment || d.normalized_alignment || null };
    if (cache.size > 150) cache.clear();
    cache.set(ck, out);
    return res.json(out);
  } catch (e) {
    return res.status(502).json({ error: "voice_failed" });
  }
};
