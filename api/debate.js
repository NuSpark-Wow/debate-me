// Debate Me — an AI opponent that argues the other side with researched proof
// Parts (POST JSON with "part"):
//   setup    { topic, kid }                       -> frames the debate into two sides (or politely declines)
//   research { title, category, sideA, sideB, searches } -> web research (Serper + Wikipedia) -> fact sheet
//   turn     { ...debate state, action, userText } -> the debater's next line + a proof chart
//   judge    { ...debate state }                   -> neutral scorecard
// Env: ANTHROPIC_API_KEY (required), SERPER_API_KEY (for live web research),
//      CLAUDE_MODEL (debater, default Sonnet), CLAUDE_CHECK_MODEL (setup/research/judge, default Haiku)

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const FAST = process.env.CLAUDE_CHECK_MODEL || "claude-haiku-5-5";
const HOURLY_LIMIT = 80;
const hits = new Map();
const researchCache = new Map();

// Trusted sites by category. The research only looks at these (plus one open search for breadth).
const SITES = {
  sports: ["baseball-reference.com", "basketball-reference.com", "pro-football-reference.com", "hockey-reference.com", "espn.com", "mlb.com", "nba.com", "nfl.com", "wikipedia.org"],
  music: ["billboard.com", "riaa.com", "grammy.com", "rollingstone.com", "wikipedia.org"],
  movies_tv: ["boxofficemojo.com", "the-numbers.com", "imdb.com", "rottentomatoes.com", "emmys.com", "wikipedia.org"],
  history: ["britannica.com", "millercenter.org", "history.com", "loc.gov", "archives.gov", "whitehouse.gov", "wikipedia.org"],
  food_health: ["nih.gov", "cdc.gov", "fda.gov", "usda.gov", "hsph.harvard.edu", "mayoclinic.org", "clevelandclinic.org"],
  home_life: ["consumerreports.org", "thisoldhouse.com", "bobvila.com", "angi.com", "homeadvisor.com"],
  art: ["moma.org", "metmuseum.org", "vangoghmuseum.nl", "britannica.com", "artsy.net", "wikipedia.org"],
  toys_pop: ["wikipedia.org", "statista.com", "mattel.com", "americangirl.com", "nytimes.com", "variety.com"],
  tech: ["wikipedia.org", "statista.com", "britannica.com", "theverge.com"],
  kids: ["wikipedia.org", "britannica.com", "nationalgeographic.com", "kids.nationalgeographic.com"],
  other: ["wikipedia.org", "britannica.com"]
};

// What a well-rounded argument covers in each category (numbers are only one part).
const DIMENSIONS = {
  sports: "career stats AND peak dominance, clutch and postseason performance, championships, MVPs and awards, defense and all-around game, era and context (competition, rules, ballparks), impact on the game and how it changed, leadership, longevity, and what peers, coaches and Hall of Famers say",
  music: "sales and chart hits AND influence on later artists, innovation and new sounds, songwriting and musicianship, live performance, critics' all-time rankings, awards, longevity, cultural moments, and what fellow musicians say",
  movies_tv: "box office and ratings AND critics' reviews, awards, cultural impact and quotable moments, influence on later films and shows, craft (writing, acting, directing), rewatch value, longevity, and fan devotion",
  history: "concrete achievements AND leadership in crisis, lasting impact on the country or world, historians' rankings, character and values, the challenges they faced, innovation, and how they are remembered",
  food_health: "nutrition facts and health research AND taste and popularity, cost, convenience, culture and tradition, environmental impact, and what doctors and dietitians say",
  home_life: "cost AND durability, comfort, upkeep and cleaning, health and allergies, resale value, safety, style, environmental impact, and everyday convenience",
  toys_pop: "sales and popularity AND longevity, cultural impact, creativity and educational value, representation, fan community, and how it shaped kids' lives",
  tech: "specs and sales AND innovation, ease of use, ecosystem, reliability, price, cultural impact, and expert reviews",
  kids: "fun facts and numbers AND what makes it fun, what kids love about it, surprising science, and everyday life",
  other: "the key numbers AND impact and influence, expert opinion, innovation, longevity, everyday practicality, cultural moments, and how people feel about it"
};

