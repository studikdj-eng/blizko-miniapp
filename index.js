const { Bot, Keyboard, InlineKeyboard } = require("grammy");

const bot = new Bot("8539481152:AAGx3v94Nfbgh_q44FaOBBVJprxmvNljs0c");

// ====== In-memory хранилища ======
const profiles = {}; // userId -> profile
const states = {};   // userId -> state
const temp = {};     // userId -> temp data during wizard

// Для ленты
const likes = {};    // userId -> Set(candidateId)  (я лайкнул)
const passes = {};   // userId -> Set(candidateId)
const matches = {};  // userId -> Set(candidateId)
const currentFeed = {}; // userId -> candidateId

// Для входящих лайков
const incomingLikes = {};   // userId -> Set(likerId)
const currentIncoming = {}; // userId -> likerId

// Для сообщений “вместе с лайком”
const pendingMessage = {}; // userId -> { candidateId }
const msgThreads = {};     // userId -> Map(withUserId -> Array<{from, text, ts}> )

// ====== Helpers ======
function setAdd(map, userId, value) {
    if (!map[userId]) map[userId] = new Set();
    map[userId].add(value);
}
function setDel(map, userId, value) {
    if (map[userId]) map[userId].delete(value);
}
function setHas(map, userId, value) {
    return map[userId] ? map[userId].has(value) : false;
}
function setSize(map, userId) {
    return map[userId] ? map[userId].size : 0;
}

function threadPush(a, b, fromId, text) {
    if (!msgThreads[a]) msgThreads[a] = new Map();
    if (!msgThreads[b]) msgThreads[b] = new Map();

    if (!msgThreads[a].has(b)) msgThreads[a].set(b, []);
    if (!msgThreads[b].has(a)) msgThreads[b].set(a, []);

    const rec = { from: fromId, text, ts: Date.now() };
    msgThreads[a].get(b).push(rec);
    msgThreads[b].get(a).push(rec);
}

// ====== Клавиатуры меню ======
const menuIncomplete = new Keyboard()
    .text("📝 Создать анкету")
    .text("ℹ️ Помощь")
    .row()
    .text("👤 Моя анкета")
    .text("🔎 Смотреть анкеты")
    .resized();

const menuComplete = new Keyboard()
    .text("🔎 Смотреть анкеты")
    .row()
    .text("👤 Моя анкета")
    .text("💌 Кто меня лайкнул")
    .row()
    .text("ℹ️ Помощь")
    .resized();

function isProfileComplete(p) {
    return !!(
        p &&
        p.name &&
        p.age &&
        p.gender &&
        Array.isArray(p.seeking) &&
        p.seeking.length > 0 &&
        p.city &&
        p.bio &&
        p.photoFileId
    );
}

function mainMenuFor(userId) {
    const p = profiles[userId];
    return isProfileComplete(p) ? menuComplete : menuIncomplete;
}

// ====== Username helpers ======
function ensureUsernameSnapshot(ctx) {
    const id = ctx.from.id;
    const u = ctx.from.username || null;
    if (!profiles[id]) profiles[id] = {};
    profiles[id].username = u;
}
function usernameOf(userId) {
    const u = profiles[userId]?.username;
    return u ? `@${u}` : null;
}

// ====== Формат профиля (ЮЗЕРНЕЙМ НЕ ПОКАЗЫВАЕМ В ПРОФИЛЕ!) ======
function genderRu(g) {
    return g === "male" ? "Парень" : g === "female" ? "Девушка" : "Пара";
}
function seekingLabelRu(x) {
    return x === "women" ? "Девушки" : x === "men" ? "Парни" : "Пары";
}
function genderToSeekingLabel(gender) {
    if (gender === "male") return "men";
    if (gender === "female") return "women";
    return "couples";
}

function profileCaption(p) {
    const who = genderRu(p.gender);
    const seek = p.seeking.map(seekingLabelRu).join(", ");
    return `${p.name}, ${p.age}\n${p.city}\n${who} • Ищу: ${seek}\n\n${p.bio}`;
}

// ====== Профиль: управление ======
function profileActionsKb() {
    return new InlineKeyboard()
        .text("🔄 Создать заново", "profile:recreate")
        .row()
        .text("✏️ Изменить текст", "profile:editbio")
        .row()
        .text("🖼 Сменить фото", "profile:changephoto")
        .row()
        .text("❌ Отмена", "profile:cancel");
}

