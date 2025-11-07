const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require("form-data");
const os = require('os'); 
const { sms, downloadMediaMessage } = require("./msg");
const bcrypt = require('bcrypt');
const { MongoClient, ObjectId } = require('mongodb');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('@whiskeysockets/baileys');

// Import MEGA storage
const MegaStorage = require('./megaStorage');

const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['🩵', '🧘', '😀', '👍', '🤭', '😂', '🥹', '🥰', '😍', '🤩', '😎', '🥳', '😜', '🤗', '🫠', '😢', '😡', '🤯', '🥶', '😴', '🙄', '🤔', '🐶', '🐱', '🐢', '🦋', '🐙', '🦄', '🦁', '🐝', '🌸', '🍀', '🌈', '⭐', '🌙', '🍁', '🌵', '🍕', '🍦', '🍩', '☕', '🧋', '🥑', '🍇', '🍔', '🌮', '🍜', '⚽', '🎮', '🎨', '✈️', '🚀', '💡', '📚', '🎸', '🛼', '🎯', '💎', '🧩', '🔭', '❤️', '🔥', '💫', '✨', '💯', '✅', '❌', '🙏'],
    PREFIX: '.',
    MODE: 'public',
    MAX_RETRIES: 3,
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: 'https://i.ibb.co/chFk6yQ7/vision-v.jpg',
    NEWSLETTER_JID: '120363299029326322@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,
    version: '1.0.0',
    OWNER_NUMBER: '254740007567',
    BOT_FOOTER: 'ᴘᴏᴡᴇʀᴇᴅ ʙʏ ʙᴇʀᴀᴘᴀʏ',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbB3YxTDJ6H15SKoBv3S',
    MEGA_EMAIL: process.env.MEGA_EMAIL || 'tohidkhan9050482152@gmail.com',
    MEGA_PASSWORD: process.env.MEGA_PASSWORD || 'Rvpy.B.6YeZn7CR'
};

// Initialize MEGA storage
const megaStorage = new MegaStorage(config.MEGA_EMAIL, config.MEGA_PASSWORD);

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';
const otpStore = new Map();
const registrationState = new Map();

// MongoDB connection with fallback
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/berapay';
let db;
let dbConnected = false;

// Simple in-memory storage as fallback
const memoryStorage = {
    users: new Map(),
    transactions: new Map()
};

// Initialize MongoDB with fallback
async function initMongoDB() {
    try {
        // Skip MongoDB connection if no URI is provided or if it's localhost
        if (!process.env.MONGODB_URI || process.env.MONGODB_URI.includes('localhost') || process.env.MONGODB_URI.includes('127.0.0.1')) {
            console.log('⚠️  MongoDB URI not provided or is localhost, using in-memory storage');
            dbConnected = false;
            return;
        }

        console.log('🔗 Attempting MongoDB connection...');
        
        const client = new MongoClient(mongoUri, {
            serverSelectionTimeoutMS: 10000,
            connectTimeoutMS: 15000,
            socketTimeoutMS: 45000,
        });
        
        await client.connect();
        db = client.db();
        
        // Test connection
        await db.command({ ping: 1 });
        
        // Create collections if they don't exist
        const collections = await db.listCollections().toArray();
        const collectionNames = collections.map(col => col.name);
        
        if (!collectionNames.includes('users')) {
            await db.createCollection('users');
            console.log('✅ Created users collection');
        }
        
        if (!collectionNames.includes('transactions')) {
            await db.createCollection('transactions');
            console.log('✅ Created transactions collection');
        }
        
        // Create indexes
        await db.collection('users').createIndex({ phone: 1 }, { unique: true });
        await db.collection('transactions').createIndex({ phone: 1, createdAt: -1 });
        
        dbConnected = true;
        console.log('✅ MongoDB connected successfully');
        
    } catch (error) {
        console.error('❌ MongoDB connection failed, using in-memory storage:', error.message);
        dbConnected = false;
    }
}