// The personalities change the tone, never the facts.
const PERSONAS = {
  professor: "THE PROFESSOR: smart, calm, focused. Leads with data and logic. Dry wit. Phrases like \"The numbers are quite clear\" and \"Let's look at the evidence.\" Never raises his or her voice.",
  radio: "THE SPORTS-RADIO HOST: loud, feisty, passionate, playful trash talk about the ARGUMENT (never the person). Short punchy sentences, rhetorical questions, \"Are you KIDDING me?!\", \"Come ON!\", \"Folks...\". High energy.",
  drama: "THE DRAMA STAR: emotional and theatrical, takes everything personally in a fun way. Gasps, sighs, \"How DARE you!\", \"I'm wounded!\", \"Darling, please.\" Big feelings, but the facts are still right.",
  lawyer: "THE LAWYER: sharp, logical, pokes holes. \"Objection!\", \"Let the record show...\", \"Exhibit A.\" Cross-examines the user's claims with pointed questions. Precise words.",
  storyteller: "THE STORYTELLER: a warm grandparent type who argues with memories plus facts. \"Back in my day...\", \"I remember when...\". Folksy, kind, a twinkle in the eye, but stubborn on the point.",
  smooth: "THE SMOOTH TALKER: witty, charming, polite and quietly devastating. Compliments the user, then dismantles the point. \"With respect, my friend...\", \"That's adorable, but...\". Never flustered."
};
const FACES = {
  young: "a man in his 30s",
  woman: "a woman in her 40s",
  older: "a man in his 50s",
  smooth: "a man in his 40s"
};

const DECLINE_TOPICS = `DECLINE (ok=false) these: current politicians, political parties, elections or hot-button political issues (abortion, guns, immigration, etc.); religions versus each other or whether a religion is true; anything about race, ethnicity, gender or other groups being better or worse; private, non-public people; violence, weapons, drugs, sexual content, or anything harmful; tragedies. Historical leaders who died long ago (Washington, Lincoln, Caesar) are fine when the debate is about their achievements. Public figures (athletes, musicians, actors, artists) are fine when the debate is about their work.`;

// ---------- helpers ----------
async function anthropic(body) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body)
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("api_" + r.status + " " + t.slice(0, 200)); }
  return r.json();
}
async function callTool(system, tool, user, maxTokens, check, model) {
  const m = model || MODEL;
  const data = await anthropic({
    model: m, max_tokens: maxTokens, system,
    ...(/haiku/i.test(m) ? { thinking: { type: "disabled" } } : {}),
    tools: [tool], tool_choice: { type: "auto" },
    messages: [{ role: "user", content: user }]
  });
  if (data.stop_reason === "max_tokens") throw new Error("too_long");
  const block = (data.content || []).find(b => b.type === "tool_use");
  if (block && block.input && check(block.input)) return block.input;
  const txt = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
  if (s >= 0 && e > s) { const j = JSON.parse(txt.slice(s, e + 1)); if (check(j)) return j; }
  throw new Error("bad_shape");
}
async function tryTwice(fn) {
  try { return await fn(MODEL); } catch (e) { return await fn(FAST); }
}
function clip(s, n) { return String(s == null ? "" : s).slice(0, n); }
function limited(req) {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x";
  const now = Date.now(), hr = 3600e3;
  const list = (hits.get(ip) || []).filter(t => now - t < hr);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > HOURLY_LIMIT;
}

