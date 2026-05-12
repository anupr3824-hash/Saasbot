====FILE: .gitignore====
node_modules/
.env
*.mp3


====FILE: index.js====
require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const mongoose = require("mongoose");
const axios = require("axios");
const gTTS = require("gtts");
const fs = require("fs");
const cron = require("node-cron");
const http = require("http");
const User = require("./models/User");

// ═══════════════════════════════════════════════
//  BOT & DB SETUP
// ═══════════════════════════════════════════════

const bot = new Telegraf(process.env.BOT_TOKEN);

mongoose
    .connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch((err) => console.error("❌ MongoDB Error:", err));

// ═══════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════

const PLANS = {
    silver: {
        name: "🥉 Silver",
        price: 49,
        coins: 500,
        days: 30,
        unlimited: false,
    },
    gold: {
        name: "🥈 Gold",
        price: 99,
        coins: 1500,
        days: 30,
        unlimited: false,
    },
    platinum: {
        name: "🥇 Platinum",
        price: 199,
        coins: 99999,
        days: 30,
        unlimited: true,
    },
};

const FORCE_CHANNELS = [
    { name: "GrowMate Official", username: "@growmateofficial" },
    { name: "Okane",             username: "@okane3"           },
    { name: "Anaya",             username: "@anaya_6l"         },
    { name: "Akira",             username: "@akira8ok"         },
    { name: "Advanced AI Tool",  username: "@advancedaitool"   },
    { name: "Big Offers",        username: "@bigoffers8o"      },
];

const UPI_ID = process.env.UPI_ID || "yourname@upi";
const ADMIN_ID = Number(process.env.ADMIN_ID);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════
//  HELPER FUNCTIONS
// ═══════════════════════════════════════════════

function isAdmin(ctx) {
    return Number(ctx.from.id) === ADMIN_ID;
}

function pendingPaymentKeyboard(userId, plan) {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "✅ Approve", callback_data: `approve_${userId}_${plan}` },
                    { text: "❌ Reject",  callback_data: `reject_${userId}_${plan}`  },
                ],
            ],
        },
    };
}

async function requireChannels(ctx) {
    if (Number(ctx.from.id) === ADMIN_ID) return true;
    const notJoined = [];
    for (const ch of FORCE_CHANNELS) {
        try {
            const member = await ctx.telegram.getChatMember(ch.username, ctx.from.id);
            if (member.status === "left" || member.status === "kicked") {
                notJoined.push(ch);
            }
        } catch (e) {
            notJoined.push(ch);
        }
    }
    if (notJoined.length === 0) return true;
    const buttons = notJoined.map((ch) => [
        { text: `➡️ ${ch.name} Join Karo`, url: `https://t.me/${ch.username.replace("@", "")}` },
    ]);
    buttons.push([{ text: "🔄 Maine Sab Join Kar Liya", callback_data: "check_all_join" }]);
    await ctx.reply(
        `⚠️ Bot use karne ke liye pehle yeh channels join karo!\n\n` +
        `✅ Joined: ${FORCE_CHANNELS.length - notJoined.length}/${FORCE_CHANNELS.length}\n` +
        `❌ Baki: ${notJoined.length}\n\n` +
        `👇 Neeche diye channels join karo:`,
        { reply_markup: { inline_keyboard: buttons } }
    );
    return false;
}

async function checkPremium(user) {
    if (!user) return;
    if (user.premium && user.premiumExpires) {
        if (new Date() > user.premiumExpires) {
            user.premium = false;
            user.premiumPlan = null;
            user.premiumExpires = null;
            await user.save();
            try {
                await bot.telegram.sendMessage(
                    user.telegramId,
                    "⚠️ Aapka premium expire ho gaya hai.\nRenew karne ke liye /buy use karein."
                );
            } catch (e) {}
        }
    }
}

async function getOrCreateUser(ctx) {
    let user = await User.findOne({ telegramId: ctx.from.id });
    if (!user) {
        user = new User({
            telegramId: ctx.from.id,
            username: ctx.from.username || "",
            firstName: ctx.from.first_name || "",
            payments: [],
            memory: [],
        });
        await user.save();
    }
    let needsSave = false;
    if (!user.payments) { user.payments = []; needsSave = true; }
    if (!user.memory)   { user.memory = [];   needsSave = true; }
    if (needsSave) await user.save();
    return user;
}

async function deductCoins(user, amount) {
    if (user.premium) return true;
    if (user.coins < amount) return false;
    user.coins -= amount;
    return true;
}

async function callAI(prompt) {
    const response = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
            model: "openai/gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
        },
        {
            headers: {
                Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
            },
            timeout: 30000,
        }
    );
    return response.data.choices[0].message.content;
}

// ═══════════════════════════════════════════════
//  MIDDLEWARE — Ban Check
// ═══════════════════════════════════════════════

bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    try {
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (user && user.banned) {
            return ctx.reply(`🚫 Aap ban hain.\nReason: ${user.banReason || "Violation of rules"}`);
        }
    } catch (e) {}
    return next();
});

// ═══════════════════════════════════════════════
//  /start
// ═══════════════════════════════════════════════

bot.start(async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const referrerId = ctx.startPayload;
        let user = await User.findOne({ telegramId: ctx.from.id });
        let isNew = false;

        if (!user) {
            isNew = true;
            user = new User({
                telegramId: ctx.from.id,
                username: ctx.from.username || "",
                firstName: ctx.from.first_name || "",
                payments: [],
                memory: [],
            });

            if (referrerId && Number(referrerId) !== ctx.from.id) {
                const refUser = await User.findOne({ telegramId: Number(referrerId) });
                if (refUser && !refUser.banned) {
                    refUser.coins += 20;
                    refUser.referrals += 1;
                    refUser.totalEarned += 20;
                    await refUser.save();
                    user.referredBy = Number(referrerId);
                    user.coins += 10;
                    user.totalEarned += 10;
                    try {
                        await bot.telegram.sendMessage(
                            refUser.telegramId,
                            `🎉 Naya referral!\n\n👤 ${ctx.from.first_name} aapke link se join kiya!\n💰 +20 Coins mile!\n\nTotal Coins: ${refUser.coins}`
                        );
                    } catch (e) {}
                }
            }
            await user.save();
        }

        if (!user.payments) { user.payments = []; await user.save(); }
        if (!user.memory)   { user.memory = [];   await user.save(); }

        const inviteLink = `https://t.me/${ctx.botInfo.username}?start=${ctx.from.id}`;

        await ctx.reply(
            `🚀 Welcome ${ctx.from.first_name}!${isNew ? " 🎉 (New User)" : ""}\n\n` +
            `💰 Coins: ${user.coins}\n` +
            `👥 Referrals: ${user.referrals}\n` +
            `👑 Premium: ${user.premium ? `✅ (${user.premiumPlan})` : "❌"}\n\n` +
            `🔗 Invite Link:\n${inviteLink}\n\n` +
            `📋 /menu — Tools kholein\n` +
            `📚 /help — Sabhi commands`,
            Markup.keyboard([
                ["🤖 AI Chat", "🖼 Image"],
                ["✍ Caption", "#️⃣ Hashtags"],
                ["🎬 Reel Ideas", "🎥 Scripts"],
                ["🎤 Voice", "🖼 Thumbnail"],
                ["💼 Marketing", "💰 Balance"],
                ["📜 History", "🎁 Daily"],
                ["🏆 Leaderboard", "👥 Invite"],
                ["👑 Premium", "🛒 Buy"],
            ]).resize()
        );
    } catch (err) {
        console.error("/start error:", err);
        ctx.reply("❌ Error. /start dobara try karein.");
    }
});

// ═══════════════════════════════════════════════
//  /ping
// ═══════════════════════════════════════════════

bot.command("ping", (ctx) => ctx.reply("🏓 Pong! Bot online hai ✅"));

// ═══════════════════════════════════════════════
//  /menu
// ═══════════════════════════════════════════════

bot.command("menu", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    ctx.reply(
        `🚀 GrowMate AI — Main Menu\n\nEk tool choose karein:`,
        Markup.inlineKeyboard([
            [Markup.button.callback("🤖 AI Chat", "menu_ai"), Markup.button.callback("🖼 Image", "menu_image")],
            [Markup.button.callback("✍ Caption", "menu_caption"), Markup.button.callback("#️⃣ Hashtags", "menu_hashtags")],
            [Markup.button.callback("🎬 Reel Ideas", "menu_reel"), Markup.button.callback("🎥 Script", "menu_script")],
            [Markup.button.callback("🎤 Voice", "menu_voice"), Markup.button.callback("🖼 Thumbnail", "menu_thumb")],
            [Markup.button.callback("💼 Marketing", "menu_marketing"), Markup.button.callback("🏢 Business Name", "menu_biz")],
            [Markup.button.callback("🎨 Logo Idea", "menu_logo"), Markup.button.callback("💰 Balance", "menu_balance")],
            [Markup.button.callback("🎁 Daily Reward", "menu_daily"), Markup.button.callback("👥 Invite", "menu_invite")],
            [Markup.button.callback("🏆 Leaderboard", "menu_lead"), Markup.button.callback("👑 Premium", "menu_premium")],
        ])
    );
});