// Database operations with fallback
const dbOps = {
    async findUser(query) {
        try {
            if (dbConnected && db) {
                return await db.collection('users').findOne(query);
            } else {
                const phone = query.phone;
                return memoryStorage.users.get(phone) || null;
            }
        } catch (error) {
            console.error('Database findUser error:', error);
            return null;
        }
    },

    async updateUser(query, update, options = {}) {
        try {
            if (dbConnected && db) {
                return await db.collection('users').updateOne(query, update, options);
            } else {
                const phone = query.phone;
                if (options.upsert) {
                    const existing = memoryStorage.users.get(phone);
                    if (existing) {
                        memoryStorage.users.set(phone, { ...existing, ...update.$set });
                    } else {
                        memoryStorage.users.set(phone, { 
                            ...update.$set, 
                            _id: Date.now().toString(),
                            createdAt: new Date(),
                            updatedAt: new Date()
                        });
                    }
                } else {
                    const existing = memoryStorage.users.get(phone);
                    if (existing) {
                        memoryStorage.users.set(phone, { ...existing, ...update.$set, updatedAt: new Date() });
                    }
                }
                return { modifiedCount: 1 };
            }
        } catch (error) {
            console.error('Database updateUser error:', error);
            return { modifiedCount: 0 };
        }
    },

    async insertTransaction(transaction) {
        try {
            if (dbConnected && db) {
                return await db.collection('transactions').insertOne({
                    ...transaction,
                    createdAt: new Date(),
                    updatedAt: new Date()
                });
            } else {
                const id = Date.now().toString();
                memoryStorage.transactions.set(id, { 
                    ...transaction, 
                    _id: id,
                    createdAt: new Date(),
                    updatedAt: new Date()
                });
                return { insertedId: id };
            }
        } catch (error) {
            console.error('Database insertTransaction error:', error);
            return { insertedId: null };
        }
    },

    async findTransactions(query) {
        try {
            if (dbConnected && db) {
                return await db.collection('transactions')
                    .find(query)
                    .sort({ createdAt: -1 })
                    .limit(5)
                    .toArray();
            } else {
                const transactions = Array.from(memoryStorage.transactions.values())
                    .filter(tx => {
                        const orConditions = query.$or;
                        return orConditions.some(condition => {
                            if (condition.sender) return tx.sender === condition.sender;
                            if (condition.receiver) return tx.receiver === condition.receiver;
                            return false;
                        });
                    })
                    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                    .slice(0, 5);
                return transactions;
            }
        } catch (error) {
            console.error('Database findTransactions error:', error);
            return [];
        }
    },

    async updateUserBalance(phone, amountChange) {
        try {
            if (dbConnected && db) {
                return await db.collection('users').updateOne(
                    { phone },
                    { 
                        $inc: { balance: amountChange },
                        $set: { updatedAt: new Date() }
                    }
                );
            } else {
                const user = memoryStorage.users.get(phone);
                if (user) {
                    user.balance += amountChange;
                    user.updatedAt = new Date();
                    memoryStorage.users.set(phone, user);
                    return { modifiedCount: 1 };
                }
                return { modifiedCount: 0 };
            }
        } catch (error) {
            console.error('Database updateUserBalance error:', error);
            return { modifiedCount: 0 };
        }
    }
};

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Africa/Harare').format('YYYY-MM-DD HH:mm:ss');
}

async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const files = await megaStorage.listFiles();
        
        const sessionFiles = files.filter(filename => 
            filename.startsWith(`empire_${sanitizedNumber}_`) && filename.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        const configFiles = files.filter(filename => 
            filename === `config_${sanitizedNumber}.json`
        );

        if (sessionFiles.length > 1) {
            for (let i = 1; i < sessionFiles.length; i++) {
                await megaStorage.deleteFile(sessionFiles[i]);
                console.log(`Deleted duplicate session file: ${sessionFiles[i]}`);
            }
        }

        if (configFiles.length > 0) {
            console.log(`Config file for ${sanitizedNumber} already exists`);
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

async function saveSessionToMEGA(number, sessionData, filename) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const buffer = Buffer.from(JSON.stringify(sessionData, null, 2));
        await megaStorage.uploadBuffer(buffer, filename);
        console.log(`Session saved to MEGA: ${filename}`);
    } catch (error) {
        console.error('Failed to save session to MEGA:', error);
        throw error;
    }
}

async function loadSessionFromMEGA(filename) {
    try {
        const data = await megaStorage.downloadBuffer(filename);
        return JSON.parse(data.toString('utf8'));
    } catch (error) {
        console.error('Failed to load session from MEGA:', error);
        return null;
    }
}