// ---------- setup ----------
const SETUP_TOOL = {
  name: "frame_debate",
  description: "Frame the user's topic as a friendly two-sided debate, or decline it.",
  input_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      reason: { type: "string", description: "If ok is false: one friendly sentence explaining, and suggest a fun alternative topic." },
      title: { type: "string", description: "Short title, e.g. 'Prince vs Michael Jackson'" },
      question: { type: "string", description: "The debate question, e.g. 'Who was the greater artist?'" },
      category: { type: "string", enum: Object.keys(SITES) },
      sideA: { type: "string", description: "Side A, short (1-5 words), e.g. 'Prince' or 'Yes, it belongs'" },
      sideB: { type: "string", description: "Side B, short (1-5 words)" },
      metrics: { type: "array", items: { type: "string" }, description: "5-6 BALANCED things to compare: about half hard numbers (e.g. 'career home runs', 'US #1 singles', 'cost per square foot') and half impact factors (e.g. 'influence on later artists', 'critics' all-time rankings', 'innovations and firsts', 'longevity', 'cultural impact', 'comfort and upkeep')" },
      searches: { type: "array", items: { type: "string" }, description: "4 short web search queries: 2 that find the key numbers for both sides, and 2 that find impact, influence, legacy, critics' rankings or expert opinion (e.g. 'Frank Sinatra influence legacy critics', 'Rolling Stone greatest singers Elvis Sinatra rank')" }
    },
    required: ["ok", "title", "question", "category", "sideA", "sideB", "metrics", "searches"]
  }
};
async function setup(body) {
  const topic = clip(body.topic, 200).trim();
  if (!topic) throw new Error("empty");
  const sys = `You set up friendly, fun debates for a family-friendly debate game (kids, adults and seniors play). Turn the user's topic into exactly two clear sides.
Decide which kind of debate the user typed, and NEVER turn a claim about one thing into a comparison with something they didn't name:
- "X vs Y" (two things named): sideA = X, sideB = Y.
- A CLAIM OR OPINION about one thing ("The Godfather is the greatest movie", "Pizza is overrated", "Jordan is the GOAT"): a FOR vs AGAINST debate. title = the claim as a question ("Is The Godfather the greatest movie ever?"), sideA = short FOR label ("Yes, it's #1"), sideB = short AGAINST label ("No, it's not"). Do not pick a rival for side B; the AGAINST side may mention rivals while arguing.
- Yes/no questions ("Is a hot dog a sandwich?", "Should Pete Rose be in the Hall of Fame?"): sides "Yes, ..." / "No, ..." in a few words.
- OPEN questions with no candidate named ("Who's the best 3rd baseman ever?", "What's the greatest movie of all time?"): pick the two strongest, most debated candidates (e.g. Mike Schmidt vs George Brett).
For FOR/AGAINST and yes/no debates, metrics and searches should cover the subject itself and how it stacks up against the field.
${DECLINE_TOPICS}
Metrics must be BALANCED for the category, never only statistics. For example, sports = stats plus clutch and postseason, championships, peak dominance, impact on the game, era context, and peers' opinions; music = sales plus influence, innovation, critics' rankings, live performance; homes and products = cost plus durability, comfort, upkeep.
Searches: 2 for the key numbers, 2 for the impact side (clutch moments, influence, legacy, critics' or experts' rankings, peer quotes).
If ok is false, still fill the other fields with a fun safe alternative topic.
Always call frame_debate.`;
  const out = await callTool(sys, SETUP_TOOL, `Topic: ${topic}${body.kid ? "\n(The player is a kid. Keep it kid-friendly.)" : ""}`, 700,
    j => typeof j.ok === "boolean" && j.sideA && j.sideB, FAST);
  out.metrics = (out.metrics || []).slice(0, 6).map(s => clip(s, 60));
  out.searches = (out.searches || []).slice(0, 4).map(s => clip(s, 120));
  return out;
}