bot.action("menu_ai",        (ctx) => { ctx.answerCbQuery(); ctx.reply("Use:\n/ai your question here"); });
bot.action("menu_image",     (ctx) => { ctx.answerCbQuery(); ctx.reply("Use:\n/image futuristic sneaker"); });
bot.action("menu_caption",   (ctx) => { ctx.answerCbQuery(); ctx.reply("Use:\n/caption nike shoes"); });
bot.action("menu_hashtags",  (ctx) => { ctx.answerCbQuery(); ctx.reply("Use:\n/hashtags gym content"); });
bot.action("menu_reel",      (ctx) => { ctx.answerCbQuery(); ctx.reply("Use:\n/reelidea fitness motivation"); });
bot.action("menu_script",    (ctx) => { ctx.answerCbQuery(); ctx.reply("Use:\n/script gym transformation"); });
bot.action("menu_voice",     (ctx) => { ctx.answerCbQuery(); ctx.reply("Use:\n/voice Hello world"); });
bot.action("menu_thumb",     (ctx) => { ctx.answerCbQuery(); ctx.reply("Use:\n/thumbnail gym motivation"); });
bot.action("menu_marketing", (ctx) => { ctx.answerCbQuery(); ctx.reply("Use:\n/marketing sneaker brand"); });
bot.action("menu_biz",       (ctx) => { ctx.answerCbQuery(); ctx.reply("Use:\n/businessname sneaker brand"); });
bot.action("menu_logo",      (ctx) => { ctx.answerCbQuery(); ctx.reply("Use:\n/logoidea sneaker brand"); });
bot.action("menu_balance",   (ctx) => { ctx.answerCbQuery(); ctx.reply("/balance"); });
bot.action("menu_daily",     (ctx) => { ctx.answerCbQuery(); ctx.reply("/daily"); });
bot.action("menu_lead",      (ctx) => { ctx.answerCbQuery(); ctx.reply("/leaderboard"); });
bot.action("menu_premium",   (ctx) => { ctx.answerCbQuery(); ctx.reply("/premium"); });
bot.action("menu_invite", async (ctx) => {
    ctx.answerCbQuery();
    const link = `https://t.me/${ctx.botInfo.username}?start=${ctx.from.id}`;
    ctx.reply(`🔗 Your Invite Link:\n\n${link}\n\n👥 Invite karo, coins kamao!\n💰 Per referral: +20 coins`);
});

// ═══════════════════════════════════════════════
//  CHECK_ALL_JOIN — Force Join Button Handler
// ═══════════════════════════════════════════════

bot.action("check_all_join", async (ctx) => {
    await ctx.answerCbQuery();
    const notJoined = [];
    for (const ch of FORCE_CHANNELS) {
        try {
            const member = await ctx.telegram.getChatMember(ch.username, ctx.from.id);
            if (member.status === "left" || member.status === "kicked") notJoined.push(ch);
        } catch (e) {
            notJoined.push(ch);
        }
    }
    if (notJoined.length > 0) {
        const buttons = notJoined.map((ch) => [
            { text: `➡️ ${ch.name} Join Karo`, url: `https://t.me/${ch.username.replace("@", "")}` },
        ]);
        buttons.push([{ text: "🔄 Dobara Check Karo", callback_data: "check_all_join" }]);
        return ctx.editMessageText(
            `❌ Abhi bhi ${notJoined.length} channels baaki hain!\n\n` +
            `✅ Joined: ${FORCE_CHANNELS.length - notJoined.length}/${FORCE_CHANNELS.length}\n` +
            `❌ Baki: ${notJoined.length}`,
            { reply_markup: { inline_keyboard: buttons } }
        );
    }
    ctx.editMessageText("✅ Sab channels join ho gaye!\n\nAb /start karo 🚀");
});

// ═══════════════════════════════════════════════
//  /ai
// ═══════════════════════════════════════════════

bot.command("ai", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const user = await getOrCreateUser(ctx);
        await checkPremium(user);
        const userMessage = ctx.message.text.replace("/ai", "").trim();
        if (!userMessage) return ctx.reply("Example:\n/ai What is dropshipping?");
        const ok = await deductCoins(user, 1);
        if (!ok) return ctx.reply("💰 Coins nahi hain!\n/daily se earn karo ya /buy se premium lo.");
        const memoryText = (user.memory || []).map((m) => `User: ${m.user}\nAI: ${m.ai}`).join("\n");
        const mode = user.mode || "normal";
        const prompt = `You are a helpful AI assistant in ${mode} mode.\n\nPrevious conversation:\n${memoryText}\n\nUser: ${userMessage}`;
        await ctx.reply("🤖 Soch raha hoon...");
        const text = await callAI(prompt);
        user.memory.push({ user: userMessage, ai: text });
        if (user.memory.length > 5) user.memory.shift();
        await user.save();
        ctx.reply(`${text}\n\n💰 Coins Left: ${user.coins}`);
    } catch (err) {
        console.error("/ai:", err.response?.data || err.message);
        ctx.reply("❌ AI Error. Dobara try karein.");
    }
});

// ═══════════════════════════════════════════════
//  /daily
// ═══════════════════════════════════════════════

bot.command("daily", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const user = await getOrCreateUser(ctx);
        await checkPremium(user);
        const now = new Date();
        if (user.lastDaily) {
            const hours = (now - user.lastDaily) / (1000 * 60 * 60);
            if (hours < 24) {
                const remaining = Math.ceil(24 - hours);
                return ctx.reply(`⏳ Aaj ka reward le chuke ho!\n\n⏰ ${remaining} ghante baad wapas ao.`);
            }
        }
        const reward = user.premium ? 25 : 10;
        user.coins += reward;
        user.totalEarned += reward;
        user.lastDaily = now;
        await user.save();
        ctx.reply(
            `🎁 Daily Reward Mila!\n\n` +
            `💰 +${reward} Coins ${user.premium ? "(Premium Bonus!)" : ""}\n\n` +
            `Total Coins: ${user.coins}\n\n` +
            `💡 Tip: Dost invite karo, +20 coins per referral!`
        );
    } catch (err) {
        console.error("/daily:", err);
        ctx.reply("❌ Error");
    }
});

// ═══════════════════════════════════════════════
//  /balance
// ═══════════════════════════════════════════════

bot.command("balance", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const user = await getOrCreateUser(ctx);
        await checkPremium(user);
        const inviteLink = `https://t.me/${ctx.botInfo.username}?start=${ctx.from.id}`;
        ctx.reply(
            `💼 ${ctx.from.first_name} ka Wallet\n\n` +
            `💰 Coins: ${user.coins}\n` +
            `📈 Total Earned: ${user.totalEarned}\n` +
            `👥 Referrals: ${user.referrals}\n` +
            `👑 Premium: ${user.premium ? `✅ ${user.premiumPlan} (Expires: ${user.premiumExpires?.toLocaleDateString("en-IN")})` : "❌ None"}\n\n` +
            `🔗 Invite Link:\n${inviteLink}`
        );
    } catch (err) {
        console.error("/balance:", err);
        ctx.reply("❌ Error");
    }
});

// ═══════════════════════════════════════════════
//  /invite
// ═══════════════════════════════════════════════

bot.command("invite", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    const user = await getOrCreateUser(ctx);
    const inviteLink = `https://t.me/${ctx.botInfo.username}?start=${ctx.from.id}`;
    ctx.reply(
        `🔗 Tumhara Invite Link:\n\n${inviteLink}\n\n` +
        `💰 Per Referral: +20 coins (tumhe) +10 coins (unhe)\n` +
        `👥 Total Referrals: ${user.referrals}\n\n` +
        `🏆 Leaderboard mein top banao: /leaderboard`
    );
});

// ═══════════════════════════════════════════════
//  /caption
// ═══════════════════════════════════════════════