async function deleteSessionFromMEGA(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const files = await megaStorage.listFiles();
        
        const sessionFiles = files.filter(filename =>
            filename.includes(sanitizedNumber) && filename.endsWith('.json')
        );

        for (const file of sessionFiles) {
            await megaStorage.deleteFile(file);
            console.log(`Deleted MEGA session file: ${file}`);
        }

        let numbers = [];
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
            numbers = numbers.filter(n => n !== sanitizedNumber);
            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
        }
    } catch (error) {
        console.error('Failed to delete session from MEGA:', error);
    }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const files = await megaStorage.listFiles();
        
        const sessionFiles = files.filter(filename =>
            filename === `creds_${sanitizedNumber}.json`
        );

        if (sessionFiles.length === 0) return null;
        return await loadSessionFromMEGA(sessionFiles[0]);
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configFilename = `config_${sanitizedNumber}.json`;
        
        const configExists = await megaStorage.fileExists(configFilename);
        if (!configExists) {
            return { ...config };
        }
        
        const userConfig = await loadSessionFromMEGA(configFilename);
        return {
            ...config,
            ...userConfig,
            PREFIX: userConfig.PREFIX || config.PREFIX,
            MODE: userConfig.MODE || config.MODE
        };
    } catch (error) {
        return { ...config };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configFilename = `config_${sanitizedNumber}.json`;
        await saveSessionToMEGA(number, newConfig, configFilename);
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

async function sendAdminConnectMessage(socket, number) {
    const admins = loadAdmins();
    const caption = formatMessage(
        'ᴄᴏɴɴᴇᴄᴛᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ ✅',
        `📞 ɴᴜᴍʙᴇʀ: ${number}\n💳 ᴡᴀʟʟᴇᴛ: 🟢 ᴀᴄᴛɪᴠᴇ\n📊 sᴛᴏʀᴀɢᴇ: ${dbConnected ? '🟢 ᴍᴏɴɢᴏᴅʙ' : '🟡 ᴍᴇᴍᴏʀʏ'}\n🩵 sᴛᴀᴛᴜs: Oɴʟɪɴᴇ`,
        `${config.BOT_FOOTER}`
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption
                }
            );
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error.message);
        }
    }
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.`,
        'ᴘᴏᴡᴇʀᴇᴅ ʙʏ ʙᴇʀᴀᴘᴀʏ'
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;

        const allNewsletterJIDs = await loadNewsletterJIDsFromRaw();
        const jid = message.key.remoteJid;

        if (!allNewsletterJIDs.includes(jid)) return;

        try {
            const emojis = ['🩵', '🧘', '😀', '👍', '🤭', '😂', '🥹', '🥰', '😍', '🤩', '😎', '🥳', '😜', '🤗', '🫠', '😢', '😡', '🤯', '🥶', '😴', '🙄', '🤔', '🐶', '🐱', '🐢', '🦋', '🐙', '🦄', '🦁', '🐝', '🌸', '🍀', '🌈', '⭐', '🌙', '🍁', '🌵', '🍕', '🍦', '🍩', '☕', '🧋', '🥑', '🍇', '🍔', '🌮', '🍜', '⚽', '🎮', '🎨', '✈️', '🚀', '💡', '📚', '🎸', '🛼', '🎯', '💎', '🧩', '🔭', '❤️', '🔥', '💫', '✨', '💯', '✅', '❌', '🙏'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) return;

            let retries = 3;
            while (retries-- > 0) {
                try {
                    await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                    break;
                } catch (err) {
                    await delay(1500);
                }
            }
        } catch (error) {
            console.error('⚠️ Newsletter reaction handler failed:', error.message);
        }
    });
}

async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        break;
                    } catch (error) {
                        retries--;
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            'ʙᴇʀᴀᴘᴀʏ ᴡᴀʟʟᴇᴛ ʙᴏᴛ'
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

async function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const type = getContentType(msg.message);
        if (!msg.message) return;
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const m = sms(socket, msg);
        const body = (type === 'conversation') ? msg.message.conversation 
            : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type == 'interactiveResponseMessage') 
                ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage 
                    && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id 
            : (type == 'templateButtonReplyMessage') 
                ? msg.message.templateButtonReplyMessage?.selectedId 
            : (type === 'extendedTextMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type == 'imageMessage') && msg.message.imageMessage.caption 
                ? msg.message.imageMessage.caption 
            : (type == 'videoMessage') && msg.message.videoMessage.caption 
                ? msg.message.videoMessage.caption 
            : (type == 'buttonsResponseMessage') 
                ? msg.message.buttonsResponseMessage?.selectedButtonId 
            : (type == 'listResponseMessage') 
                ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
            : (type == 'messageContextInfo') 
                ? (msg.message.buttonsResponseMessage?.selectedButtonId 
                    || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
                    || msg.text) 
            : (type === 'viewOnceMessage') 
                ? msg.message[type]?.message[getContentType(msg.message[type].message)] 
            : (type === "viewOnceMessageV2") 
                ? (msg.message[type]?.message?.imageMessage?.caption || msg.message[type]?.message?.videoMessage?.caption || "") 
            : '';
        let sender = msg.key.remoteJid;
        const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid);
        const senderNumber = nowsender.split('@')[0];
        const developers = `${config.OWNER_NUMBER}`;
        const botNumber = socket.user.id.split(':')[0];
        const isbot = botNumber.includes(senderNumber);
        const isOwner = isbot ? isbot : developers.includes(senderNumber);
        let userConfig = await loadUserConfig(sanitizedNumber);
        let prefix = userConfig.PREFIX || config.PREFIX;
        let mode = userConfig.MODE || config.MODE;
        const isCmd = body.startsWith(prefix);
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';
        const args = body.trim().split(/ +/).slice(1);

        if (mode === 'self' && !isOwner) {
            return;
        }

        const fakevCard = {
            key: {
                fromMe: false,
                participant: "0@s.whatsapp.net",
                remoteJid: "status@broadcast"
            },
            message: {
                contactMessage: {
                    displayName: "© ʙᴇʀᴀᴘᴀʏ",
                    vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:Meta\nORG:BeraPay;\nTEL;type=CELL;type=VOICE;waid=254740007567:+254740007567\nEND:VCARD`
                }
            }
        };

        try {
            switch (command) {
                case 'menu':
                case 'beramenu': {
                    await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });
                    
                    const menuMessage = {
                        text: `🎯 *BeraPay Wallet System*\n\nYour secure digital wallet for seamless transactions\n\n📊 Storage: ${dbConnected ? '🟢 MongoDB' : '🟡 Memory'}`,
                        buttons: [
                            {
                                buttonId: `${prefix}register`,
                                buttonText: { displayText: '📝 Register' },
                                type: 1
                            },
                            {
                                buttonId: `${prefix}balance`,
                                buttonText: { displayText: '💰 Balance' },
                                type: 1
                            },
                            {
                                buttonId: `${prefix}send`,
                                buttonText: { displayText: '💸 Send Money' },
                                type: 1
                            }
                        ],
                        sections: [
                            {
                                title: "BeraPay Wallet Options",
                                rows: [
                                    {
                                        title: "📝 Register",
                                        description: "Create your BeraPay account",
                                        rowId: `${prefix}register`
                                    },
                                    {
                                        title: "💰 Balance",
                                        description: "Check your wallet balance",
                                        rowId: `${prefix}balance`
                                    },
                                    {
                                        title: "💸 Send Money",
                                        description: "Send money to other users",
                                        rowId: `${prefix}send`
                                    },
                                    {
                                        title: "📥 Deposit",
                                        description: "Add money to your wallet",
                                        rowId: `${prefix}deposit`
                                    },
                                    {
                                        title: "📜 Transactions",
                                        description: "View transaction history",
                                        rowId: `${prefix}transactions`
                                    },
                                    {
                                        title: "👤 Profile",
                                        description: "View your profile",
                                        rowId: `${prefix}profile`
                                    },
                                    {
                                        title: "❓ Help",
                                        description: "Get help with commands",
                                        rowId: `${prefix}help`
                                    }
                                ]
                            }
                        ],
                        headerType: 1
                    };
                    
                    await socket.sendMessage(sender, menuMessage);
                    break;
                }

                case 'register': {
                    const userState = registrationState.get(sender);
                    
                    if (!userState) {
                        registrationState.set(sender, { step: 1 });
                        await socket.sendMessage(sender, {
                            text: `📝 *Registration - Step 1/3*\n\nPlease enter your full name:`
                        });
                    } else if (userState.step === 1) {
                        userState.name = body.trim();
                        userState.step = 2;
                        registrationState.set(sender, userState);
                        
                        await socket.sendMessage(sender, {
                            text: `🔐 *Registration - Step 2/3*\n\nPlease create a 4-digit PIN:`
                        });
                    } else if (userState.step === 2) {
                        const pin = body.trim();
                        if (!/^\d{4}$/.test(pin)) {
                            await socket.sendMessage(sender, {
                                text: `❌ Invalid PIN! Please enter exactly 4 digits.`
                            });
                            return;
                        }
                        
                        userState.pin = pin;
                        userState.step = 3;
                        registrationState.set(sender, userState);
                        
                        await socket.sendMessage(sender, {
                            text: `🖼️ *Registration - Step 3/3*\n\nYou can now optionally send a profile picture (image), or type 'skip' to continue without one.`
                        });
                    } else if (userState.step === 3) {
                        if (type === 'imageMessage') {
                            try {
                                const mediaBuffer = await downloadMediaMessage(msg, 'buffer', {});
                                const filename = `profile_${sender.replace('@s.whatsapp.net', '')}_${Date.now()}.jpg`;
                                userState.profilePath = filename;
                                await fs.writeFileSync(filename, mediaBuffer);
                            } catch (error) {
                                console.error('Error saving profile image:', error);
                            }
                        }
                        
                        try {
                            const pinHash = await bcrypt.hash(userState.pin, 10);
                            const normalizedPhone = sender.replace('@s.whatsapp.net', '').replace(/^0/, '254');
                            
                            const userData = {
                                name: userState.name,
                                phone: normalizedPhone,
                                pinHash: pinHash,
                                profilePath: userState.profilePath || null,
                                linked: true,
                                balance: 0,
                                createdAt: new Date(),
                                updatedAt: new Date()
                            };
                            
                            await dbOps.updateUser(
                                { phone: normalizedPhone },
                                { $set: userData },
                                { upsert: true }
                            );
                            
                            registrationState.delete(sender);
                            
                            await socket.sendMessage(sender, {
                                text: `✅ *Registration Complete!*\n\nWelcome to BeraPay, ${userState.name}! 🎉\n\nYour wallet has been created successfully.\n\nType *${prefix}menu* to explore features.`
                            });
                            
                        } catch (error) {
                            console.error('Registration error:', error);
                            await socket.sendMessage(sender, {
                                text: `❌ Registration failed. Please try again.`
                            });
                        }
                    }
                    break;
                }

                case 'balance': {
                    try {
                        const normalizedPhone = sender.replace('@s.whatsapp.net', '').replace(/^0/, '254');
                        const user = await dbOps.findUser({ phone: normalizedPhone });
                        
                        if (!user) {
                            await socket.sendMessage(sender, {
                                text: `⚠️ *You are not registered yet!*\n\nType *${prefix}register* to create your BeraPay account.`
                            });
                            return;
                        }
                        
                        await socket.sendMessage(sender, {
                            text: `💰 *Your Wallet Balance*\n\nBalance: *KES ${user.balance}*\n\nAccount: ${user.name}\nPhone: ${user.phone}\n\n💾 Storage: ${dbConnected ? 'MongoDB' : 'Memory'}`
                        });
                    } catch (error) {
                        console.error('Balance check error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ Failed to check balance. Please try again.`
                        });
                    }
                    break;
                }

                case 'send': {
                    try {
                        const normalizedPhone = sender.replace('@s.whatsapp.net', '').replace(/^0/, '254');
                        const user = await dbOps.findUser({ phone: normalizedPhone });
                        
                        if (!user) {
                            await socket.sendMessage(sender, {
                                text: `⚠️ *You are not registered yet!*\n\nType *${prefix}register* to create your BeraPay account.`
                            });
                            return;
                        }
                        
                        const match = body.match(/send\s+(\d+)\s+to\s+(\d+)/i);
                        if (!match) {
                            await socket.sendMessage(sender, {
                                text: `📌 *Usage:* ${prefix}send <amount> to <phone number>\n\nExample: ${prefix}send 500 to 0712345678`
                            });
                            return;
                        }
                        
                        const amount = parseInt(match[1]);
                        let recipient = match[2].replace(/^0/, '254');
                        
                        if (amount < 1) {
                            await socket.sendMessage(sender, {
                                text: `❌ Amount must be at least KES 1`
                            });
                            return;
                        }
                        
                        if (amount > user.balance) {
                            await socket.sendMessage(sender, {
                                text: `❌ Insufficient balance! You have KES ${user.balance}`
                            });
                            return;
                        }
                        
                        if (recipient === normalizedPhone) {
                            await socket.sendMessage(sender, {
                                text: `❌ You cannot send money to yourself`
                            });
                            return;
                        }
                        
                        const tempTransaction = {
                            sender: normalizedPhone,
                            recipient: recipient,
                            amount: amount,
                            timestamp: Date.now()
                        };
                        
                        registrationState.set(sender + '_send', tempTransaction);
                        
                        await socket.sendMessage(sender, {
                            text: `💸 *Confirm Transaction*\n\nYou are about to send *KES ${amount}* to *${recipient}*\n\nPlease confirm:`,
                            buttons: [
                                {
                                    buttonId: `${prefix}confirm_send`,
                                    buttonText: { displayText: '✅ Confirm' },
                                    type: 1
                                },
                                {
                                    buttonId: `${prefix}cancel_send`,
                                    buttonText: { displayText: '❌ Cancel' },
                                    type: 1
                                }
                            ]
                        });
                        
                    } catch (error) {
                        console.error('Send command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ Failed to process send request. Please try again.`
                        });
                    }
                    break;
                }

                case 'confirm_send': {
                    try {
                        const tempTransaction = registrationState.get(sender + '_send');
                        if (!tempTransaction) {
                            await socket.sendMessage(sender, {
                                text: `❌ No pending transaction found`
                            });
                            return;
                        }
                        
                        const { sender: senderPhone, recipient, amount } = tempTransaction;
                        
                        const transaction = {
                            sender: senderPhone,
                            receiver: recipient,
                            amount: amount,
                            type: 'send',
                            status: 'pending',
                            createdAt: new Date()
                        };
                        
                        const recipientUser = await dbOps.findUser({ phone: recipient });
                        
                        if (recipientUser) {
                            await dbOps.updateUserBalance(senderPhone, -amount);
                            await dbOps.updateUserBalance(recipient, amount);
                            transaction.status = 'completed';
                        } else {
                            try {
                                // Simulate external transfer
                                await new Promise(resolve => setTimeout(resolve, 2000));
                                await dbOps.updateUserBalance(senderPhone, -amount);
                                transaction.status = 'completed';
                                transaction.externalId = 'EXT_' + Date.now();
                            } catch (apiError) {
                                console.error('Transfer API error:', apiError);
                                transaction.status = 'failed';
                                transaction.error = 'Transfer failed';
                            }
                        }
                        
                        await dbOps.insertTransaction(transaction);
                        registrationState.delete(sender + '_send');
                        
                        if (transaction.status === 'completed') {
                            const updatedUser = await dbOps.findUser({ phone: senderPhone });
                            await socket.sendMessage(sender, {
                                text: `✅ *Transaction Successful!*\n\nSent *KES ${amount}* to *${recipient}*\n\nNew balance: KES ${updatedUser.balance}`
                            });
                        } else {
                            await socket.sendMessage(sender, {
                                text: `❌ *Transaction Failed*\n\nFailed to send KES ${amount} to ${recipient}\nError: ${transaction.error}`
                            });
                        }
                    } catch (error) {
                        console.error('Confirm send error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ Transaction failed. Please try again.`
                        });
                    }
                    break;
                }

                case 'cancel_send': {
                    registrationState.delete(sender + '_send');
                    await socket.sendMessage(sender, {
                        text: `❌ Transaction cancelled.`
                    });
                    break;
                }

                case 'deposit': {
                    try {
                        const normalizedPhone = sender.replace('@s.whatsapp.net', '').replace(/^0/, '254');
                        const user = await dbOps.findUser({ phone: normalizedPhone });
                        
                        if (!user) {
                            await socket.sendMessage(sender, {
                                text: `⚠️ *You are not registered yet!*\n\nType *${prefix}register* to create your BeraPay account.`
                            });
                            return;
                        }
                        
                        const amount = parseInt(args[0]);
                        if (!amount || amount < 1) {
                            await socket.sendMessage(sender, {
                                text: `📌 *Usage:* ${prefix}deposit <amount>\n\nExample: ${prefix}deposit 1000`
                            });
                            return;
                        }
                        
                        await socket.sendMessage(sender, {
                            text: `📲 *Deposit Initiated!*\n\nPlease send KES ${amount} to PayBill number 247247\nAccount: ${normalizedPhone}\n\nYou will receive a confirmation once payment is verified.`
                        });
                        
                    } catch (error) {
                        console.error('Deposit command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ Failed to process deposit. Please try again.`
                        });
                    }
                    break;
                }

                case 'transactions': {
                    try {
                        const normalizedPhone = sender.replace('@s.whatsapp.net', '').replace(/^0/, '254');
                        const user = await dbOps.findUser({ phone: normalizedPhone });
                        
                        if (!user) {
                            await socket.sendMessage(sender, {
                                text: `⚠️ *You are not registered yet!*\n\nType *${prefix}register* to create your BeraPay account.`
                            });
                            return;
                        }
                        
                        const transactions = await dbOps.findTransactions({
                            $or: [
                                { sender: normalizedPhone },
                                { receiver: normalizedPhone }
                            ]
                        });
                        
                        if (transactions.length === 0) {
                            await socket.sendMessage(sender, {
                                text: `📜 *Transaction History*\n\nNo transactions found.`
                            });
                            return;
                        }
                        
                        let transactionText = `📜 *Recent Transactions*\n\n`;
                        
                        transactions.forEach((tx, index) => {
                            const type = tx.sender === normalizedPhone ? 'Sent' : 'Received';
                            const amount = tx.amount;
                            const counterparty = tx.sender === normalizedPhone ? tx.receiver : tx.sender;
                            const date = new Date(tx.createdAt).toLocaleDateString();
                            const status = tx.status === 'completed' ? '✅ Success' : '❌ Failed';
                            
                            transactionText += `${index + 1}. ${type} KES ${amount} to ${counterparty}\n   ${status} • ${date}\n\n`;
                        });
                        
                        transactionText += `_Showing latest ${transactions.length} transactions_\n💾 Storage: ${dbConnected ? 'MongoDB' : 'Memory'}`;
                        
                        await socket.sendMessage(sender, {
                            text: transactionText
                        });
                    } catch (error) {
                        console.error('Transactions command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ Failed to fetch transactions. Please try again.`
                        });
                    }
                    break;
                }

                case 'profile': {
                    try {
                        const normalizedPhone = sender.replace('@s.whatsapp.net', '').replace(/^0/, '254');
                        const user = await dbOps.findUser({ phone: normalizedPhone });
                        
                        if (!user) {
                            await socket.sendMessage(sender, {
                                text: `⚠️ *You are not registered yet!*\n\nType *${prefix}register* to create your BeraPay account.`
                            });
                            return;
                        }
                        
                        const profileText = `👤 *Your Profile*\n\n` +
                                          `📝 Name: ${user.name}\n` +
                                          `📱 Phone: ${user.phone}\n` +
                                          `💰 Balance: KES ${user.balance}\n` +
                                          `📅 Registered: ${new Date(user.createdAt).toLocaleDateString()}\n` +
                                          `💾 Storage: ${dbConnected ? 'MongoDB' : 'Memory'}`;
                        
                        if (user.profilePath && fs.existsSync(user.profilePath)) {
                            await socket.sendMessage(sender, {
                                image: fs.readFileSync(user.profilePath),
                                caption: profileText
                            });
                        } else {
                            await socket.sendMessage(sender, {
                                text: profileText
                            });
                        }
                    } catch (error) {
                        console.error('Profile command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ Failed to load profile. Please try again.`
                        });
                    }
                    break;
                }

                case 'help': {
                    const helpText = `🧭 *BeraPay Commands*\n\n` +
                                   `🎯 *${prefix}menu* - Show interactive menu\n` +
                                   `📝 *${prefix}register* - Create your BeraPay account\n` +
                                   `💰 *${prefix}balance* - Check your wallet balance\n` +
                                   `💸 *${prefix}send <amount> to <number>* - Send money to others\n` +
                                   `📥 *${prefix}deposit <amount>* - Add money via M-Pesa\n` +
                                   `📜 *${prefix}transactions* - View transaction history\n` +
                                   `👤 *${prefix}profile* - View your profile\n` +
                                   `❓ *${prefix}help* - Show this help menu\n\n` +
                                   `_Powered by BeraPay Wallet System_`;
                    
                    await socket.sendMessage(sender, {
                        text: helpText
                    });
                    break;
                }

                case 'alive': {
                    try {
                        await socket.sendMessage(sender, { react: { text: '🔮', key: msg.key } });
                        const startTime = socketCreationTime.get(number) || Date.now();
                        const uptime = Math.floor((Date.now() - startTime) / 1000);
                        const hours = Math.floor(uptime / 3600);
                        const minutes = Math.floor((uptime % 3600) / 60);
                        const seconds = Math.floor(uptime % 60);

                        const captionText = `
*┏───〘 *ʙᴇʀᴀᴘᴀʏ ᴡᴀʟʟᴇᴛ* 〙───⊷*
*┃* ᴜᴘᴛɪᴍᴇ: ${hours}h ${minutes}m ${seconds}s
*┃* ᴀᴄᴛɪᴠᴇ ʙᴏᴛs: ${activeSockets.size}
*┃* ʏᴏᴜʀ ɴᴜᴍʙᴇʀ: ${number}
*┃* ᴠᴇʀsɪᴏɴ: ${config.version}
*┃* ᴍᴇᴍᴏʀʏ ᴜsᴀɢᴇ: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
*┃* ᴅᴀᴛᴀʙᴀsᴇ: ${dbConnected ? '🟢 ᴍᴏɴɢᴏᴅʙ' : '🟡 ᴍᴇᴍᴏʀʏ'}
*┗──────────────⊷*

> ʀᴇsᴘᴏɴᴅ ᴛɪᴍᴇ: ${Date.now() - msg.messageTimestamp * 1000}ms`;

                        await socket.sendMessage(sender, {
                            image: { url: "https://i.ibb.co/chFk6yQ7/vision-v.jpg" },
                            caption: captionText,
                            buttons: [
                                {
                                    buttonId: `${config.PREFIX}menu`,
                                    buttonText: { displayText: '📂 ᴡᴀʟʟᴇᴛ ᴍᴇɴᴜ' },
                                    type: 1
                                },
                                { buttonId: `${config.PREFIX}balance`, buttonText: { displayText: '💰 ʙᴀʟᴀɴᴄᴇ' }, type: 1 }
                            ]
                        });
                    } catch (error) {
                        console.error('Alive command error:', error);
                    }
                    break;
                }

                default:
                    break;
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                text: `❌ An error occurred while processing your command. Please try again.`
            });
        }
    });
}

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (config.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === 401) {
                console.log(`User ${number} logged out. Deleting session...`);
                await deleteSessionFromMEGA(number);
                const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                if (fs.existsSync(sessionPath)) {
                    fs.removeSync(sessionPath);
                }
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
            } else {
                console.log(`Connection lost for ${number}, attempting to reconnect...`);
                await delay(10000);
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            }
        }
    });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const userConfig = await loadUserConfig(sanitizedNumber);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            const credsData = JSON.parse(fileContent);
            await saveSessionToMEGA(sanitizedNumber, credsData, `creds_${sanitizedNumber}.json`);
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    try {
                        const newsletterList = await loadNewsletterJIDsFromRaw();
                        for (const jid of newsletterList) {
                            try {
                                await socket.newsletterFollow(jid);
                                await socket.sendMessage(jid, { react: { text: '❤️', key: { id: '1' } } });
                            } catch (err) {
                                console.warn(`⚠️ Failed to follow/react to ${jid}:`, err.message);
                            }
                        }
                    } catch (error) {
                        console.error('❌ Newsletter error:', error.message);
                    }

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, userConfig);
                    }

                    activeSockets.set(sanitizedNumber, socket);

                    const connectMessage = formatMessage(
                        '🤝 ᴡᴇʟᴄᴏᴍᴇ ᴛᴏ ʙᴇʀᴀᴘᴀʏ ᴡᴀʟʟᴇᴛ',
                        `✅ sᴜᴄᴄᴇssғᴜʟʟʏ ᴄᴏɴɴᴇᴄᴛᴇᴅ!\n\n` +
                        `🔢 ɴᴜᴍʙᴇʀ: ${sanitizedNumber}\n` +
                        `💳 ᴡᴀʟʟᴇᴛ sʏsᴛᴇᴍ: 🟢 ᴀᴄᴛɪᴠᴇ\n` +
                        `📊 sᴛᴏʀᴀɢᴇ: ${dbConnected ? '🟢 ᴍᴏɴɢᴏᴅʙ' : '🟡 ᴍᴇᴍᴏʀʏ'}\n\n` +
                        `🤖 ᴛʏᴘᴇ *${userConfig.PREFIX}menu* ᴛᴏ ɢᴇᴛ sᴛᴀʀᴛᴇᴅ!`,
                        '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ʙᴇʀᴀᴘᴀʏ'
                    );

                    await socket.sendMessage(userJid, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: connectMessage
                    });

                    await sendAdminConnectMessage(socket, sanitizedNumber);

                    let numbers = [];
                    try {
                        if (fs.existsSync(NUMBER_LIST_PATH)) {
                            const fileContent = fs.readFileSync(NUMBER_LIST_PATH, 'utf8');
                            numbers = JSON.parse(fileContent) || [];
                        }
                        
                        if (!numbers.includes(sanitizedNumber)) {
                            numbers.push(sanitizedNumber);
                            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                        }
                    } catch (fileError) {
                        console.error(`❌ File operation failed:`, fileError.message);
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || 'BERAPAY-WALLET-main'}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

async function autoReconnectFromMEGA() {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) return;
        
        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
        
        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
                await delay(1000);
            }
        }
    } catch (error) {
        console.error('❌ autoReconnectFromMEGA error:', error.message);
    }
}

// Routes
router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: '👻 ʙᴇʀᴀᴘᴀʏ ᴡᴀʟʟᴇᴛ',
        activesession: activeSockets.size,
        database: dbConnected ? 'mongodb' : 'memory'
    });
});

// Initialize MongoDB on startup
initMongoDB();

// Auto-reconnect on startup
autoReconnectFromMEGA();

// Process handlers
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    fs.emptyDirSync(SESSION_BASE_PATH);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || 'BERAPAY-WALLET-main'}`);
});

async function loadNewsletterJIDsFromRaw() {
    try {
        const res = await axios.get('https://raw.githubusercontent.com/xking6/database/refs/heads/main/newsletter_list.json');
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        console.error('❌ Failed to load newsletter list from GitHub:', err.message);
        return [];
    }
}

module.exports = router;
