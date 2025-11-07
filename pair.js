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
    GROUP_INVITE_LINK: '',
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

// MongoDB connection
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/berapay';
let db;

// Initialize MongoDB
async function initMongoDB() {
    try {
        const client = new MongoClient(mongoUri);
        await client.connect();
        db = client.db();
        console.log('✅ MongoDB connected successfully');
    } catch (error) {
        console.error('❌ MongoDB connection failed:', error);
    }
}

// Registration state tracking
const registrationState = new Map();

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
        
        // Convert session data to buffer and upload directly
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

        // Update local number list
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
            console.warn(`No configuration found for ${number}, using default config`);
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
        console.warn(`No configuration found for ${number}, using default config`);
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

// Count total commands in pair.js
let totalcmds = async () => {
    try {
        const filePath = "./pair.js";
        const mytext = await fs.readFile(filePath, "utf-8");

        // Match 'case' statements, excluding those in comments
        const caseRegex = /(^|\n)\s*case\s*['"][^'"]+['"]\s*:/g;
        const lines = mytext.split("\n");
        let count = 0;

        for (const line of lines) {
            // Skip lines that are comments
            if (line.trim().startsWith("//") || line.trim().startsWith("/*")) continue;
            // Check if line matches case statement
            if (line.match(/^\s*case\s*['"][^'"]+['"]\s*:/)) {
                count++;
            }
        }

        return count;
    } catch (error) {
        console.error("Error reading pair.js:", error.message);
        return 0; // Return 0 on error to avoid breaking the bot
    }
}

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES || 3;
    let inviteCode = 'GBz10zMKECuEKUlmfNsglx'; // Hardcoded default
    if (config.GROUP_INVITE_LINK) {
        const cleanInviteLink = config.GROUP_INVITE_LINK.split('?')[0]; // Remove query params
        const inviteCodeMatch = cleanInviteLink.match(/chat\.whatsapp\.com\/(?:invite\/)?([a-zA-Z0-9_-]+)/);
        if (!inviteCodeMatch) {
            console.error('Invalid group invite link format:', config.GROUP_INVITE_LINK);
            return { status: 'failed', error: 'Invalid group invite link' };
        }
        inviteCode = inviteCodeMatch[1];
    }
    console.log(`Attempting to join group with invite code: ${inviteCode}`);

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            console.log('Group join response:', JSON.stringify(response, null, 2)); // Debug response
            if (response?.gid) {
                console.log(`[ ✅ ] Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message.includes('gone') || error.message.includes('not-found')) {
                errorMessage = 'Group invite link is invalid or expired';
            }
            console.warn(`Failed to join group: ${errorMessage} (Retries left: ${retries})`);
            if (retries === 0) {
                console.error('[ ❌ ] Failed to join group', { error: errorMessage });
                try {
                    await socket.sendMessage(config.OWNER_NUMBER + '@s.whatsapp.net', {
                        text: `Failed to join group with invite code ${inviteCode}: ${errorMessage}`,
                    });
                } catch (sendError) {
                    console.error(`Failed to send failure message to owner: ${sendError.message}`);
                }
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries + 1));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const groupStatus = groupResult.status === 'success'
        ? `ᴊᴏɪɴᴇᴅ (ID: ${groupResult.gid})`
        : `ɢʀᴜᴘ ᴊᴏɪɴ ғᴀɪʟ: ${groupResult.error}`;
    const caption = formatMessage(
        'ᴄᴏɴɴᴇᴄᴛᴇᴅ sᴜᴄᴄᴇssᴇғᴜʟʟʏ ✅',
        `📞 ɴᴜᴍʙᴇʀ: ${number}\n🩵 sᴛᴀᴛᴜs: Oɴʟɪɴᴇ`,
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
            console.log(`Connect message sent to admin ${admin}`);
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

            if (!messageId) {
                console.warn('No newsletterServerId found in message:', message);
                return;
            }

            let retries = 3;
            while (retries-- > 0) {
                try {
                    await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                    console.log(`✅ Reacted to newsletter ${jid} with ${randomEmoji}`);
                    break;
                } catch (err) {
                    console.warn(`❌ Reaction attempt failed (${3 - retries}/3):`, err.message);
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
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
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
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
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
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
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
        const quoted =
            type == "extendedTextMessage" &&
            msg.message.extendedTextMessage.contextInfo != null
              ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
              : [];
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

        // Restrict commands in self mode to owner only
        if (mode === 'self' && !isOwner) {
            return; // Silently ignore commands from non-owners in self mode
        }

        async function isGroupAdmin(jid, user) {
            try {
                const groupMetadata = await socket.groupMetadata(jid);
                const participant = groupMetadata.participants.find(p => p.id === user);
                return participant?.admin === 'admin' || participant?.admin === 'superadmin' || false;
            } catch (error) {
                console.error('Error checking group admin status:', error);
                return false;
            }
        }

        const isSenderGroupAdmin = isGroup ? await isGroupAdmin(from, nowsender) : false;

        socket.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
            let quoted = message.msg ? message.msg : message;
            let mime = (message.msg || message).mimetype || '';
            let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            let type = await FileType.fromBuffer(buffer);
            trueFileName = attachExtension ? (filename + '.' + type.ext) : filename;
            await fs.writeFileSync(trueFileName, buffer);
            return trueFileName;
        };

        if (!command) return;
        const count = await totalcmds();

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
                // ==================== BERAPAY WALLET COMMANDS ====================
                case 'menu':
                case 'beramenu': {
                    await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });
                    
                    const menuMessage = {
                        text: `🎯 *BeraPay Wallet System*\n\nYour secure digital wallet for seamless transactions`,
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
                        // Step 1: Start registration - ask for full name
                        registrationState.set(sender, { step: 1 });
                        await socket.sendMessage(sender, {
                            text: `📝 *Registration - Step 1/3*\n\nPlease enter your full name:`
                        });
                    } else if (userState.step === 1) {
                        // Step 2: Save name and ask for PIN
                        userState.name = body.trim();
                        userState.step = 2;
                        registrationState.set(sender, userState);
                        
                        await socket.sendMessage(sender, {
                            text: `🔐 *Registration - Step 2/3*\n\nPlease create a 4-digit PIN:`
                        });
                    } else if (userState.step === 2) {
                        // Step 3: Validate and save PIN
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
                        // Handle profile image or completion
                        if (type === 'imageMessage') {
                            try {
                                // Download and save profile image
                                const mediaBuffer = await downloadMediaMessage(msg, 'buffer', {});
                                const filename = `profile_${sender.replace('@s.whatsapp.net', '')}_${Date.now()}.jpg`;
                                userState.profilePath = filename;
                                await fs.writeFileSync(filename, mediaBuffer);
                            } catch (error) {
                                console.error('Error saving profile image:', error);
                            }
                        }
                        
                        // Complete registration
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
                            
                            // Save to MongoDB
                            if (db) {
                                await db.collection('users').updateOne(
                                    { phone: normalizedPhone },
                                    { $set: userData },
                                    { upsert: true }
                                );
                            }
                            
                            // Clear registration state
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
                        
                        if (db) {
                            const user = await db.collection('users').findOne({ phone: normalizedPhone });
                            
                            if (!user) {
                                await socket.sendMessage(sender, {
                                    text: `⚠️ *You are not registered yet!*\n\nType *${prefix}register* to create your BeraPay account.`
                                });
                                return;
                            }
                            
                            await socket.sendMessage(sender, {
                                text: `💰 *Your Wallet Balance*\n\nBalance: *KES ${user.balance}*\n\nAccount: ${user.name}\nPhone: ${user.phone}`
                            });
                        } else {
                            await socket.sendMessage(sender, {
                                text: `❌ Database connection unavailable. Please try again later.`
                            });
                        }
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
                        
                        if (db) {
                            const user = await db.collection('users').findOne({ phone: normalizedPhone });
                            
                            if (!user) {
                                await socket.sendMessage(sender, {
                                    text: `⚠️ *You are not registered yet!*\n\nType *${prefix}register* to create your BeraPay account.`
                                });
                                return;
                            }
                            
                            // Parse send command: "send 500 to 0712345678"
                            const match = body.match(/send\s+(\d+)\s+to\s+(\d+)/i);
                            if (!match) {
                                await socket.sendMessage(sender, {
                                    text: `📌 *Usage:* ${prefix}send <amount> to <phone number>\n\nExample: ${prefix}send 500 to 0712345678`
                                });
                                return;
                            }
                            
                            const amount = parseInt(match[1]);
                            let recipient = match[2].replace(/^0/, '254');
                            
                            // Validate amount
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
                            
                            // Prevent sending to self
                            if (recipient === normalizedPhone) {
                                await socket.sendMessage(sender, {
                                    text: `❌ You cannot send money to yourself`
                                });
                                return;
                            }
                            
                            // Store transaction data temporarily for confirmation
                            const tempTransaction = {
                                sender: normalizedPhone,
                                recipient: recipient,
                                amount: amount,
                                timestamp: Date.now()
                            };
                            
                            registrationState.set(sender + '_send', tempTransaction);
                            
                            // Send confirmation buttons
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
                            
                        } else {
                            await socket.sendMessage(sender, {
                                text: `❌ Database connection unavailable. Please try again later.`
                            });
                        }
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
                        
                        // Create transaction record
                        const transaction = {
                            sender: senderPhone,
                            receiver: recipient,
                            amount: amount,
                            type: 'send',
                            status: 'pending',
                            createdAt: new Date()
                        };
                        
                        if (db) {
                            // Check if recipient exists in BeraPay
                            const recipientUser = await db.collection('users').findOne({ phone: recipient });
                            
                            if (recipientUser) {
                                // Internal transfer
                                await db.collection('users').updateOne(
                                    { phone: senderPhone },
                                    { $inc: { balance: -amount } }
                                );
                                await db.collection('users').updateOne(
                                    { phone: recipient },
                                    { $inc: { balance: amount } }
                                );
                                transaction.status = 'completed';
                                
                            } else {
                                // External transfer via PayHero
                                try {
                                    const response = await axios.post('http://your-backend-url/api/send', {
                                        sender: senderPhone,
                                        recipient: recipient,
                                        amount: amount
                                    }, {
                                        headers: {
                                            'Authorization': process.env.AUTH_TOKEN,
                                            'ChannelId': process.env.CHANNEL_ID,
                                            'Provider': process.env.DEFAULT_PROVIDER
                                        }
                                    });
                                    
                                    if (response.data.success) {
                                        await db.collection('users').updateOne(
                                            { phone: senderPhone },
                                            { $inc: { balance: -amount } }
                                        );
                                        transaction.status = 'completed';
                                        transaction.externalId = response.data.transactionId;
                                    } else {
                                        transaction.status = 'failed';
                                        transaction.error = response.data.error;
                                    }
                                } catch (apiError) {
                                    console.error('PayHero API error:', apiError);
                                    transaction.status = 'failed';
                                    transaction.error = 'API call failed';
                                }
                            }
                            
                            // Save transaction
                            await db.collection('transactions').insertOne(transaction);
                            
                            // Clear temporary data
                            registrationState.delete(sender + '_send');
                            
                            if (transaction.status === 'completed') {
                                await socket.sendMessage(sender, {
                                    text: `✅ *Transaction Successful!*\n\nSent *KES ${amount}* to *${recipient}*\n\nNew balance: KES ${(await db.collection('users').findOne({ phone: senderPhone })).balance}`
                                });
                            } else {
                                await socket.sendMessage(sender, {
                                    text: `❌ *Transaction Failed*\n\nFailed to send KES ${amount} to ${recipient}\nError: ${transaction.error}`
                                });
                            }
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
                        
                        if (db) {
                            const user = await db.collection('users').findOne({ phone: normalizedPhone });
                            
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
                            
                            // Call backend to initiate STK Push
                            try {
                                const response = await axios.post('http://your-backend-url/api/deposit', {
                                    phone: normalizedPhone,
                                    amount: amount
                                }, {
                                    headers: {
                                        'Authorization': process.env.AUTH_TOKEN,
                                        'ChannelId': process.env.CHANNEL_ID,
                                        'Provider': process.env.DEFAULT_PROVIDER
                                    }
                                });
                                
                                if (response.data.success) {
                                    await socket.sendMessage(sender, {
                                        text: `📲 *STK Push Sent!*\n\nPlease check your phone to complete payment of KES ${amount}.\n\nYou will receive a confirmation message once payment is successful.`
                                    });
                                } else {
                                    await socket.sendMessage(sender, {
                                        text: `❌ Failed to initiate deposit. Please try again.`
                                    });
                                }
                            } catch (apiError) {
                                console.error('Deposit API error:', apiError);
                                await socket.sendMessage(sender, {
                                    text: `❌ Service temporarily unavailable. Please try again later.`
                                });
                            }
                        }
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
                        
                        if (db) {
                            const user = await db.collection('users').findOne({ phone: normalizedPhone });
                            
                            if (!user) {
                                await socket.sendMessage(sender, {
                                    text: `⚠️ *You are not registered yet!*\n\nType *${prefix}register* to create your BeraPay account.`
                                });
                                return;
                            }
                            
                            // Get latest 5 transactions
                            const transactions = await db.collection('transactions')
                                .find({
                                    $or: [
                                        { sender: normalizedPhone },
                                        { receiver: normalizedPhone }
                                    ]
                                })
                                .sort({ createdAt: -1 })
                                .limit(5)
                                .toArray();
                            
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
                            
                            transactionText += `_Showing latest ${transactions.length} transactions_`;
                            
                            await socket.sendMessage(sender, {
                                text: transactionText,
                                buttons: [
                                    {
                                        buttonId: `${prefix}transactions_more`,
                                        buttonText: { displayText: '📖 View More' },
                                        type: 1
                                    }
                                ]
                            });
                        }
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
                        
                        if (db) {
                            const user = await db.collection('users').findOne({ phone: normalizedPhone });
                            
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
                                              `📅 Registered: ${new Date(user.createdAt).toLocaleDateString()}`;
                            
                            if (user.profilePath && fs.existsSync(user.profilePath)) {
                                // Send profile with image
                                await socket.sendMessage(sender, {
                                    image: fs.readFileSync(user.profilePath),
                                    caption: profileText
                                });
                            } else {
                                // Send text only
                                await socket.sendMessage(sender, {
                                    text: profileText
                                });
                            }
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

                // ==================== EXISTING COMMANDS (KEEP AS IS) ====================
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
*┗──────────────⊷*

> ʀᴇsᴘᴏɴᴅ ᴛɪᴍᴇ: ${Date.now() - msg.messageTimestamp * 1000}ms`;

                        const aliveMessage = {
                            image: { url: "https://i.ibb.co/chFk6yQ7/vision-v.jpg" },
                            caption: `> ᴀᴍ ᴀʟɪᴠᴇ ɴ ᴋɪᴄᴋɪɴɢ 🥳\n\n${captionText}`,
                            buttons: [
                                {
                                    buttonId: `${config.PREFIX}menu`,
                                    buttonText: { displayText: '📂 ᴡᴀʟʟᴇᴛ ᴍᴇɴᴜ' },
                                    type: 1
                                },
                                { buttonId: `${config.PREFIX}balance`, buttonText: { displayText: '💰 ʙᴀʟᴀɴᴄᴇ' }, type: 1 },
                                { buttonId: `${config.PREFIX}help`, buttonText: { displayText: '❓ ʜᴇʟᴘ' }, type: 1 }
                            ],
                            headerType: 1,
                            viewOnce: true
                        };

                        await socket.sendMessage(m.chat, aliveMessage, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Alive command error:', error);
                        const startTime = socketCreationTime.get(number) || Date.now();
                        const uptime = Math.floor((Date.now() - startTime) / 1000);
                        const hours = Math.floor(uptime / 3600);
                        const minutes = Math.floor((uptime % 3600) / 60);
                        const seconds = Math.floor(uptime % 60);

                        await socket.sendMessage(m.chat, {
                            image: { url: "https://i.ibb.co/chFk6yQ7/vision-v.jpg" },
                            caption: `*🤖 ʙᴇʀᴀᴘᴀʏ ᴡᴀʟʟᴇᴛ ᴀʟɪᴠᴇ*\n\n` +
                                    `*┏───〘 *ʙᴇʀᴀᴘᴀʏ ᴡᴀʟʟᴇᴛ* 〙───⊷*\n` +
                                    `*┃* ᴜᴘᴛɪᴍᴇ: ${hours}h ${minutes}m ${seconds}s\n` +
                                    `*┃* sᴛᴀᴛᴜs: ᴏɴʟɪɴᴇ\n` +
                                    `*┃* ɴᴜᴍʙᴇʀ: ${number}\n` +
                                    `*┗──────────────⊷*\n\n` +
                                    `Type *${config.PREFIX}menu* for wallet commands`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Include all your other existing commands here...
                // case 'ping': { ... }
                // case 'song': { ... }
                // case 'video': { ... }
                // etc...

                default:
                    // Handle unknown commands
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
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
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
                    console.log(`Deleted local session folder for ${number}`);
                }

                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));

                try {
                    await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been deleted due to logout.',
                            'ʙᴇʀᴀᴘᴀʏ ᴡᴀʟʟᴇᴛ ʙᴏᴛ'
                        )
                    });
                } catch (error) {
                    console.error(`Failed to notify ${number} about session deletion:`, error);
                }

                console.log(`Session cleanup completed for ${number}`);
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
                    console.warn(`Failed to request pairing code: ${retries}, error.message`, retries);
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
            console.log(`Updated creds for ${sanitizedNumber} in MEGA`);
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    const groupResult = await joinGroup(socket);

                    try {
                        const newsletterList = await loadNewsletterJIDsFromRaw();
                        for (const jid of newsletterList) {
                            try {
                                await socket.newsletterFollow(jid);
                                await socket.sendMessage(jid, { react: { text: '❤️', key: { id: '1' } } });
                                console.log(`✅ Followed and reacted to newsletter: ${jid}`);
                            } catch (err) {
                                console.warn(`⚠️ Failed to follow/react to ${jid}:`, err.message);
                            }
                        }
                        console.log('✅ Auto-followed newsletter & reacted');
                    } catch (error) {
                        console.error('❌ Newsletter error:', error.message);
                    }

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, userConfig);
                    }

                    activeSockets.set(sanitizedNumber, socket);

                    const groupStatus = groupResult.status === 'success'
                        ? 'ᴊᴏɪɴᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ'
                        : `ғᴀɪʟᴇᴅ ᴛᴏ ᴊᴏɪɴ ɢʀᴏᴜᴘ: ${groupResult.error}`;

                    await socket.sendMessage(userJid, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🤝 ᴡᴇʟᴄᴏᴍᴇ ᴛᴏ ʙᴇʀᴀᴘᴀʏ ᴡᴀʟʟᴇᴛ',
                            `✅ sᴜᴄᴄᴇssғᴜʟʟʏ ᴄᴏɴɴᴇᴄᴛᴇᴅ!\n\n` +
                            `🔢 ɴᴜᴍʙᴇʀ: ${sanitizedNumber}\n` +
                            `💰 ʙᴇʀᴀᴘᴀʏ ᴡᴀʟʟᴇᴛ ʀᴇᴀᴅʏ\n` +
                            `🤖 ᴛʏᴘᴇ *${userConfig.PREFIX}menu* ᴛᴏ ɢᴇᴛ sᴛᴀʀᴛᴇᴅ!`,
                            '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ʙᴇʀᴀᴘᴀʏ'
                        )
                    });

                    await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);

                    let numbers = [];
                    try {
                        if (fs.existsSync(NUMBER_LIST_PATH)) {
                            const fileContent = fs.readFileSync(NUMBER_LIST_PATH, 'utf8');
                            numbers = JSON.parse(fileContent) || [];
                        }
                        
                        if (!numbers.includes(sanitizedNumber)) {
                            numbers.push(sanitizedNumber);
                            
                            if (fs.existsSync(NUMBER_LIST_PATH)) {
                                fs.copyFileSync(NUMBER_LIST_PATH, NUMBER_LIST_PATH + '.backup');
                            }
                            
                            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                            console.log(`📝 Added ${sanitizedNumber} to number list`);
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

// Update the autoReconnectFromMEGA function
async function autoReconnectFromMEGA() {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) return;
        
        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
        
        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
                console.log(`🔁 Reconnected from MEGA: ${number}`);
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
        activesession: activeSockets.size
    });
});

router.get('/connect-all', async (req, res) => {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) {
            return res.status(404).send({ error: 'No numbers found to reconnect' });
        }

        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        const results = [];
        
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(number, mockRes);
                results.push({ number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${number}:`, error);
                results.push({ number, status: 'failed', error: error.message });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
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