bot.command("caption", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const user = await getOrCreateUser(ctx);
        await checkPremium(user);
        const topic = ctx.message.text.replace("/caption", "").trim();
        if (!topic) return ctx.reply("Example:\n/caption nike shoes");
        const ok = await deductCoins(user, 2);
        if (!ok) return ctx.reply("💰 Coins nahi hain! /daily ya /buy");
        await user.save();
        await ctx.reply("✍ Captions likh raha hoon...");
        const text = await callAI(`Generate 5 viral Instagram captions for: ${topic}\nAdd emojis and hashtags. Make them engaging.`);
        ctx.reply(`${text}\n\n💰 Coins Left: ${user.coins}`);
    } catch (err) {
        console.error("/caption:", err.response?.data || err.message);
        ctx.reply("❌ Caption Error");
    }
});

// ═══════════════════════════════════════════════
//  /hashtags
// ═══════════════════════════════════════════════

bot.command("hashtags", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const user = await getOrCreateUser(ctx);
        await checkPremium(user);
        const topic = ctx.message.text.replace("/hashtags", "").trim();
        if (!topic) return ctx.reply("Example:\n/hashtags gym content");
        const ok = await deductCoins(user, 2);
        if (!ok) return ctx.reply("💰 Coins nahi hain! /daily ya /buy");
        await user.save();
        await ctx.reply("🔍 Hashtags dhundh raha hoon...");
        const text = await callAI(`Generate 30 viral Instagram hashtags for: ${topic}\nOnly hashtags, separated by spaces.`);
        ctx.reply(`${text}\n\n💰 Coins Left: ${user.coins}`);
    } catch (err) {
        console.error("/hashtags:", err.response?.data || err.message);
        ctx.reply("❌ Hashtag Error");
    }
});

// ═══════════════════════════════════════════════
//  /reelidea
// ═══════════════════════════════════════════════

bot.command("reelidea", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const user = await getOrCreateUser(ctx);
        await checkPremium(user);
        const topic = ctx.message.text.replace("/reelidea", "").trim();
        if (!topic) return ctx.reply("Example:\n/reelidea gym motivation");
        const ok = await deductCoins(user, 2);
        if (!ok) return ctx.reply("💰 Coins nahi hain! /daily ya /buy");
        await user.save();
        await ctx.reply("💡 Reel ideas generate ho rahe hain...");
        const text = await callAI(`Generate 10 viral Instagram reel ideas for: ${topic}\nInclude hooks, captions, and engagement tips.`);
        ctx.reply(`${text}\n\n💰 Coins Left: ${user.coins}`);
    } catch (err) {
        console.error("/reelidea:", err.response?.data || err.message);
        ctx.reply("❌ Reel Idea Error");
    }
});

// ═══════════════════════════════════════════════
//  /script
// ═══════════════════════════════════════════════

bot.command("script", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const user = await getOrCreateUser(ctx);
        await checkPremium(user);
        const topic = ctx.message.text.replace("/script", "").trim();
        if (!topic) return ctx.reply("Example:\n/script gym transformation");
        const ok = await deductCoins(user, 2);
        if (!ok) return ctx.reply("💰 Coins nahi hain! /daily ya /buy");
        await user.save();
        await ctx.reply("🎬 Viral script likh raha hoon...");
        const text = await callAI(`Write a viral short video script for: ${topic}\nInclude: Hook, Scene ideas, Voiceover, CTA. Style: Instagram Reels/TikTok.`);
        ctx.reply(`${text}\n\n💰 Coins Left: ${user.coins}`);
    } catch (err) {
        console.error("/script:", err.response?.data || err.message);
        ctx.reply("❌ Script Error");
    }
});

// ═══════════════════════════════════════════════
//  /businessname
// ═══════════════════════════════════════════════

bot.command("businessname", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const user = await getOrCreateUser(ctx);
        await checkPremium(user);
        const topic = ctx.message.text.replace("/businessname", "").trim();
        if (!topic) return ctx.reply("Example:\n/businessname sneaker brand");
        const ok = await deductCoins(user, 1);
        if (!ok) return ctx.reply("💰 Coins nahi hain! /daily ya /buy");
        await user.save();
        await ctx.reply("🏢 Business names generate ho rahe hain...");
        const text = await callAI(`Generate 20 unique, modern, brandable business names for: ${topic}. Make them catchy and memorable.`);
        ctx.reply(`${text}\n\n💰 Coins Left: ${user.coins}`);
    } catch (err) {
        console.error("/businessname:", err.response?.data || err.message);
        ctx.reply("❌ Business Name Error");
    }
});

// ═══════════════════════════════════════════════
//  /logoidea
// ═══════════════════════════════════════════════

bot.command("logoidea", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const user = await getOrCreateUser(ctx);
        await checkPremium(user);
        const topic = ctx.message.text.replace("/logoidea", "").trim();
        if (!topic) return ctx.reply("Example:\n/logoidea sneaker brand");
        const ok = await deductCoins(user, 2);
        if (!ok) return ctx.reply("💰 Coins nahi hain! /daily ya /buy");
        await user.save();
        await ctx.reply("🎨 Logo ideas create ho rahe hain...");
        const text = await callAI(`Generate creative logo design ideas for: ${topic}\nInclude colors, style, shapes and branding concept.`);
        ctx.reply(`${text}\n\n💰 Coins Left: ${user.coins}`);
    } catch (err) {
        console.error("/logoidea:", err.response?.data || err.message);
        ctx.reply("❌ Logo Idea Error");
    }
});

// ═══════════════════════════════════════════════
//  /marketing
// ═══════════════════════════════════════════════

bot.command("marketing", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const user = await getOrCreateUser(ctx);
        await checkPremium(user);
        const topic = ctx.message.text.replace("/marketing", "").trim();
        if (!topic) return ctx.reply("Example:\n/marketing sneaker business");
        const ok = await deductCoins(user, 1);
        if (!ok) return ctx.reply("💰 Coins nahi hain! /daily ya /buy");
        await user.save();
        await ctx.reply("📈 Marketing strategy ban rahi hai...");
        const text = await callAI(`Create a complete marketing strategy for: ${topic}\nInclude: Instagram strategy, Reel ideas, Hooks, Paid ads plan, Growth hacks, Target audience.`);
        ctx.reply(`${text}\n\n💰 Coins Left: ${user.coins}`);
    } catch (err) {
        console.error("/marketing:", err.response?.data || err.message);
        ctx.reply("❌ Marketing Error");
    }
});

// ═══════════════════════════════════════════════
//  /image
// ═══════════════════════════════════════════════

bot.command("image", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const user = await getOrCreateUser(ctx);
        await checkPremium(user);
        const prompt = ctx.message.text.replace("/image", "").trim();
        if (!prompt) return ctx.reply("Example:\n/image futuristic nike shoes");
        const ok = await deductCoins(user, 2);
        if (!ok) return ctx.reply("💰 Coins nahi hain! /daily ya /buy");
        await user.save();
        await ctx.reply("🎨 Image generate ho rahi hai...");
        const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
        await ctx.replyWithPhoto(
            { url: imageUrl },
            { caption: `🖼 Prompt: ${prompt}\n\n💰 Coins Left: ${user.coins}` }
        );
    } catch (err) {
        console.error("/image:", err);
        ctx.reply("❌ Image Error. Dobara try karein.");
    }
});

// ═══════════════════════════════════════════════
//  /logo
// ═══════════════════════════════════════════════

bot.command("logo", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const user = await getOrCreateUser(ctx);
        await checkPremium(user);
        const prompt = ctx.message.text.replace("/logo", "").trim();
        if (!prompt) return ctx.reply("Example:\n/logo sneaker brand");
        const ok = await deductCoins(user, 2);
        if (!ok) return ctx.reply("💰 Coins nahi hain! /daily ya /buy");
        await user.save();
        await ctx.reply("🎨 AI Logo design ho raha hai...");
        const fullPrompt = `modern professional logo for ${prompt}, clean minimalist vector design, white background, branding`;
        const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(fullPrompt)}?nologo=true`;
        await ctx.replyWithPhoto(
            { url: imageUrl },
            { caption: `🔥 AI Logo Ready!\n\n🏷 Brand: ${prompt}\n\n💰 Coins Left: ${user.coins}` }
        );
    } catch (err) {
        console.error("/logo:", err);
        ctx.reply("❌ Logo Error");
    }
});

// ═══════════════════════════════════════════════
//  /thumbnail
// ═══════════════════════════════════════════════

bot.command("thumbnail", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const user = await getOrCreateUser(ctx);
        await checkPremium(user);
        const topic = ctx.message.text.replace("/thumbnail", "").trim();
        if (!topic) return ctx.reply("Example:\n/thumbnail gym motivation");
        const ok = await deductCoins(user, 3);
        if (!ok) return ctx.reply("💰 Coins nahi hain! /daily ya /buy");
        await user.save();
        await ctx.reply("🖼 Thumbnail generate ho rahi hai...");
        const prompt = `eye-catching YouTube thumbnail for: ${topic}, bold text overlay, vibrant colors, high contrast, professional design, cinematic`;
        const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1280&height=720&nologo=true`;
        await ctx.replyWithPhoto(
            { url: imageUrl },
            { caption: `🔥 Thumbnail Ready!\n\n🎬 Topic: ${topic}\n\n💰 Coins Left: ${user.coins}` }
        );
    } catch (err) {
        console.error("/thumbnail:", err);
        ctx.reply("❌ Thumbnail Error");
    }
});