async function sendMyProfileWithActions(ctx, userId) {
    const p = profiles[userId];
    if (!isProfileComplete(p)) {
        return ctx.reply("Анкета ещё не завершена. Нажми: 📝 Создать анкету", {
            reply_markup: mainMenuFor(userId),
        });
    }

    return ctx.replyWithPhoto(p.photoFileId, {
        caption: profileCaption(p),
        reply_markup: profileActionsKb(),
    });
}

// ====== Ограничения пола/поиска ======
function allowedSeekingOptions(gender) {
    if (gender === "male") return ["women", "couples"];
    if (gender === "female") return ["men", "couples"];
    return ["men", "women", "couples"];
}

function genderKeyboard() {
    return new InlineKeyboard()
        .text("👨 Парень", "gender:male")
        .row()
        .text("👩 Девушка", "gender:female")
        .row()
        .text("👫 Пара", "gender:couple");
}

function seekingKeyboard(gender, selectedSet) {
    const allowed = new Set(allowedSeekingOptions(gender));
    const label = (key, text) => (selectedSet.has(key) ? `✅ ${text}` : `⬜ ${text}`);

    const kb = new InlineKeyboard();
    if (allowed.has("women")) kb.text(label("women", "Девушки"), "seek:toggle:women").row();
    if (allowed.has("men")) kb.text(label("men", "Парни"), "seek:toggle:men").row();
    if (allowed.has("couples")) kb.text(label("couples", "Пары"), "seek:toggle:couples").row();
    kb.text("Готово", "seek:done");
    return kb;
}

// ====== Визард анкеты ======
function startProfileWizard(ctx) {
    const id = ctx.from.id;
    states[id] = "name";
    profiles[id] = profiles[id] || {};
    ensureUsernameSnapshot(ctx);

    const uname = profiles[id].username;
    profiles[id] = { username: uname };

    delete temp[id];

    return ctx.reply("Как тебя показать в BLIZKO? (имя/ник, минимум 2 символа)", {
        reply_markup: { remove_keyboard: true },
    });
}

// ====== Совместимость ======
function isCompatible(viewerId, candidateId) {
    const viewer = profiles[viewerId];
    const cand = profiles[candidateId];
    if (!isProfileComplete(viewer) || !isProfileComplete(cand)) return false;

    const viewerWants = new Set(viewer.seeking);
    const candWants = new Set(cand.seeking);

    const candLabel = genderToSeekingLabel(cand.gender);
    const viewerLabel = genderToSeekingLabel(viewer.gender);

    return viewerWants.has(candLabel) && candWants.has(viewerLabel);
}

// ====== ЛЕНТА ======
function feedKeyboard(candidateId) {
    return new InlineKeyboard()
        .text("❤️", `feed:like:${candidateId}`)
        .text("❌", `feed:pass:${candidateId}`)
        .row()
        .text("✉️ Написать + ❤️", `feed:msg:${candidateId}`);
}

function pickNextCandidate(viewerId) {
    const ids = Object.keys(profiles);
    for (const cidStr of ids) {
        const cid = Number(cidStr);
        if (cid === viewerId) continue;
        if (!isProfileComplete(profiles[cid])) continue;
        if (!isCompatible(viewerId, cid)) continue;
        if (setHas(likes, viewerId, cid)) continue;
        if (setHas(passes, viewerId, cid)) continue;
        return cid;
    }
    return null;
}

async function showNextInFeed(ctx, viewerId) {
    const nextId = pickNextCandidate(viewerId);
    if (!nextId) {
        delete currentFeed[viewerId];
        return ctx.reply("Пока нет подходящих анкет 🙃\nПопробуй позже.", {
            reply_markup: mainMenuFor(viewerId),
        });
    }
    currentFeed[viewerId] = nextId;
    const p = profiles[nextId];
    return ctx.replyWithPhoto(p.photoFileId, {
        caption: profileCaption(p),
        reply_markup: feedKeyboard(nextId),
    });
}

// ====== ВХОДЯЩИЕ ЛАЙКИ (БЕЗ КНОПКИ “ОТВЕТИТЬ”) ======
function incomingKeyboard(likerId) {
    return new InlineKeyboard()
        .text("❤️ Взаимно", `in:like:${likerId}`)
        .text("❌ Не интересно", `in:pass:${likerId}`);
}