// ---------- research ----------
async function serper(q) {
  const key = String(process.env.SERPER_API_KEY || "").trim();
  if (!key) return null;
  try {
    const r = await fetch("https://google.serper.dev/search", {
      method: "POST", signal: AbortSignal.timeout(9000),
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q, num: 8, gl: "us", hl: "en" })
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
async function wikiSummary(name) {
  try {
    const r = await fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(name.replace(/ /g, "_")), {
      signal: AbortSignal.timeout(6000), headers: { "user-agent": "DebateMe/1.0 (NuSpark educational tool)" }
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.extract || j.type === "disambiguation") return null;
    return { title: "Wikipedia: " + j.title, link: (j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) || "", snippet: j.extract.slice(0, 900) };
  } catch (e) { return null; }
}
const FACT_TOOL = {
  name: "fact_sheet",
  description: "Pull the useful, checkable facts out of the research snippets.",
  input_schema: {
    type: "object",
    properties: {
      facts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            side: { type: "string", enum: ["A", "B", "both"] },
            text: { type: "string", description: "One fact, with exact numbers and units as the source states them, plus the time frame (e.g. 'Mike Schmidt hit 548 career home runs (1972-1989).')" },
            src: { type: "integer", description: "The [S#] number of the snippet that supports it, or 0 for widely known general knowledge" }
          },
          required: ["side", "text", "src"]
        }
      }
    },
    required: ["facts"]
  }
};
async function research(body) {
  const title = clip(body.title, 120), sideA = clip(body.sideA, 60), sideB = clip(body.sideB, 60);
  const cat = SITES[body.category] ? body.category : "other";
  const ck = (title + "|" + sideA + "|" + sideB).toLowerCase();
  if (researchCache.has(ck)) return researchCache.get(ck);

  const sites = SITES[cat];
  const siteFilter = "(" + sites.map(s => "site:" + s).join(" OR ") + ")";
  const searches = (Array.isArray(body.searches) ? body.searches : []).slice(0, 4).map(s => clip(s, 120)).filter(Boolean);
  if (!searches.length) searches.push(sideA + " stats", sideB + " stats");
  const webOn = !!String(process.env.SERPER_API_KEY || "").trim();

  const jobs = searches.map(q => serper(q + " " + siteFilter));
  jobs.push(serper(title + " comparison facts"));
  const [results, wa, wb] = await Promise.all([Promise.all(jobs), wikiSummary(sideA), wikiSummary(sideB)]);

  const snips = [], seen = new Set();
  const add = (title, link, snippet) => {
    if (!snippet || snips.length >= 34) return;
    const k = (link || title) + "|" + snippet.slice(0, 40);
    if (seen.has(k)) return; seen.add(k);
    snips.push({ title: clip(title, 120), link: clip(link, 400), snippet: clip(snippet, 900) });
  };
  if (wa) add(wa.title, wa.link, wa.snippet);
  if (wb) add(wb.title, wb.link, wb.snippet);
  for (const r of results) {
    if (!r) continue;
    if (r.answerBox) add(r.answerBox.title || "Answer", r.answerBox.link || "", [r.answerBox.answer, r.answerBox.snippet].filter(Boolean).join(" "));
    if (r.knowledgeGraph && r.knowledgeGraph.attributes) {
      const kg = r.knowledgeGraph;
      add(kg.title || "Knowledge panel", kg.descriptionLink || kg.website || "", Object.entries(kg.attributes).map(([k, v]) => k + ": " + v).join("; "));
    }
    for (const o of (r.organic || []).slice(0, 6)) add(o.title, o.link, [o.snippet, ...(o.attributes ? Object.entries(o.attributes).map(([k, v]) => k + ": " + v) : [])].join(" "));
  }

  const list = snips.map((s, i) => `[S${i + 1}] ${s.title} (${s.link})\n${s.snippet}`).join("\n\n");
  const sys = `You are a careful fact checker preparing a fact sheet for a friendly debate: "${title}". Side A = ${sideA}. Side B = ${sideB}.
Pull 14-22 short, checkable facts that each side could use, BALANCED across these kinds (aim for some of each that the snippets support):
  1) numbers: records, stats, sales, chart hits, box office, prices, nutrition, survey results;
  2) impact and influence: who they inspired or changed, what came after, peer and expert quotes (with who said it);
  3) critical acclaim and rankings: critics' all-time lists, polls, honors and awards;
  4) innovation and firsts, longevity and consistency, cultural moments, practical everyday factors.
For this category, a well-rounded fact sheet covers: ${DIMENSIONS[cat]}.
RULES: Use ONLY what the snippets actually say, with exact numbers, and cite the snippet number in src. Keep numbers exactly as written. Include the time frame when known.
You may add up to 4 widely known facts with src 0 if the snippets miss something basic (e.g. dates of birth, well-known titles), but never invent statistics.
Balance: give both sides real ammunition.
Always call fact_sheet.`;
  const user = snips.length ? `RESEARCH SNIPPETS:\n\n${list}` : `No web results were available. Give 10-14 widely known, well-established facts for both sides (src 0 for all). No invented statistics; skip numbers you are not sure about.`;
  let facts = [];
  try {
    const out = await callTool(sys, FACT_TOOL, user, 2400, j => Array.isArray(j.facts), FAST);
    facts = out.facts.slice(0, 22).map((f, i) => {
      const s = f.src > 0 && snips[f.src - 1] ? snips[f.src - 1] : null;
      return { id: i + 1, side: ["A", "B", "both"].includes(f.side) ? f.side : "both", text: clip(f.text, 300), source: s ? s.title : "General knowledge", url: s ? s.link : "" };
    });
  } catch (e) { facts = []; }
  const out = { facts, web: webOn && snips.length > 0, searched: sites.slice(0, 6) };
  if (researchCache.size > 300) researchCache.clear();
  if (facts.length) researchCache.set(ck, out);
  return out;
}