// ═══════════════════════════════════════════════
//  /voice
// ═══════════════════════════════════════════════

bot.command("voice", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const user = await getOrCreateUser(ctx);
        await checkPremium(user);
        const text = ctx.message.text.replace("/voice", "").trim();
        if (!text) return ctx.reply("Example:\n/voice Hello everyone welcome back");
        const ok = await deductCoins(user, 2);
        if (!ok) return ctx.reply("💰 Coins nahi hain! /daily ya /buy");
        await user.save();
        await ctx.reply("🎤 Voice generate ho rahi hai...");
        const fileName = `voice_${Date.now()}.mp3`;
        const gtts = new gTTS(text, "en");
        gtts.save(fileName, async (err) => {
            if (err) {
                console.error("gTTS error:", err);
                return ctx.reply("❌ Voice Error");
            }
            try {
                await ctx.replyWithVoice({ source: fileName });
            } catch (e) {
                console.error("sendVoice error:", e);
            }
            if (fs.existsSync(fileName)) fs.unlinkSync(fileName);
        });
    } catch (err) {
        console.error("/voice:", err);
        ctx.reply("❌ Voice Error");
    }
});

// ═══════════════════════════════════════════════
//  /mode
// ═══════════════════════════════════════════════

bot.command("mode", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const args = ctx.message.text.split(" ");
        const allowedModes = ["creator", "business", "coder", "gym", "normal", "motivator"];
        if (args.length < 2) {
            return ctx.reply(
                `🎭 AI Mode Select Karo:\n\n` +
                `🎬 creator — Content creator ke liye\n` +
                `💼 business — Business advice ke liye\n` +
                `💻 coder — Coding help ke liye\n` +
                `🏋 gym — Fitness tips ke liye\n` +
                `💪 motivator — Motivation ke liye\n` +
                `😎 normal — General mode\n\n` +
                `Example: /mode creator`
            );
        }
        const selectedMode = args[1].toLowerCase();
        if (!allowedModes.includes(selectedMode)) return ctx.reply("❌ Invalid mode. /mode dekho.");
        const user = await getOrCreateUser(ctx);
        user.mode = selectedMode;
        await user.save();
        ctx.reply(`✅ AI Mode Changed!\n\n🚀 Current Mode: ${selectedMode}\n\nAb /ai use karo!`);
    } catch (err) {
        console.error("/mode:", err);
        ctx.reply("❌ Mode Error");
    }
});

// ═══════════════════════════════════════════════
//  /history
// ═══════════════════════════════════════════════

bot.command("history", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const user = await getOrCreateUser(ctx);
        if (!user.memory || user.memory.length === 0) return ctx.reply("📭 Koi history nahi mili.");
        let historyText = "📜 Last Conversations:\n\n";
        user.memory.forEach((m, i) => {
            historyText += `#${i + 1}\n👤 You: ${m.user}\n🤖 AI: ${m.ai.substring(0, 100)}...\n\n`;
        });
        ctx.reply(historyText);
    } catch (err) {
        console.error("/history:", err);
        ctx.reply("❌ History Error");
    }
});

// ═══════════════════════════════════════════════
//  /clearmemory
// ═══════════════════════════════════════════════

bot.command("clearmemory", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const user = await getOrCreateUser(ctx);
        user.memory = [];
        await user.save();
        ctx.reply("🗑 AI memory clear ho gayi!");
    } catch (err) {
        ctx.reply("❌ Error");
    }
});

// ═══════════════════════════════════════════════
//  /leaderboard
// ═══════════════════════════════════════════════

bot.command("leaderboard", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const topUsers = await User.find({ banned: false }).sort({ referrals: -1 }).limit(10);
        if (topUsers.length === 0) return ctx.reply("Abhi koi data nahi hai.");
        const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
        let text = "🏆 Top Referrers Leaderboard\n\n";
        topUsers.forEach((u, i) => {
            text += `${medals[i]} ${u.firstName || u.username || "User"} — ${u.referrals} referrals | ${u.coins} coins\n`;
        });
        text += "\n👥 Invite karo, top mein ao: /invite";
        ctx.reply(text);
    } catch (err) {
        console.error("/leaderboard:", err);
        ctx.reply("❌ Leaderboard Error");
    }
});

// ═══════════════════════════════════════════════
//  /premium
// ═══════════════════════════════════════════════

bot.command("premium", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    ctx.reply(
        `👑 PREMIUM PLANS\n\n` +
        `🥉 Silver — ₹49/month\n   • 500 Coins\n   • Priority AI\n   • Daily +25 coins\n\n` +
        `🥈 Gold — ₹99/month\n   • 1500 Coins\n   • Priority AI\n   • Daily +25 coins\n\n` +
        `🥇 Platinum — ₹199/month\n   • Unlimited Access\n   • No coin deduction\n   • Priority AI\n   • Daily +25 coins\n\n` +
        `📲 Purchase: /buy`,
        Markup.inlineKeyboard([
            [Markup.button.callback("🥉 Silver ₹49", "buy_silver")],
            [Markup.button.callback("🥈 Gold ₹99", "buy_gold")],
            [Markup.button.callback("🥇 Platinum ₹199", "buy_platinum")],
        ])
    );
});

// ═══════════════════════════════════════════════
//  /buy
// ═══════════════════════════════════════════════

bot.command("buy", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    ctx.reply(
        `💳 Premium Kharidne ke liye plan choose karo:`,
        Markup.inlineKeyboard([
            [Markup.button.callback("🥉 Silver — ₹49/month", "buy_silver")],
            [Markup.button.callback("🥈 Gold — ₹99/month", "buy_gold")],
            [Markup.button.callback("🥇 Platinum — ₹199/month", "buy_platinum")],
        ])
    );
});

bot.action("buy_silver", (ctx) => {
    ctx.answerCbQuery();
    ctx.reply(
        `🥉 Silver Plan — ₹49/month\n\n` +
        `📲 UPI se pay karo:\n🔗 UPI ID: \`${UPI_ID}\`\n💰 Amount: ₹49\n\n` +
        `📸 Payment ke baad screenshot yahan bhejo.\n` +
        `Admin verify karega aur premium activate ho jayega!\n\n` +
        `⚠️ Note: Pehle neeche button dabao, phir screenshot bhejo.`,
        { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("✅ Maine pay kar diya", "paid_silver")]]) }
    );
});

bot.action("buy_gold", (ctx) => {
    ctx.answerCbQuery();
    ctx.reply(
        `🥈 Gold Plan — ₹99/month\n\n` +
        `📲 UPI se pay karo:\n🔗 UPI ID: \`${UPI_ID}\`\n💰 Amount: ₹99\n\n` +
        `📸 Payment ke baad screenshot yahan bhejo.\n\n` +
        `⚠️ Note: Pehle neeche button dabao, phir screenshot bhejo.`,
        { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("✅ Maine pay kar diya", "paid_gold")]]) }
    );
});

bot.action("buy_platinum", (ctx) => {
    ctx.answerCbQuery();
    ctx.reply(
        `🥇 Platinum Plan — ₹199/month\n\n` +
        `📲 UPI se pay karo:\n🔗 UPI ID: \`${UPI_ID}\`\n💰 Amount: ₹199\n\n` +
        `📸 Payment ke baad screenshot yahan bhejo.\n\n` +
        `⚠️ Note: Pehle neeche button dabao, phir screenshot bhejo.`,
        { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("✅ Maine pay kar diya", "paid_platinum")]]) }
    );
});