function pickNextIncoming(userId) {
    const set = incomingLikes[userId];
    if (!set || set.size === 0) return null;
    for (const likerId of set) return likerId;
    return null;
}

async function showNextIncoming(ctx, userId) {
    const likerId = pickNextIncoming(userId);
    if (!likerId) {
        delete currentIncoming[userId];
        return ctx.reply("Пока нет новых лайков 🙃", { reply_markup: mainMenuFor(userId) });
    }

    if (!profiles[likerId] || !isProfileComplete(profiles[likerId])) {
        setDel(incomingLikes, userId, likerId);
        return showNextIncoming(ctx, userId);
    }

    currentIncoming[userId] = likerId;
    const p = profiles[likerId];

    const lastMsg = msgThreads[userId]?.get(likerId)?.slice(-1)[0]?.text || null;
    const extra = lastMsg ? `\n\nСообщение:\n“${lastMsg}”` : "";

    return ctx.replyWithPhoto(p.photoFileId, {
        caption: "Тебя лайкнули 💌\n\n" + profileCaption(p) + extra,
        reply_markup: incomingKeyboard(likerId),
    });
}

async function notifyNewLike(candidateId, messageText = null) {
    const count = setSize(incomingLikes, candidateId);
    const kb = new InlineKeyboard().text("💌 Посмотреть", "incoming:open");
    const msgLine = messageText ? `\n\nСообщение:\n“${messageText}”` : "";

    try {
        await bot.api.sendMessage(
            candidateId,
            `У тебя новый лайк 💌\nНажми, чтобы посмотреть (новых: ${count}).${msgLine}`,
            { reply_markup: kb }
        );
    } catch (_) { }
}

// ====== МЭТЧ: ЮЗЕРНЕЙМЫ ТОЛЬКО ПОСЛЕ ВЗАИМНОГО ❤️ ======
async function announceMatch(a, b) {
    setAdd(matches, a, b);
    setAdd(matches, b, a);

    const aU = usernameOf(a);
    const bU = usernameOf(b);

    const msgA = bU
        ? `МЭТЧ! 🎉\nЮзернейм: ${bU}`
        : `МЭТЧ! 🎉\nУ пользователя нет юзернейма.`;

    const msgB = aU
        ? `МЭТЧ! 🎉\nЮзернейм: ${aU}`
        : `МЭТЧ! 🎉\nУ пользователя нет юзернейма.`;

    try {
        await bot.api.sendMessage(a, msgA, { reply_markup: mainMenuFor(a) });
    } catch (_) { }
    try {
        await bot.api.sendMessage(b, msgB, { reply_markup: mainMenuFor(b) });
    } catch (_) { }
}

// ====== Команды ======
bot.command("start", async (ctx) => {
    ensureUsernameSnapshot(ctx);
    await ctx.reply("BLIZKO рядом 🌿\n\nЗнакомства без лишнего.", {
        reply_markup: mainMenuFor(ctx.from.id),
    });
});

bot.command("help", async (ctx) => {
    ensureUsernameSnapshot(ctx);
    await ctx.reply(
        "Команды:\n/start — начать\n/profile — мой профиль\n/search — лента анкет\n/cancel — отменить действие",
        { reply_markup: mainMenuFor(ctx.from.id) }
    );
});

bot.command("cancel", async (ctx) => {
    ensureUsernameSnapshot(ctx);
    delete states[ctx.from.id];
    delete temp[ctx.from.id];
    delete pendingMessage[ctx.from.id];
    await ctx.reply("Ок.", { reply_markup: mainMenuFor(ctx.from.id) });
});

bot.command("profile", async (ctx) => {
    ensureUsernameSnapshot(ctx);
    return sendMyProfileWithActions(ctx, ctx.from.id);
});

bot.command("search", async (ctx) => {
    ensureUsernameSnapshot(ctx);
    const me = profiles[ctx.from.id];
    if (!isProfileComplete(me)) {
        return ctx.reply("Сначала нужно завершить анкету ✅", { reply_markup: mainMenuFor(ctx.from.id) });
    }
    return showNextInFeed(ctx, ctx.from.id);
});

// ====== Меню ======
bot.hears("ℹ️ Помощь", async (ctx) =>
    ctx.reply("Напиши /start если что-то пошло не так.", { reply_markup: mainMenuFor(ctx.from.id) })
);