// ---------- the debater's turn ----------
const TURN_TOOL = {
  name: "debate_turn",
  description: "The debater's next spoken line, plus an optional piece of proof for the screen.",
  input_schema: {
    type: "object",
    properties: {
      say: { type: "string", description: "What the debater says out loud. Plain spoken English, no markdown, no lists, no emojis, no stage directions in brackets." },
      emotion: { type: "string", enum: ["calm", "smug", "outraged", "laugh"], description: "The face to show: outraged when reacting to a bold claim, smug when landing a point, laugh at something funny or absurd, calm otherwise." },
      proof: {
        type: "object",
        description: "Proof for the screen, from the fact sheet. Use kind 'none' if nothing fits this moment.",
        properties: {
          kind: { type: "string", enum: ["compare", "bars", "line", "points", "none"], description: "compare = side A vs side B on several numeric measures; bars = one measure across several items; line = a trend over time; points = 2-4 short non-numeric proof cards (critics' rankings, expert or peer quotes, influence, firsts and innovations, honors, cultural moments, longevity)" },
          title: { type: "string", description: "Short title, e.g. 'Career numbers' or 'What the experts say'" },
          caption: { type: "string", description: "One short line: what this proves, from the debater's point of view" },
          rows: {
            type: "array",
            description: "compare: [{label, a, b, unit}] (a = side A value, b = side B value). bars/line: [{label, value, unit}]. points: [{label, text, side}] (label = 2-4 word heading like 'Critics agree', text = the fact in one sentence, side = 'A' or 'B'). 3-6 rows for compare and bars, 4-10 for line, 2-4 for points.",
            items: {
              type: "object",
              properties: {
                label: { type: "string" }, a: { type: "number" }, b: { type: "number" }, value: { type: "number" }, unit: { type: "string" },
                lower_is_better: { type: "boolean", description: "true when a smaller number wins (calories, cost, errors, ERA, a ranking position)" },
                text: { type: "string" }, side: { type: "string", enum: ["A", "B"] }
              },
              required: ["label"]
            }
          },
          fact_ids: { type: "array", items: { type: "integer" }, description: "The fact sheet ids the proof came from" }
        },
        required: ["kind"]
      },
      used_fact_ids: { type: "array", items: { type: "integer" }, description: "Fact ids the spoken line relies on" }
    },
    required: ["say", "emotion", "proof"]
  }
};
const BALANCE = `ARGUE ON MANY FRONTS, NOT JUST NUMBERS. Great debaters mix hard data with the bigger picture. Across the debate, rotate through different kinds of proof and don't lean on one stat type:
  numbers (records, sales, stats, prices) • impact and influence (who they changed, who they inspired, what came after) • innovation and firsts • critical acclaim and expert rankings • honors and awards • longevity and consistency • cultural moments and how people felt • practical everyday factors (for products and lifestyle topics: cost, comfort, durability, health, upkeep).
  Each turn, bring at least one point from a DIFFERENT dimension than your last turn. Use "points" proof cards for non-numeric proof, and charts for numbers.`;