bot.action(/^paid_(.+)$/, async (ctx) => {
    ctx.answerCbQuery();
    const plan = ctx.match[1];
    if (!PLANS[plan]) return ctx.reply("❌ Invalid plan");
    try {
        const user = await getOrCreateUser(ctx);
        user.payments = user.payments.filter(
            (p) => !(p.plan === plan && p.status === "awaiting_screenshot")
        );
        user.payments.push({
            plan: plan,
            amount: PLANS[plan].price,
            status: "awaiting_screenshot",
        });
        await user.save();
        ctx.reply(
            `📸 Ab ${PLANS[plan].name} plan (₹${PLANS[plan].price}) ka payment screenshot bhejo.\n\n` +
            `Admin verify karega — 1-6 ghante mein activate hoga.\n\n` +
            `📊 Status check: /mystatus`
        );
    } catch (err) {
        console.error("paid_ action error:", err);
        ctx.reply("❌ Error. Dobara try karo.");
    }
});

// ═══════════════════════════════════════════════
//  PHOTO HANDLER
// ═══════════════════════════════════════════════

bot.on("photo", async (ctx) => {
    try {
        if (!ADMIN_ID || isNaN(ADMIN_ID)) {
            return ctx.reply("❌ Admin setup nahi hai. Owner se contact karo.");
        }
        const user = await getOrCreateUser(ctx);
        const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        const pendingPayment = user.payments.find(
            (p) => p.status === "awaiting_screenshot" || p.status === "pending"
        );
        if (pendingPayment) {
            pendingPayment.screenshotFileId = fileId;
            pendingPayment.status = "pending";
            await user.save();
            const plan = PLANS[pendingPayment.plan];
            const caption =
                `📸 NEW PAYMENT REQUEST!\n\n` +
                `👤 Name: ${ctx.from.first_name}\n` +
                `🆔 User ID: ${ctx.from.id}\n` +
                `📱 Username: @${ctx.from.username || "N/A"}\n` +
                `👑 Plan: ${plan?.name || pendingPayment.plan}\n` +
                `💰 Amount: ₹${plan?.price || "?"}\n` +
                `📅 Time: ${new Date().toLocaleString("en-IN")}\n\n` +
                `👇 Action lo:`;
            await ctx.telegram.sendPhoto(ADMIN_ID, fileId, {
                caption: caption,
                reply_markup: pendingPaymentKeyboard(ctx.from.id, pendingPayment.plan).reply_markup,
            });
            await ctx.reply(
                `✅ Screenshot receive hua!\n\n` +
                `👑 Plan: ${plan?.name || pendingPayment.plan}\n` +
                `💰 Amount: ₹${plan?.price || "?"}\n` +
                `⏳ Admin 1-6 ghante mein verify karega.\n\n` +
                `📊 Status check: /mystatus`
            );
        } else {
            await ctx.telegram.sendPhoto(ADMIN_ID, fileId, {
                caption:
                    `📸 Screenshot Received (No Active Payment)\n\n` +
                    `👤 Name: ${ctx.from.first_name}\n` +
                    `🆔 ID: ${ctx.from.id}\n` +
                    `📱 @${ctx.from.username || "N/A"}\n` +
                    `📅 ${new Date().toLocaleString("en-IN")}`,
                reply_markup: {
                    inline_keyboard: [[{ text: "💬 Message User", url: `tg://user?id=${ctx.from.id}` }]],
                },
            });
            await ctx.reply(
                `⚠️ Koi active payment plan nahi mila.\n\n` +
                `Sahi tarika:\n` +
                `1️⃣ /buy se plan select karo\n` +
                `2️⃣ "Maine pay kar diya" button dabao\n` +
                `3️⃣ Screenshot bhejo`
            );
        }
    } catch (err) {
        console.error("❌ Photo handler error:", err.message);
        ctx.reply("❌ Screenshot bhejne mein error aaya. Dobara try karo.");
    }
});

// ═══════════════════════════════════════════════
//  ADMIN — Approve / Reject
// ═══════════════════════════════════════════════