bot.hears("📝 Создать анкету", async (ctx) => {
    ensureUsernameSnapshot(ctx);
    const p = profiles[ctx.from.id];
    if (isProfileComplete(p)) {
        return ctx.reply("Анкета уже создана. Зайди в 👤 Моя анкета, там есть управление.", {
            reply_markup: mainMenuFor(ctx.from.id),
        });
    }
    return startProfileWizard(ctx);
});

bot.hears("👤 Моя анкета", async (ctx) => {
    ensureUsernameSnapshot(ctx);
    return sendMyProfileWithActions(ctx, ctx.from.id);
});

bot.hears("🔎 Смотреть анкеты", async (ctx) => {
    ensureUsernameSnapshot(ctx);
    const me = profiles[ctx.from.id];
    if (!isProfileComplete(me)) {
        return ctx.reply("Сначала нужно завершить анкету ✅", { reply_markup: mainMenuFor(ctx.from.id) });
    }
    return showNextInFeed(ctx, ctx.from.id);
});

bot.hears("💌 Кто меня лайкнул", async (ctx) => {
    ensureUsernameSnapshot(ctx);
    const me = profiles[ctx.from.id];
    if (!isProfileComplete(me)) {
        return ctx.reply("Сначала нужно завершить анкету ✅", { reply_markup: mainMenuFor(ctx.from.id) });
    }
    return showNextIncoming(ctx, ctx.from.id);
});

// ====== Текстовые состояния ======
bot.on("message:text", async (ctx) => {
    ensureUsernameSnapshot(ctx);

    const id = ctx.from.id;
    const state = states[id];

    // Сообщение “вместе с лайком”
    if (state === "send_like_message") {
        const payload = pendingMessage[id];
        if (!payload) {
            delete states[id];
            return ctx.reply("Что-то пошло не так. Открой ленту заново.", { reply_markup: mainMenuFor(id) });
        }

        const messageText = ctx.message.text.trim();
        if (messageText.length < 1) return ctx.reply("Напиши текст сообщением 🙂");

        const candidateId = payload.candidateId;

        // лайк + входящий
        setAdd(likes, id, candidateId);
        setAdd(incomingLikes, candidateId, id);

        // запишем текст
        threadPush(id, candidateId, id, messageText);

        delete states[id];
        delete pendingMessage[id];

        await ctx.reply("Отправил сообщение и поставил лайк ❤️", { reply_markup: mainMenuFor(id) });

        await notifyNewLike(candidateId, messageText);

        // мэтч?
        if (setHas(likes, candidateId, id)) {
            await announceMatch(id, candidateId);
            setDel(incomingLikes, id, candidateId);
            setDel(incomingLikes, candidateId, id);
        }

        return showNextInFeed(ctx, id);
    }

    if (!state) return;

    if (ctx.message.text.startsWith("/")) {
        return ctx.reply("Сейчас выполняется действие. Если хочешь выйти — /cancel", {
            reply_markup: { remove_keyboard: true },
        });
    }

    const text = ctx.message.text.trim();

    if (state === "edit_bio") {
        if (text.length <= 5) return ctx.reply("Текст анкеты должен быть больше 5 символов. Напиши ещё раз:");
        profiles[id].bio = text;
        delete states[id];
        await ctx.reply("Обновил текст ✅", { reply_markup: mainMenuFor(id) });
        return sendMyProfileWithActions(ctx, id);
    }

    if (state === "name") {
        if (text.length < 2) return ctx.reply("Имя/ник должно быть минимум 2 символа. Попробуй ещё раз:");
        profiles[id].name = text;
        states[id] = "age";
        return ctx.reply("Сколько тебе лет?");
    }

    if (state === "age") {
        const age = parseInt(text, 10);
        if (Number.isNaN(age) || age < 18 || age > 100) return ctx.reply("Введи возраст числом (18–100)");
        profiles[id].age = age;
        states[id] = "gender";
        return ctx.reply("Выбери пол:", { reply_markup: genderKeyboard() });
    }

    if (state === "gender") return ctx.reply("Выбери пол кнопками 🙂", { reply_markup: genderKeyboard() });

    if (state === "seeking") {
        const g = profiles[id]?.gender;
        const set = temp[id]?.seeking || new Set();
        return ctx.reply("Выбери, кого ты ищешь 🙂 (можно несколько)", {
            reply_markup: seekingKeyboard(g, set),
        });
    }

    if (state === "city") {
        if (text.length < 2) return ctx.reply("Город слишком короткий. Напиши нормально:");
        profiles[id].city = text;
        states[id] = "bio";
        return ctx.reply("Пару слов о себе 🙂 (больше 5 символов)");
    }

    if (state === "bio") {
        if (text.length <= 5) return ctx.reply("Описание должно быть больше 5 символов. Напиши ещё раз:");
        profiles[id].bio = text;
        states[id] = "photo";
        return ctx.reply(
            "Теперь пришли свою фотографию 📸\n\nФото обязательно. Отправь именно как *Фото* (не как файл).",
            { parse_mode: "Markdown" }
        );
    }

    if (state === "photo" || state === "edit_photo") {
        return ctx.reply("Жду фотографию 📸 (шаг обязательный).");
    }
});

