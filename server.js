const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());

// ===== Serve Mini App =====
app.use(express.static(path.join(__dirname, "public")));

// ===== In-memory store (MVP) =====
const TTL_MS = 24 * 60 * 60 * 1000;

// usersChats: userId -> Set(chatId)
const usersChats = new Map();

// chats: chatId -> { chatId, name, avatarText, expiresAt, last, messages: [{from,text,ts}] }
const chats = new Map();

// ===== Helpers =====
function now() { return Date.now(); }

function ensureDemoForUser(userId) {
  // чтобы у тебя сразу что-то показывалось, пока нет связки с мэтчами
  // позже это удалим и будем создавать чаты по мэтчу из бота
  if (usersChats.has(String(userId))) return;

  const uid = String(userId);
  usersChats.set(uid, new Set());

  const c1 = {
    chatId: `demo_${uid}_1`,
    name: "Алиса",
    avatarText: "А",
    expiresAt: now() + TTL_MS,
    last: "Окей, тогда сегодня без спешки 🙂",
    messages: [
      { from: "other", text: "Привет. У тебя тоже всё быстро и по делу?", ts: now() - 1000*60*18 },
      { from: "me", text: "Да. Давай без долгих анкет. Ты где примерно?", ts: now() - 1000*60*17 },
    ],
  };

  const c2 = {
    chatId: `demo_${uid}_2`,
    name: "Катя",
    avatarText: "К",
    expiresAt: now() + 2 * 60 * 60 * 1000,
    last: "Ты в каком районе? Я рядом.",
    messages: [
      { from: "other", text: "Ты в каком районе?", ts: now() - 1000*60*8 },
      { from: "me", text: "Пока дома. Минут через 30 могу выйти.", ts: now() - 1000*60*7 },
    ],
  };

  for (const c of [c1, c2]) {
    chats.set(c.chatId, c);
    usersChats.get(uid).add(c.chatId);
  }
}

function cleanupExpired() {
  const t = now();
  for (const [chatId, c] of chats.entries()) {
    if ((c.expiresAt ?? 0) <= t) {
      chats.delete(chatId);
      for (const set of usersChats.values()) set.delete(chatId);
    }
  }
}

setInterval(cleanupExpired, 60 * 1000).unref();

// ===== API =====
app.get("/api/chats", (req, res) => {
  cleanupExpired();
  const userId = String(req.query.userId || "");
  if (!userId) return res.status(400).json({ ok: false, error: "userId required" });

  ensureDemoForUser(userId);

  const ids = usersChats.get(userId) ? Array.from(usersChats.get(userId)) : [];
  const out = ids
    .map(id => chats.get(id))
    .filter(Boolean)
    .map(c => ({
      chatId: c.chatId,
      name: c.name,
      avatarText: c.avatarText,
      expiresAt: c.expiresAt,
      last: c.messages?.length ? c.messages[c.messages.length - 1].text : (c.last || ""),
    }))
    .sort((a,b) => a.expiresAt - b.expiresAt);

  res.json({ ok: true, chats: out });
});

app.get("/api/messages", (req, res) => {
  cleanupExpired();
  const userId = String(req.query.userId || "");
  const chatId = String(req.query.chatId || "");
  if (!userId || !chatId) return res.status(400).json({ ok: false, error: "userId and chatId required" });

  const set = usersChats.get(userId);
  if (!set || !set.has(chatId)) return res.status(403).json({ ok: false, error: "no access" });

  const c = chats.get(chatId);
  if (!c) return res.status(404).json({ ok: false, error: "chat not found" });

  res.json({ ok: true, expiresAt: c.expiresAt, messages: c.messages || [] });
});

app.post("/api/send", (req, res) => {
  cleanupExpired();
  const userId = String(req.body?.userId || "");
  const chatId = String(req.body?.chatId || "");
  const text = String(req.body?.text || "").trim();

  if (!userId || !chatId || !text) return res.status(400).json({ ok: false, error: "userId, chatId, text required" });
  if (text.length < 1 || text.length > 500) return res.status(400).json({ ok: false, error: "text length invalid" });

  const set = usersChats.get(userId);
  if (!set || !set.has(chatId)) return res.status(403).json({ ok: false, error: "no access" });

  const c = chats.get(chatId);
  if (!c) return res.status(404).json({ ok: false, error: "chat not found" });

  if ((c.expiresAt ?? 0) <= now()) return res.status(410).json({ ok: false, error: "chat expired" });

  c.messages = c.messages || [];
  c.messages.push({ from: "me", text, ts: now() });
  c.last = text;

  // демо-ответ “другой стороны”
  setTimeout(() => {
    const cc = chats.get(chatId);
    if (!cc) return;
    if ((cc.expiresAt ?? 0) <= now()) return;
    const answers = ["Окей 🙂","Понял. Давай так.","Коротко и ясно.","Когда тебе удобно?","Давай ближе к вечеру."];
    const reply = answers[Math.floor(Math.random() * answers.length)];
    cc.messages.push({ from: "other", text: reply, ts: now() });
    cc.last = reply;
  }, 900);

  res.json({ ok: true });
});

// Health
app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BLIZKO web+api listening on :${PORT}`));
