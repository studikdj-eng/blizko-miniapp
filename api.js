const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Проверка, что сервер жив
app.get("/", (req, res) => {
    res.send("BLIZKO API is running ✅");
});

// Заглушка: список чатов для Mini App
app.get("/api/chats", (req, res) => {
    const userId = req.query.userId || "unknown";

    res.json({
        ok: true,
        userId,
        chats: [
            {
                chatId: "c1",
                name: "Алиса",
                last: "Окей 🙂",
                expiresAt: Date.now() + 1000 * 60 * 60 * 5,
                avatarText: "А",
                messages: [
                    { from: "other", text: "Привет. Всё без лишнего?", ts: Date.now() - 1000 * 60 * 10 },
                    { from: "me", text: "Да. Давай коротко.", ts: Date.now() - 1000 * 60 * 9 }
                ]
            }
        ]
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`API running on http://localhost:${PORT}`);
});