// ====== Inline: профиль-управление ======
bot.callbackQuery("profile:cancel", async (ctx) => {
    ensureUsernameSnapshot(ctx);
    await ctx.answerCallbackQuery();
    await ctx.reply("Ок.", { reply_markup: mainMenuFor(ctx.from.id) });
});

bot.callbackQuery("profile:recreate", async (ctx) => {
    ensureUsernameSnapshot(ctx);
    await ctx.answerCallbackQuery();
    return startProfileWizard(ctx);
});

bot.callbackQuery("profile:editbio", async (ctx) => {
    ensureUsernameSnapshot(ctx);
    const id = ctx.from.id;
    if (!isProfileComplete(profiles[id])) {
        await ctx.answerCallbackQuery({ text: "Сначала заверши анкету.", show_alert: true });
        return;
    }
    states[id] = "edit_bio";
    await ctx.answerCallbackQuery();
    await ctx.reply("Напиши новый текст анкеты (больше 5 символов):", {
        reply_markup: { remove_keyboard: true },
    });
});

bot.callbackQuery("profile:changephoto", async (ctx) => {
    ensureUsernameSnapshot(ctx);
    const id = ctx.from.id;
    if (!isProfileComplete(profiles[id])) {
        await ctx.answerCallbackQuery({ text: "Сначала заверши анкету.", show_alert: true });
        return;
    }
    states[id] = "edit_photo";
    await ctx.answerCallbackQuery();
    await ctx.reply("Пришли новое фото 📸 (именно как Фото, не как файл).", {
        reply_markup: { remove_keyboard: true },
    });
});

// ====== Inline: выбор пола ======
bot.callbackQuery(/^gender:(male|female|couple)$/, async (ctx) => {
    ensureUsernameSnapshot(ctx);
    const id = ctx.from.id;
    if (states[id] !== "gender") {
        await ctx.answerCallbackQuery();
        return;
    }

    const gender = ctx.match[1];
    profiles[id].gender = gender;

    states[id] = "seeking";
    temp[id] = { seeking: new Set() };

    await ctx.answerCallbackQuery();
    await ctx.reply("Кого ты ищешь? (можно выбрать несколько)", {
        reply_markup: seekingKeyboard(gender, temp[id].seeking),
    });
});

// ====== Inline: кого ищет ======
bot.callbackQuery(/^seek:toggle:(women|men|couples)$/, async (ctx) => {
    ensureUsernameSnapshot(ctx);
    const id = ctx.from.id;
    if (states[id] !== "seeking") return ctx.answerCallbackQuery();

    const option = ctx.match[1];
    const gender = profiles[id].gender;
    const allowed = new Set(allowedSeekingOptions(gender));
    if (!allowed.has(option)) {
        await ctx.answerCallbackQuery({ text: "Этот вариант недоступен.", show_alert: true });
        return;
    }

    const set = temp[id]?.seeking;
    if (!set) return ctx.answerCallbackQuery();

    if (set.has(option)) set.delete(option);
    else set.add(option);

    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: seekingKeyboard(gender, set) });
});

bot.callbackQuery("seek:done", async (ctx) => {
    ensureUsernameSnapshot(ctx);
    const id = ctx.from.id;
    if (states[id] !== "seeking") {
        await ctx.answerCallbackQuery();
        return;
    }

    const set = temp[id]?.seeking;
    if (!set || set.size === 0) {
        await ctx.answerCallbackQuery({ text: "Выбери хотя бы один вариант.", show_alert: true });
        return;
    }

    profiles[id].seeking = Array.from(set);
    delete temp[id];

    states[id] = "city";
    await ctx.answerCallbackQuery();
    await ctx.reply("В каком ты городе?");
});