const ACTIONS = {
  open: "OPENING STATEMENT. Introduce yourself in one quick line (your name and that you're taking your side), make your 2 strongest points from two DIFFERENT dimensions (for example one stat and one about impact), show proof, and end by challenging the user to respond.",
  reply: "The user just made their argument (below). React to it in character, take apart the weakest part, add one new point for your side from a dimension you haven't used yet, and end with a short challenge question back to them. If they made a genuinely good point, admit it briefly and gracefully, then pivot.",
  proof: "The user said 'Show me proof.' Back up your most recent claim: proof is required here (a chart for numbers, or points cards for rankings, quotes or influence), and your line should walk through what it shows.",
  source: "The user asked 'Where's that from?' Say plainly where your recent claims come from, naming the actual sources from the fact sheet (e.g. Baseball-Reference, Billboard, Wikipedia). If a point was general knowledge rather than a sourced fact, admit it honestly. Keep proof kind 'none' unless re-showing the same proof helps.",
  unfair: "The user says your argument is not fair and explains why (below). Take the objection seriously: if they have a point (era, context, missing measure, cherry-picked stat), concede that part honestly, then argue why your side still wins on balance.",
  challenge_proof: "The user is challenging one of your proofs (below). Defend it or refine it honestly: explain what it does and doesn't show, add context, and if useful show better proof.",
  switch: "SWITCH! You are now arguing the OTHER side (shown below as your side). Make a funny, good-natured remark about switching, then argue your new side just as hard with proof, and challenge the user, who now defends your old side.",
  closing: "CLOSING STATEMENT. Sum up your best 2 points (ideally one number and one about impact) in a punchy closing, thank the user for a great debate in character, and leave the verdict to the judge. Proof kind 'none'."
};
// Watch mode: two AI debaters argue while the user watches (and can moderate).
const WATCH_ACTIONS = {
  open: "OPENING STATEMENT. Introduce yourself in one quick line, make your 2 strongest points from two DIFFERENT dimensions, show proof, and end by challenging your opponent by name.",
  rebut_open: "Your opponent just opened. Introduce yourself in one quick line, answer the weakest part of their opening, then make your 2 strongest points from different dimensions, with proof. End with a jab or question to your opponent by name.",
  reply: "Respond to your opponent's last turn. Knock down the weakest part, then add one new point from a dimension you haven't used yet, with proof when it helps. If they made a genuinely good point, give them brief credit, then pivot. End with a jab or a question for them.",
  moderator: "The MODERATOR (the person watching) just jumped in with a question or comment (below). If it's a question, answer it directly and honestly for your side. If it's a comment or challenge, respond to it head-on (agree where they're right). Then give one strong reason for your side and a quick good-natured jab at your opponent.",
  closing: "CLOSING STATEMENT. Sum up your best 2 points (ideally one number and one about impact), tip your hat to your opponent graciously in character, and leave the verdict to the judge. Proof kind 'none'."
};
async function turn(body) {
  const persona = PERSONAS[body.persona] ? body.persona : "professor";
  const face = FACES[body.face] ? body.face : "young";
  const name = clip(body.name || "your opponent", 30);
  const watch = !!body.opponentName;
  const opp = clip(body.opponentName || "", 30);
  const oppPersona = PERSONAS[body.opponentPersona] ? body.opponentPersona : null;
  const aiSide = body.aiSide === "B" ? "B" : "A";
  const sideA = clip(body.sideA, 60), sideB = clip(body.sideB, 60);
  const mine = aiSide === "A" ? sideA : sideB, theirs = aiSide === "A" ? sideB : sideA;
  const TABLE = watch ? WATCH_ACTIONS : ACTIONS;
  const action = TABLE[body.action] ? body.action : "reply";
  const kid = !!body.kid;
  const facts = (Array.isArray(body.facts) ? body.facts : []).slice(0, 26)
    .map(f => `#${parseInt(f.id) || 0} [${f.side === "A" ? sideA : f.side === "B" ? sideB : "both"}] ${clip(f.text, 300)} (source: ${clip(f.source, 80)})`).join("\n");
  const label = h => h.who === "ai" ? name.toUpperCase() : h.who === "mod" ? "MODERATOR" : (watch ? opp.toUpperCase() : "USER");
  const history = (Array.isArray(body.history) ? body.history : []).slice(-10).map(h => label(h) + ": " + clip(h.text, 700)).join("\n");
  const them = watch ? opp : "the user";

  const sys = `You are ${name}, ${FACES[face]}, a debater in "Debate Me", a fun family-friendly debate game. ${watch
    ? `You are debating ${opp}, another debater${oppPersona ? " (" + PERSONAS[oppPersona].split(":")[0] + ")" : ""}, out loud while an audience watches. Talk to ${opp} directly by name sometimes.`
    : "You debate the user out loud, and your proof appears on a screen next to you."}
DEBATE: ${clip(body.title, 120)}. Question: ${clip(body.question, 160)}
YOUR SIDE: ${mine}. ${watch ? opp.toUpperCase() + "'S SIDE" : "THE USER'S SIDE"}: ${theirs}.

YOUR PERSONALITY: ${PERSONAS[persona]}

${BALANCE}
  FOR THIS TOPIC, the dimensions that matter are: ${DIMENSIONS[DIMENSIONS[body.category] ? body.category : "other"]}.

THE RULES THAT NEVER CHANGE:
- Feisty is fine, mean is never fine. Tease the argument, never the person. No insults, no profanity, nothing about ${them}'s intelligence, looks or identity.
- Facts first. Every number you say or chart must come from the FACT SHEET below. Never invent statistics, quotes or rankings. If you lack a number, argue with reasons, history, influence or examples instead, and say "I don't have the exact number" if pushed.
- Charts: only use numbers from the fact sheet, list their ids in fact_ids. Use real values exactly as the facts state them: a batting average of .305 is 0.305 (never 305), 45% is 45 with unit "%", $1.2 billion is 1200000000 with unit "$". Give 3-5 rows when the facts allow. For "compare", a = ${sideA}'s value and b = ${sideB}'s value (always in that order, no matter which side you're on). Each row is one measure with the same unit for both. Points cards must also come from the fact sheet.
- Be honest: if ${them} lands a good point, give credit in a sentence (in character), then fight back.
- Spoken length: ${watch ? "45-90" : "55-110"} words. Short sentences that sound great out loud. No lists, no markdown, no emojis, no bracketed stage directions. Write numbers as a person would say them.
${kid ? "- KID MODE: a child is playing or watching. Be extra gentle and silly-fun, simple words, no sarcasm that could sting.\n" : ""}- Stay on this debate. If things go off-topic, steer back with a joke.
- You are an AI playing a character; if asked, say so honestly.

FACT SHEET:
${facts || "(no facts available: argue with well-known reasons and examples only, and use proof kind 'none')"}

Always respond by calling debate_turn.`;
  const said = body.userText ? `\n\n${watch ? "THE MODERATOR ASKS" : "THE USER SAYS"}: "${clip(body.userText, 800)}"` : "";
  const user = `${history ? "THE DEBATE SO FAR:\n" + history + "\n\n" : ""}NOW: ${TABLE[action]}${said}\n(Round ${parseInt(body.round) || 1}.)`;

  const out = await tryTwice(m => callTool(sys, TURN_TOOL, user, 1400, j => typeof j.say === "string" && j.say.length > 5, m));
  out.say = clip(out.say, 1200).replace(/\*|#|\[[^\]]*\]/g, "").trim();
  if (!["calm", "smug", "outraged", "laugh"].includes(out.emotion)) out.emotion = "calm";
  out.proof = cleanProof(out.proof, body.facts);
  return out;
}
function cleanProof(p, facts) {
  if (!p || !["compare", "bars", "line", "points"].includes(p.kind) || !Array.isArray(p.rows)) return { kind: "none" };
  const ids = (Array.isArray(p.fact_ids) ? p.fact_ids : []).map(n => parseInt(n)).filter(n => n > 0).slice(0, 12);
  if (p.kind === "points") {
    const rows = p.rows.slice(0, 4).map(r => ({ label: clip(r.label, 40), text: clip(r.text, 200), side: r.side === "B" ? "B" : "A" })).filter(r => r.text);
    if (rows.length < 1) return { kind: "none" };
    return { kind: "points", title: clip(p.title, 70), caption: clip(p.caption, 140), rows, fact_ids: ids, checked: null };
  }
  const num = v => (typeof v === "number" && isFinite(v)) ? v : null;
  let rows = p.rows.slice(0, p.kind === "line" ? 12 : 6).map(r => p.kind === "compare"
    ? { label: clip(r.label, 40), a: num(r.a), b: num(r.b), unit: clip(r.unit, 20), low: !!r.lower_is_better }
    : { label: clip(r.label, 40), value: num(r.value), unit: clip(r.unit, 20) });
  rows = rows.filter(r => p.kind === "compare" ? (r.a !== null && r.b !== null) : r.value !== null);
  if (rows.length < (p.kind === "line" ? 3 : 2) && !(p.kind === "compare" && rows.length >= 1)) return { kind: "none" };
  // Honesty check: do the chart's numbers actually appear in the fact sheet?
  const text = (Array.isArray(facts) ? facts : []).map(f => String(f.text || "")).join(" ").replace(/,/g, "");
  const nums = []; rows.forEach(r => [r.a, r.b, r.value].forEach(v => { if (v !== null && v !== undefined) nums.push(v); }));
  const found = nums.filter(v => {
    const s = String(v), s2 = Number.isInteger(v) ? s : String(+v.toFixed(Math.abs(v) < 1 ? 3 : 1));
    const s3 = Math.abs(v) < 1 ? s2.replace(/^(-?)0\./, "$1.") : null; // .305 written without the 0
    return new RegExp("(^|[^0-9.])" + s2.replace(".", "\\.") + "([^0-9]|$)").test(text) || (s3 && new RegExp(s3.replace(".", "\\.") + "([^0-9]|$)").test(text)) || (v >= 1e6 && text.includes(String(+(v / 1e6).toFixed(1)))) || (v >= 1e9 && text.includes(String(+(v / 1e9).toFixed(1))));
  }).length;
  return { kind: p.kind, title: clip(p.title, 70), caption: clip(p.caption, 140), rows, fact_ids: ids, checked: nums.length ? found / nums.length : 0 };
}

// ---------- judge ----------
const JUDGE_TOOL = {
  name: "scorecard",
  description: "A fair, fun scorecard for the debate.",
  input_schema: {
    type: "object",
    properties: {
      you: { type: "object", properties: { evidence: { type: "integer" }, logic: { type: "integer" }, style: { type: "integer" } }, required: ["evidence", "logic", "style"] },
      ai: { type: "object", properties: { evidence: { type: "integer" }, logic: { type: "integer" }, style: { type: "integer" } }, required: ["evidence", "logic", "style"] },
      winner: { type: "string", enum: ["you", "ai", "tie"] },
      verdict: { type: "string", description: "2-3 fun, fair sentences announcing the result, spoken by a game-show judge. Plain text." },
      best_you: { type: "string", description: "The first debater's best moment, one sentence" },
      best_ai: { type: "string", description: "The second debater's best moment, one sentence" },
      tip: { type: "string", description: "One friendly tip (to the user if they debated; otherwise a fun takeaway for the audience)" }
    },
    required: ["you", "ai", "winner", "verdict", "best_you", "best_ai", "tip"]
  }
};
async function judge(body) {
  const watch = !!body.nameA;
  const name = clip(body.name || "the opponent", 30), nA = clip(body.nameA || "", 30), nB = clip(body.nameB || "", 30);
  const label = h => watch ? (h.who === "A" ? nA.toUpperCase() : h.who === "B" ? nB.toUpperCase() : "MODERATOR") : (h.who === "user" ? "USER" : name.toUpperCase());
  const history = (Array.isArray(body.history) ? body.history : []).slice(-20).map(h => label(h) + ": " + clip(h.text, 700)).join("\n");
  const sys = watch
    ? `You are the neutral, good-humored judge of "Debate Me", a family-friendly debate game. Debate: ${clip(body.title, 120)}. ${nA} argued ${clip(body.sideA, 60)}; ${nB} argued ${clip(body.sideB, 60)}. Both are AI characters; an audience watched.
In the scorecard, "you" = ${nA} and "ai" = ${nB}. Score each from 1-10 on EVIDENCE (facts, numbers AND impact proof), LOGIC (answering the other side, reasoning) and STYLE (persuasion, clarity, fun).
Judge the arguments, not which side you personally prefer. Reward balance: debaters who mixed numbers with impact, influence and context should beat one-note stat dumps. Ties are allowed.
Always call scorecard.`
    : `You are the neutral, good-humored judge of "Debate Me", a family-friendly debate game. Debate: ${clip(body.title, 120)}. The user argued their side against ${name} (an AI).
Score each from 1-10 on EVIDENCE (facts, numbers AND impact proof), LOGIC (answering the other side, reasoning) and STYLE (persuasion, clarity, fun).
BE FAIR: the AI had a research fact sheet, so reward the user for good reasoning, real-world knowledge and answering the AI's points. Short user replies can still score well if they were sharp. Do not reward the AI just for having more numbers. Ties are allowed.
${body.kid ? "The player is a child: be warm and encouraging, and find something real to praise." : ""}
Always call scorecard.`;
  const out = await callTool(sys, JUDGE_TOOL, `TRANSCRIPT:\n${history}`, 900, j => j.you && j.ai && j.verdict, FAST);
  const fix = o => ({ evidence: Math.max(1, Math.min(10, parseInt(o.evidence) || 5)), logic: Math.max(1, Math.min(10, parseInt(o.logic) || 5)), style: Math.max(1, Math.min(10, parseInt(o.style) || 5)) });
  out.you = fix(out.you); out.ai = fix(out.ai);
  const ty = out.you.evidence + out.you.logic + out.you.style, ta = out.ai.evidence + out.ai.logic + out.ai.style;
  out.winner = ty > ta ? "you" : ta > ty ? "ai" : "tie";
  return out;
}

// ---------- handler ----------
module.exports = async (req, res) => {
  if (req.method === "GET") {
    return res.json({ ok: true, anthropic_key_set: !!process.env.ANTHROPIC_API_KEY, serper_key_set: !!String(process.env.SERPER_API_KEY || "").trim(), model: MODEL, fast_model: FAST });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "missing_key" });
  if (limited(req)) return res.status(429).json({ error: "slow_down", message: "That was a lot of debating! Take a short break and come back soon." });
  const body = req.body || {};
  try {
    if (body.part === "setup") return res.json(await setup(body));
    if (body.part === "research") return res.json(await research(body));
    if (body.part === "turn") return res.json(await turn(body));
    if (body.part === "judge") return res.json(await judge(body));
    return res.status(400).json({ error: "unknown_part" });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: "failed", message: "The debate hit a snag. Please try again." });
  }
};