bot.action(/^approve_(\d+)_(.+)$/, async (ctx) => {
    if (Number(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery("❌ Sirf admin kar sakta hai");
    const userId = Number(ctx.match[1]);
    const planKey = ctx.match[2];
    const plan = PLANS[planKey];
    if (!plan) return ctx.answerCbQuery("❌ Invalid plan");
    try {
        const user = await User.findOne({ telegramId: userId });
        if (!user) return ctx.answerCbQuery("❌ User not found");
        if (!user.payments) user.payments = [];
        const payment = user.payments.find(
            (p) => p.plan === planKey && (p.status === "pending" || p.status === "awaiting_screenshot")
        );
        if (payment) { payment.status = "approved"; payment.processedAt = new Date(); }
        user.premium = true;
        user.premiumPlan = planKey;
        user.premiumExpires = new Date(Date.now() + plan.days * 24 * 60 * 60 * 1000);
        if (!plan.unlimited) { user.coins += plan.coins; user.totalEarned += plan.coins; }
        await user.save();
        try {
            const oldCaption = ctx.callbackQuery.message.caption || "";
            await ctx.editMessageCaption(
                oldCaption + `\n\n✅ APPROVED ✅\n👮 Admin: ${ctx.from.first_name}\n⏰ ${new Date().toLocaleString("en-IN")}`,
                { reply_markup: { inline_keyboard: [] } }
            );
        } catch (e) {}
        await ctx.answerCbQuery("✅ Payment Approved!");
        await bot.telegram.sendMessage(
            userId,
            `🎉 Premium Activate Ho Gaya!\n\n👑 Plan: ${plan.name}\n💰 Coins Added: ${plan.unlimited ? "Unlimited" : plan.coins}\n📅 Expires: ${user.premiumExpires.toLocaleDateString("en-IN")}\n\nEnjoy karo! 🚀\n/menu`
        );
    } catch (err) {
        console.error("Approve error:", err.message);
        ctx.answerCbQuery("❌ Error aaya");
    }
});

bot.action(/^reject_(\d+)_(.+)$/, async (ctx) => {
    if (Number(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery("❌ Sirf admin kar sakta hai");
    const userId = Number(ctx.match[1]);
    const planKey = ctx.match[2];
    try {
        const user = await User.findOne({ telegramId: userId });
        if (user) {
            if (!user.payments) user.payments = [];
            const payment = user.payments.find(
                (p) => p.plan === planKey && (p.status === "pending" || p.status === "awaiting_screenshot")
            );
            if (payment) { payment.status = "rejected"; payment.processedAt = new Date(); }
            await user.save();
        }
        try {
            const oldCaption = ctx.callbackQuery.message.caption || "";
            await ctx.editMessageCaption(
                oldCaption + `\n\n❌ REJECTED ❌\n👮 Admin: ${ctx.from.first_name}\n⏰ ${new Date().toLocaleString("en-IN")}`,
                { reply_markup: { inline_keyboard: [] } }
            );
        } catch (e) {}
        await ctx.answerCbQuery("❌ Payment Rejected");
        await bot.telegram.sendMessage(userId, `❌ Payment Reject Ho Gaya.\n\nReason: Payment verify nahi hua ya screenshot clear nahi tha.\n\nDobara try karo: /buy`);
    } catch (err) {
        console.error("Reject error:", err.message);
        ctx.answerCbQuery("❌ Error aaya");
    }
});

// ═══════════════════════════════════════════════
//  /mystatus
// ═══════════════════════════════════════════════

bot.command("mystatus", async (ctx) => {
    if (!await requireChannels(ctx)) return;
    try {
        const user = await getOrCreateUser(ctx);
        await checkPremium(user);
        if (!user.payments || user.payments.length === 0) return ctx.reply("📭 Koi payment history nahi hai.\n/buy se premium lo.");
        let text = "💳 Payment History:\n\n";
        const last5 = user.payments.slice(-5).reverse();
        last5.forEach((p, i) => {
            const status =
                p.status === "approved" ? "✅ Approved" :
                p.status === "rejected" ? "❌ Rejected" :
                p.status === "pending"  ? "⏳ Pending"  : "📤 Screenshot awaited";
            text += `#${i + 1} ${PLANS[p.plan]?.name || p.plan} — ₹${p.amount}\n   Status: ${status}\n   Date: ${p.createdAt?.toLocaleDateString("en-IN") || "N/A"}\n\n`;
        });
        text += `\n👑 Premium: ${user.premium ? `✅ Active (${user.premiumPlan})` : "❌ Inactive"}`;
        ctx.reply(text);
    } catch (err) {
        console.error("/mystatus:", err);
        ctx.reply("❌ Error");
    }
});

// ═══════════════════════════════════════════════
//  /help
// ═══════════════════════════════════════════════

bot.command("help", (ctx) => {
    ctx.reply(
        `📚 GrowMate AI — All Commands\n\n` +
        `🤖 AI Tools\n/ai [question]\n/mode\n/history\n/clearmemory\n\n` +
        `🖼 Image Tools\n/image [prompt]\n/logo [brand]\n/thumbnail [topic]\n\n` +
        `📱 Creator Tools\n/caption [topic]\n/hashtags [topic]\n/reelidea [topic]\n/script [topic]\n\n` +
        `🎤 Media\n/voice [text]\n\n` +
        `💼 Business\n/businessname [niche]\n/logoidea [niche]\n/marketing [niche]\n\n` +
        `💰 Wallet\n/balance\n/daily\n/invite\n/leaderboard\n\n` +
        `👑 Premium\n/premium\n/buy\n/mystatus\n\n` +
        `📋 /menu — Full menu`
    );
});

// ═══════════════════════════════════════════════
//  ADMIN PANEL
// ═══════════════════════════════════════════════

bot.command("admin", (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌ Admin only");
    ctx.reply(
        `🔧 ADVANCED ADMIN PANEL\n\nSelect action:`,
        Markup.inlineKeyboard([
            [Markup.button.callback("📊 Stats", "admin_stats"), Markup.button.callback("👥 Users", "admin_users")],
            [Markup.button.callback("⏳ Pending", "admin_pending"), Markup.button.callback("🔍 Search User", "admin_search_info")],
            [Markup.button.callback("📢 Broadcast", "admin_broadcast_info"), Markup.button.callback("🪙 Coins", "admin_coins_info")],
            [Markup.button.callback("👑 Premium", "admin_prem_info"), Markup.button.callback("🚫 Ban/Unban", "admin_ban_info")],
            [Markup.button.callback("📋 All Commands", "admin_allcmds")],
        ])
    );
});

bot.action("admin_stats", async (ctx) => {
    if (Number(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery("❌");
    ctx.answerCbQuery();
    try {
        const totalUsers    = await User.countDocuments();
        const premiumUsers  = await User.countDocuments({ premium: true });
        const bannedUsers   = await User.countDocuments({ banned: true });
        const result        = await User.aggregate([{ $group: { _id: null, total: { $sum: "$coins" } } }]);
        const pendingResult = await User.aggregate([{ $unwind: "$payments" }, { $match: { "payments.status": "pending" } }, { $count: "count" }]);
        ctx.editMessageText(
            `📊 BOT STATISTICS\n\n👥 Total Users: ${totalUsers}\n👑 Premium Users: ${premiumUsers}\n🚫 Banned Users: ${bannedUsers}\n💰 Total Coins: ${result[0]?.total || 0}\n⏳ Pending Payments: ${pendingResult[0]?.count || 0}\n\n📅 ${new Date().toLocaleString("en-IN")}`,
            Markup.inlineKeyboard([[Markup.button.callback("🔙 Back", "admin_back")]])
        );
    } catch (err) { ctx.reply("❌ Stats error"); }
});

bot.action("admin_users", async (ctx) => {
    if (Number(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery("❌");
    ctx.answerCbQuery();
    try {
        const users = await User.find().sort({ joinDate: -1 }).limit(10);
        let text = `👥 Last 10 Users:\n\n`;
        users.forEach((u, i) => { text += `${i + 1}. ${u.firstName || "?"} (@${u.username || "N/A"})\n   ID: ${u.telegramId} | Coins: ${u.coins} | ${u.premium ? "👑" : "👤"} | ${u.banned ? "🚫" : "✅"}\n\n`; });
        ctx.editMessageText(text, Markup.inlineKeyboard([[Markup.button.callback("🔙 Back", "admin_back")]]));
    } catch (err) { ctx.reply("❌ Error"); }
});

bot.action("admin_pending", async (ctx) => {
    if (Number(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery("❌");
    ctx.answerCbQuery();
    try {
        const usersWithPending = await User.find({ "payments.status": "pending" });
        if (usersWithPending.length === 0) return ctx.editMessageText("✅ Koi pending payment nahi hai!", Markup.inlineKeyboard([[Markup.button.callback("🔙 Back", "admin_back")]]));
        await ctx.editMessageText(`⏳ Pending Payments (${usersWithPending.length} users)`, Markup.inlineKeyboard([[Markup.button.callback("🔙 Back", "admin_back")]]));
        for (const u of usersWithPending) {
            const pending = u.payments.filter((p) => p.status === "pending");
            for (const p of pending) {
                const plan = PLANS[p.plan];
                const msgText = `⏳ PENDING PAYMENT\n\n👤 ${u.firstName || "?"}\n🆔 ${u.telegramId}\n📱 @${u.username || "N/A"}\n👑 ${plan?.name || p.plan}\n💰 ₹${p.amount}`;
                if (p.screenshotFileId) {
                    await ctx.telegram.sendPhoto(ADMIN_ID, p.screenshotFileId, { caption: msgText, reply_markup: pendingPaymentKeyboard(u.telegramId, p.plan).reply_markup });
                } else {
                    await ctx.telegram.sendMessage(ADMIN_ID, msgText, { reply_markup: pendingPaymentKeyboard(u.telegramId, p.plan).reply_markup });
                }
                await sleep(300);
            }
        }
    } catch (err) { ctx.reply("❌ Error"); }
});

bot.action("admin_broadcast_info", (ctx) => { if (Number(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery("❌"); ctx.answerCbQuery(); ctx.reply(`📢 Broadcast:\n/broadcast message\n/broadcastpremium message\n/broadcastnew message`); });
bot.action("admin_coins_info",     (ctx) => { if (Number(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery("❌"); ctx.answerCbQuery(); ctx.reply(`🪙 Coins:\n/addcoins ID AMOUNT\n/removecoins ID AMOUNT\n/resetcoins ID`); });
bot.action("admin_prem_info",      (ctx) => { if (Number(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery("❌"); ctx.answerCbQuery(); ctx.reply(`👑 Premium:\n/givepremium ID silver|gold|platinum\n/removepremium ID\n/approvepayment ID PLAN`); });
bot.action("admin_ban_info",       (ctx) => { if (Number(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery("❌"); ctx.answerCbQuery(); ctx.reply(`🚫 Ban:\n/banuser ID reason\n/unbanuser ID\n/bannedlist`); });
bot.action("admin_search_info",    (ctx) => { if (Number(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery("❌"); ctx.answerCbQuery(); ctx.reply(`🔍 Search:\n/userinfo ID\n/finduser @username`); });
bot.action("admin_allcmds",        (ctx) => { if (Number(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery("❌"); ctx.answerCbQuery(); ctx.reply(`📋 ALL ADMIN COMMANDS\n\n/stats\n/userinfo ID\n/finduser @username\n/bannedlist\n/addcoins ID AMT\n/removecoins ID AMT\n/resetcoins ID\n/givepremium ID PLAN\n/removepremium ID\n/approvepayment ID PLAN\n/banuser ID reason\n/unbanuser ID\n/broadcast msg\n/broadcastpremium msg\n/broadcastnew msg`); });
bot.action("admin_back", (ctx) => {
    if (Number(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery("❌");
    ctx.answerCbQuery();
    ctx.editMessageText(`🔧 ADVANCED ADMIN PANEL\n\nSelect action:`,
        Markup.inlineKeyboard([
            [Markup.button.callback("📊 Stats", "admin_stats"), Markup.button.callback("👥 Users", "admin_users")],
            [Markup.button.callback("⏳ Pending", "admin_pending"), Markup.button.callback("🔍 Search User", "admin_search_info")],
            [Markup.button.callback("📢 Broadcast", "admin_broadcast_info"), Markup.button.callback("🪙 Coins", "admin_coins_info")],
            [Markup.button.callback("👑 Premium", "admin_prem_info"), Markup.button.callback("🚫 Ban/Unban", "admin_ban_info")],
            [Markup.button.callback("📋 All Commands", "admin_allcmds")],
        ])
    );
});

// ═══════════════════════════════════════════════
//  ADMIN TEXT COMMANDS
// ═══════════════════════════════════════════════

bot.command("stats", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌ Admin only");
    try {
        const totalUsers   = await User.countDocuments();
        const premiumUsers = await User.countDocuments({ premium: true });
        const bannedUsers  = await User.countDocuments({ banned: true });
        const result       = await User.aggregate([{ $group: { _id: null, total: { $sum: "$coins" }, earned: { $sum: "$totalEarned" } } }]);
        const pendingResult = await User.aggregate([{ $unwind: "$payments" }, { $match: { "payments.status": "pending" } }, { $count: "count" }]);
        ctx.reply(`📊 BOT STATS\n\n👥 Total Users: ${totalUsers}\n👑 Premium: ${premiumUsers}\n🚫 Banned: ${bannedUsers}\n💰 Total Coins: ${result[0]?.total || 0}\n📈 Total Earned: ${result[0]?.earned || 0}\n⏳ Pending: ${pendingResult[0]?.count || 0}`);
    } catch (err) { ctx.reply("❌ Stats Error"); }
});

bot.command("addcoins", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌ Admin only");
    try {
        const args = ctx.message.text.split(" ");
        if (args.length < 3) return ctx.reply("Use:\n/addcoins USER_ID AMOUNT");
        const userId = Number(args[1]); const amount = Number(args[2]);
        if (isNaN(userId) || isNaN(amount)) return ctx.reply("❌ Valid numbers do");
        const user = await User.findOne({ telegramId: userId });
        if (!user) return ctx.reply("❌ User not found");
        user.coins += amount; user.totalEarned += amount; await user.save();
        ctx.reply(`✅ ${amount} coins add kiye!\n👤 ${user.firstName || userId}\n💰 Total: ${user.coins}`);
        try { await bot.telegram.sendMessage(userId, `🎁 Admin ne aapko ${amount} coins diye!\n💰 Total: ${user.coins}`); } catch (e) {}
    } catch (err) { ctx.reply("❌ Error"); }
});

bot.command("removecoins", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌ Admin only");
    try {
        const args = ctx.message.text.split(" ");
        if (args.length < 3) return ctx.reply("Use:\n/removecoins USER_ID AMOUNT");
        const userId = Number(args[1]); const amount = Number(args[2]);
        const user = await User.findOne({ telegramId: userId });
        if (!user) return ctx.reply("❌ User not found");
        user.coins = Math.max(0, user.coins - amount); await user.save();
        ctx.reply(`✅ ${amount} coins remove kiye!\n👤 ${user.firstName || userId}\n💰 Remaining: ${user.coins}`);
    } catch (err) { ctx.reply("❌ Error"); }
});

bot.command("resetcoins", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌ Admin only");
    try {
        const args = ctx.message.text.split(" ");
        if (args.length < 2) return ctx.reply("Use:\n/resetcoins USER_ID");
        const user = await User.findOne({ telegramId: Number(args[1]) });
        if (!user) return ctx.reply("❌ User not found");
        user.coins = 0; await user.save();
        ctx.reply(`✅ Coins reset!\n👤 ${user.firstName || args[1]}\n💰 Coins: 0`);
    } catch (err) { ctx.reply("❌ Error"); }
});

bot.command("givepremium", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌ Admin only");
    try {
        const args = ctx.message.text.split(" ");
        if (args.length < 2) return ctx.reply("Use:\n/givepremium USER_ID [silver|gold|platinum]");
        const userId = Number(args[1]); const planKey = args[2] || "gold"; const plan = PLANS[planKey];
        if (!plan) return ctx.reply("❌ Valid plan: silver, gold, platinum");
        const user = await User.findOne({ telegramId: userId });
        if (!user) return ctx.reply("❌ User not found");
        user.premium = true; user.premiumPlan = planKey;
        user.premiumExpires = new Date(Date.now() + plan.days * 24 * 60 * 60 * 1000);
        user.coins += plan.coins; await user.save();
        ctx.reply(`✅ Premium diya!\n👤 ${user.firstName || userId}\n👑 ${plan.name}\n📅 Expires: ${user.premiumExpires.toLocaleDateString("en-IN")}`);
        try { await bot.telegram.sendMessage(userId, `🎉 Premium Active!\n\n👑 ${plan.name}\n💰 +${plan.coins} Coins\n📅 Expires: ${user.premiumExpires.toLocaleDateString("en-IN")}\n\n/menu`); } catch (e) {}
    } catch (err) { ctx.reply("❌ Error"); }
});

bot.command("removepremium", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌ Admin only");
    try {
        const args = ctx.message.text.split(" ");
        if (args.length < 2) return ctx.reply("Use:\n/removepremium USER_ID");
        const user = await User.findOne({ telegramId: Number(args[1]) });
        if (!user) return ctx.reply("❌ User not found");
        user.premium = false; user.premiumPlan = null; user.premiumExpires = null; await user.save();
        ctx.reply(`✅ Premium remove kiya!\n👤 ${user.firstName || args[1]}`);
        try { await bot.telegram.sendMessage(Number(args[1]), "⚠️ Aapka premium admin ne remove kar diya hai."); } catch (e) {}
    } catch (err) { ctx.reply("❌ Error"); }
});

bot.command("approvepayment", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌ Admin only");
    try {
        const args = ctx.message.text.split(" ");
        if (args.length < 3) return ctx.reply("Use:\n/approvepayment USER_ID PLAN");
        const userId = Number(args[1]); const planKey = args[2]; const plan = PLANS[planKey];
        if (!plan) return ctx.reply("❌ Valid plan: silver, gold, platinum");
        const user = await User.findOne({ telegramId: userId });
        if (!user) return ctx.reply("❌ User not found");
        if (!user.payments) user.payments = [];
        const payment = user.payments.find((p) => p.status === "pending" || p.status === "awaiting_screenshot");
        if (payment) { payment.status = "approved"; payment.processedAt = new Date(); }
        user.premium = true; user.premiumPlan = planKey;
        user.premiumExpires = new Date(Date.now() + plan.days * 24 * 60 * 60 * 1000);
        user.coins += plan.coins; await user.save();
        ctx.reply(`✅ Payment approved!\n👤 ${user.firstName}\n👑 ${plan.name}`);
        try { await bot.telegram.sendMessage(userId, `🎉 Premium Active!\n\n👑 ${plan.name}\n💰 +${plan.coins} Coins\n📅 Expires: ${user.premiumExpires.toLocaleDateString("en-IN")}\n\n/menu`); } catch (e) {}
    } catch (err) { ctx.reply("❌ Error"); }
});

bot.command("banuser", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌ Admin only");
    try {
        const args = ctx.message.text.split(" ");
        if (args.length < 2) return ctx.reply("Use:\n/banuser USER_ID [reason]");
        const userId = Number(args[1]); const reason = args.slice(2).join(" ") || "Violation of rules";
        const user = await User.findOne({ telegramId: userId });
        if (!user) return ctx.reply("❌ User not found");
        user.banned = true; user.banReason = reason; await user.save();
        ctx.reply(`🚫 User ban kiya!\n👤 ${user.firstName || userId}\nReason: ${reason}`);
        try { await bot.telegram.sendMessage(userId, `🚫 Aapko ban kar diya gaya hai.\nReason: ${reason}`); } catch (e) {}
    } catch (err) { ctx.reply("❌ Error"); }
});

bot.command("unbanuser", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌ Admin only");
    try {
        const args = ctx.message.text.split(" ");
        if (args.length < 2) return ctx.reply("Use:\n/unbanuser USER_ID");
        const user = await User.findOne({ telegramId: Number(args[1]) });
        if (!user) return ctx.reply("❌ User not found");
        user.banned = false; user.banReason = null; await user.save();
        ctx.reply(`✅ User unban kiya!\n👤 ${user.firstName || args[1]}`);
        try { await bot.telegram.sendMessage(Number(args[1]), "✅ Aapka ban hat gaya hai! /start karein."); } catch (e) {}
    } catch (err) { ctx.reply("❌ Error"); }
});

bot.command("userinfo", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌ Admin only");
    try {
        const args = ctx.message.text.split(" ");
        if (args.length < 2) return ctx.reply("Use:\n/userinfo USER_ID");
        const user = await User.findOne({ telegramId: Number(args[1]) });
        if (!user) return ctx.reply("❌ User not found");
        const payments = user.payments || [];
        ctx.reply(`👤 User Info\n\nName: ${user.firstName}\nUsername: @${user.username || "N/A"}\nID: ${user.telegramId}\nCoins: ${user.coins}\nTotal Earned: ${user.totalEarned}\nReferrals: ${user.referrals}\nPremium: ${user.premium ? `✅ ${user.premiumPlan}` : "❌"}\nBanned: ${user.banned ? `🚫 (${user.banReason})` : "✅ No"}\nPayments: ${payments.filter(p=>p.status==="approved").length} approved\nJoin Date: ${user.joinDate?.toLocaleDateString("en-IN")}\nAI Mode: ${user.mode}`);
    } catch (err) { ctx.reply("❌ Error"); }
});

bot.command("finduser", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌ Admin only");
    try {
        const args = ctx.message.text.split(" ");
        if (args.length < 2) return ctx.reply("Use:\n/finduser @username");
        const query = args[1].replace("@", "");
        const user = await User.findOne({ $or: [{ username: { $regex: query, $options: "i" } }, { firstName: { $regex: query, $options: "i" } }] });
        if (!user) return ctx.reply("❌ User not found");
        ctx.reply(`🔍 User Found!\n\n👤 ${user.firstName}\n📱 @${user.username || "N/A"}\n🆔 ${user.telegramId}\n💰 ${user.coins} coins\n👑 ${user.premium ? `✅ ${user.premiumPlan}` : "❌"}\n🚫 Banned: ${user.banned ? "Yes" : "No"}`);
    } catch (err) { ctx.reply("❌ Error"); }
});

bot.command("bannedlist", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌ Admin only");
    try {
        const bannedUsers = await User.find({ banned: true });
        if (bannedUsers.length === 0) return ctx.reply("✅ Koi banned user nahi hai.");
        let text = `🚫 Banned Users (${bannedUsers.length}):\n\n`;
        bannedUsers.forEach((u, i) => { text += `${i + 1}. ${u.firstName || "?"} (@${u.username || "N/A"})\n   ID: ${u.telegramId}\n   Reason: ${u.banReason || "N/A"}\n\n`; });
        ctx.reply(text);
    } catch (err) { ctx.reply("❌ Error"); }
});

bot.command("broadcast", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌ Admin only");
    try {
        const message = ctx.message.text.replace("/broadcast", "").trim();
        if (!message) return ctx.reply("Use:\n/broadcast Hello everyone!");
        const users = await User.find({ banned: false });
        let success = 0, failed = 0;
        await ctx.reply(`📢 Broadcast shuru... (${users.length} users)`);
        for (const user of users) {
            try { await bot.telegram.sendMessage(user.telegramId, `📢 GrowMate AI\n\n${message}`); success++; } catch (e) { failed++; }
            await sleep(100);
        }
        ctx.reply(`✅ Done!\n✅ Sent: ${success}\n❌ Failed: ${failed}`);
    } catch (err) { ctx.reply("❌ Broadcast Error"); }
});

bot.command("broadcastpremium", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌ Admin only");
    try {
        const message = ctx.message.text.replace("/broadcastpremium", "").trim();
        if (!message) return ctx.reply("Use:\n/broadcastpremium message");
        const users = await User.find({ banned: false, premium: true });
        let success = 0, failed = 0;
        await ctx.reply(`📢 Premium broadcast... (${users.length} users)`);
        for (const user of users) {
            try { await bot.telegram.sendMessage(user.telegramId, `👑 Premium Member Update\n\n${message}`); success++; } catch (e) { failed++; }
            await sleep(100);
        }
        ctx.reply(`✅ Done!\n✅ Sent: ${success}\n❌ Failed: ${failed}`);
    } catch (err) { ctx.reply("❌ Error"); }
});

bot.command("broadcastnew", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("❌ Admin only");
    try {
        const message = ctx.message.text.replace("/broadcastnew", "").trim();
        if (!message) return ctx.reply("Use:\n/broadcastnew message");
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const users = await User.find({ banned: false, joinDate: { $gte: sevenDaysAgo } });
        let success = 0, failed = 0;
        await ctx.reply(`📢 New users broadcast... (${users.length} users)`);
        for (const user of users) {
            try { await bot.telegram.sendMessage(user.telegramId, `🆕 Welcome New Member!\n\n${message}`); success++; } catch (e) { failed++; }
            await sleep(100);
        }
        ctx.reply(`✅ Done!\n✅ Sent: ${success}\n❌ Failed: ${failed}`);
    } catch (err) { ctx.reply("❌ Error"); }
});

// ═══════════════════════════════════════════════
//  KEYBOARD BUTTON HANDLERS
// ═══════════════════════════════════════════════

bot.hears("🤖 AI Chat",     (ctx) => ctx.reply("Use:\n/ai your question here"));
bot.hears("🖼 Image",       (ctx) => ctx.reply("Use:\n/image futuristic car"));
bot.hears("✍ Caption",     (ctx) => ctx.reply("Use:\n/caption nike shoes"));
bot.hears("#️⃣ Hashtags",   (ctx) => ctx.reply("Use:\n/hashtags gym content"));
bot.hears("🎬 Reel Ideas", (ctx) => ctx.reply("Use:\n/reelidea fitness"));
bot.hears("🎥 Scripts",    (ctx) => ctx.reply("Use:\n/script gym motivation"));
bot.hears("🎤 Voice",      (ctx) => ctx.reply("Use:\n/voice Hello world"));
bot.hears("🖼 Thumbnail",  (ctx) => ctx.reply("Use:\n/thumbnail gym motivation"));
bot.hears("💼 Marketing",  (ctx) => ctx.reply("Use:\n/marketing sneaker business"));
bot.hears("💰 Balance",    (ctx) => ctx.reply("/balance"));
bot.hears("📜 History",    (ctx) => ctx.reply("/history"));
bot.hears("🎁 Daily",      (ctx) => ctx.reply("/daily"));
bot.hears("🏆 Leaderboard",(ctx) => ctx.reply("/leaderboard"));
bot.hears("👑 Premium",    (ctx) => ctx.reply("/premium"));
bot.hears("🛒 Buy",        (ctx) => ctx.reply("/buy"));
bot.hears("👥 Invite", async (ctx) => {
    const link = `https://t.me/${ctx.botInfo.username}?start=${ctx.from.id}`;
    ctx.reply(`🔗 Invite Link:\n\n${link}\n\n💰 Per referral: +20 coins`);
});

// ═══════════════════════════════════════════════
//  CRON JOBS
// ═══════════════════════════════════════════════

cron.schedule("0 10 * * *", async () => {
    console.log("⏰ Daily reminders...");
    const users = await User.find({ banned: false });
    for (const user of users) {
        try { await bot.telegram.sendMessage(user.telegramId, `🎁 Daily reward claim karo!\n\n/daily — Free coins\n\n👥 Dosto ko invite karo: /invite\n💰 Per referral: +20 coins 🚀`); } catch (e) {}
        await sleep(100);
    }
});

cron.schedule("0 */6 * * *", async () => {
    console.log("🔄 Premium expiry check...");
    const premiumUsers = await User.find({ premium: true });
    for (const user of premiumUsers) { await checkPremium(user); }
});

// ═══════════════════════════════════════════════
//  GLOBAL ERROR HANDLER
// ═══════════════════════════════════════════════

bot.catch((err, ctx) => {
    const msg = err?.description || err?.message || "";
    if (
        msg.includes("query is too old") ||
        msg.includes("query ID is invalid") ||
        msg.includes("response timeout expired") ||
        msg.includes("bot was blocked by the user") ||
        msg.includes("chat not found") ||
        msg.includes("user not found")
    ) return;
    console.error("❌ Bot Error:", msg);
});

// ═══════════════════════════════════════════════
//  LAUNCH BOT + HEALTH CHECK SERVER (Render ke liye)
// ═══════════════════════════════════════════════

bot.launch();
console.log("🚀 GrowMate AI Bot Running...");

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("✅ GrowMate AI Bot is running!");
}).listen(PORT, () => {
    console.log(`✅ Health check server on port ${PORT}`);
});

process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));


====FILE: models/User.js====
const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema({
    plan:            { type: String },
    amount:          { type: Number },
    status:          { type: String, default: "awaiting_screenshot" },
    screenshotFileId:{ type: String },
    processedAt:     { type: Date },
}, { timestamps: true });

const memorySchema = new mongoose.Schema({
    user: { type: String },
    ai:   { type: String },
});

const userSchema = new mongoose.Schema({
    telegramId:     { type: Number, required: true, unique: true },
    username:       { type: String, default: "" },
    firstName:      { type: String, default: "" },
    coins:          { type: Number, default: 50 },
    totalEarned:    { type: Number, default: 50 },
    referrals:      { type: Number, default: 0 },
    referredBy:     { type: Number, default: null },
    premium:        { type: Boolean, default: false },
    premiumPlan:    { type: String, default: null },
    premiumExpires: { type: Date, default: null },
    banned:         { type: Boolean, default: false },
    banReason:      { type: String, default: null },
    lastDaily:      { type: Date, default: null },
    mode:           { type: String, default: "normal" },
    payments:       { type: [paymentSchema], default: [] },
    memory:         { type: [memorySchema], default: [] },
    joinDate:       { type: Date, default: Date.now },
});

module.exports = mongoose.model("User", userSchema);


====FILE: package.json====
{
  "name": "growmate-ai-bot",
  "version": "1.0.0",
  "description": "GrowMate AI Telegram Bot",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "telegraf": "^4.16.3",
    "mongoose": "^8.0.0",
    "axios": "^1.6.0",
    "gtts": "^0.2.1",
    "node-cron": "^3.0.3",
    "dotenv": "^16.0.0"
  }
}