// ====== Фото ======
bot.on("message:photo", async (ctx) => {
    ensureUsernameSnapshot(ctx);
    const id = ctx.from.id;
    const state = states[id];
    if (state !== "photo" && state !== "edit_photo") return;

    const photos = ctx.message.photo;
    const best = photos[photos.length - 1];
    profiles[id].photoFileId = best.file_id;

    delete states[id];

    await ctx.reply("Готово ✅", { reply_markup: mainMenuFor(id) });
    return sendMyProfileWithActions(ctx, id);
});

bot.on("message:document", async (ctx) => {
    ensureUsernameSnapshot(ctx);
    const id = ctx.from.id;
    const state = states[id];
    if (state !== "photo" && state !== "edit_photo") return;
    return ctx.reply("Отправь, пожалуйста, именно как *Фото*, не как файл 📸", { parse_mode: "Markdown" });
});

// ====== ЛЕНТА: ❤️/❌/✉️+❤️ ======
bot.callbackQuery(/^feed:(like|pass|msg):(\d+)$/, async (ctx) => {
    ensureUsernameSnapshot(ctx);
    const action = ctx.match[1];
    const candidateId = Number(ctx.match[2]);
    const viewerId = ctx.from.id;

    const me = profiles[viewerId];
    if (!isProfileComplete(me)) {
        await ctx.answerCallbackQuery({ text: "Сначала заверши анкету.", show_alert: true });
        return;
    }

    if (currentFeed[viewerId] !== candidateId) {
        await ctx.answerCallbackQuery({ text: "Эта карточка уже неактуальна.", show_alert: false });
        return;
    }

    if (!profiles[candidateId] || !isProfileComplete(profiles[candidateId]) || !isCompatible(viewerId, candidateId)) {
        await ctx.answerCallbackQuery();
        return showNextInFeed(ctx, viewerId);
    }

    if (action === "pass") {
        setAdd(passes, viewerId, candidateId);
        await ctx.answerCallbackQuery({ text: "Пропуск" });
        return showNextInFeed(ctx, viewerId);
    }

    if (action === "like") {
        setAdd(likes, viewerId, candidateId);
        setAdd(incomingLikes, candidateId, viewerId);

        await ctx.answerCallbackQuery({ text: "Лайк ❤️" });
        await notifyNewLike(candidateId, null);

        // мэтч только когда второй нажал ❤️ (то есть кандидат лайкнул нас ранее)
        if (setHas(likes, candidateId, viewerId)) {
            await announceMatch(viewerId, candidateId);
            setDel(incomingLikes, viewerId, candidateId);
            setDel(incomingLikes, candidateId, viewerId);
        }

        return showNextInFeed(ctx, viewerId);
    }

    // msg
    await ctx.answerCallbackQuery();
    states[viewerId] = "send_like_message";
    pendingMessage[viewerId] = { candidateId };
    return ctx.reply("Напиши сообщение (оно уйдёт вместе с лайком ❤️).\n/cancel — отмена", {
        reply_markup: { remove_keyboard: true },
    });
});

// ====== Входящие лайки: открыть ======
bot.callbackQuery("incoming:open", async (ctx) => {
    ensureUsernameSnapshot(ctx);
    await ctx.answerCallbackQuery();
    return showNextIncoming(ctx, ctx.from.id);
});

// ====== Входящие лайки: ❤️/❌ ======
bot.callbackQuery(/^in:(like|pass):(\d+)$/, async (ctx) => {
    ensureUsernameSnapshot(ctx);
    const action = ctx.match[1];
    const likerId = Number(ctx.match[2]);
    const userId = ctx.from.id;

    if (currentIncoming[userId] !== likerId) {
        await ctx.answerCallbackQuery({ text: "Эта карточка уже неактуальна.", show_alert: false });
        return;
    }

    // удаляем из входящих
    setDel(incomingLikes, userId, likerId);

    if (action === "pass") {
        setAdd(passes, userId, likerId);
        await ctx.answerCallbackQuery({ text: "Ок" });
        return showNextIncoming(ctx, userId);
    }

    // like back => МЭТЧ (и вот тут раскрываем юзернеймы)
    setAdd(likes, userId, likerId);
    await ctx.answerCallbackQuery({ text: "Взаимно ❤️" });

    await announceMatch(userId, likerId);

    return showNextIncoming(ctx, userId);
});

bot.start();
console.log("BLIZKO bot is running...");
