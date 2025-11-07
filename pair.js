const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const moment = require('moment-timezone');
const axios = require('axios');
const { sms, downloadMediaMessage } = require("./msg");
const bcrypt = require('bcrypt');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');

// Import MEGA storage
const MegaStorage = require('./megaStorage');

const config = {
    AUTO_VIEW_STATUS: 'false',
    AUTO_LIKE_STATUS: 'false',
    AUTO_RECORDING: 'false',
    PREFIX: '.',
    MODE: 'public',
    MAX_RETRIES: 3,
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: 'https://i.ibb.co/chFk6yQ7/vision-v.jpg',
    version: '2.0.0',
    OWNER_NUMBER: '254740007567',
    BOT_FOOTER: 'ᴘᴏᴡᴇʀᴇᴅ ʙʏ ʙᴇʀᴀᴘᴀʏ',
    MEGA_EMAIL: 'beratech00@gmail.com',
    MEGA_PASSWORD: 'brucebera7824_',
    // PayHero Configuration from .env
    PAYHERO_BASE_URL: process.env.PAYHERO_BASE_URL,
    PAYHERO_AUTH_TOKEN: process.env.PAYHERO_AUTH_TOKEN,
    PAYHERO_CHANNEL_ID: process.env.PAYHERO_CHANNEL_ID,
    PAYHERO_PROVIDER: process.env.PAYHERO_PROVIDER || 'M-PESA',
    PAYHERO_BUSINESS_NUMBER: process.env.PAYHERO_BUSINESS_NUMBER,
    PAYHERO_CALLBACK_URL: process.env.PAYHERO_CALLBACK_URL
};

// Validate required environment variables
function validateConfig() {
    const required = [
        'PAYHERO_BASE_URL',
        'PAYHERO_AUTH_TOKEN', 
        'PAYHERO_CHANNEL_ID',
        'PAYHERO_BUSINESS_NUMBER',
        'PAYHERO_CALLBACK_URL'
    ];
    
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
        console.error('❌ Missing required environment variables:', missing);
        return false;
    }
    
    console.log('✅ All required environment variables are set');
    return true;
}

// Initialize MEGA storage with fallback
class LocalStorage {
    constructor() {
        this.localPath = './sessions';
        if (!fs.existsSync(this.localPath)) {
            fs.mkdirSync(this.localPath, { recursive: true });
        }
    }

    async uploadBuffer(buffer, filename) {
        const filePath = path.join(this.localPath, filename);
        await fs.writeFile(filePath, buffer);
        console.log(`✅ Session saved locally: ${filename}`);
        return true;
    }

    async downloadBuffer(filename) {
        const filePath = path.join(this.localPath, filename);
        if (fs.existsSync(filePath)) {
            return await fs.readFile(filePath);
        }
        return null;
    }

    async listFiles() {
        const files = await fs.readdir(this.localPath);
        return files.filter(file => file.endsWith('.json'));
    }

    async deleteFile(filename) {
        const filePath = path.join(this.localPath, filename);
        if (fs.existsSync(filePath)) {
            await fs.unlink(filePath);
            console.log(`✅ Local file deleted: ${filename}`);
        }
    }

    async fileExists(filename) {
        const filePath = path.join(this.localPath, filename);
        return fs.existsSync(filePath);
    }
}

let storage;
try {
    storage = new MegaStorage(config.MEGA_EMAIL, config.MEGA_PASSWORD);
    console.log('✅ MEGA storage initialized successfully');
} catch (error) {
    console.error('❌ MEGA storage failed, using local fallback:', error.message);
    storage = new LocalStorage();
}

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';
const registrationState = new Map();
const loginState = new Map();
const transactionState = new Map();
const pendingTransactions = new Map();

// MongoDB connection
const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://ellyongiro8:QwXDXE6tyrGpUTNb@cluster0.tyxcmm9.mongodb.net/berapay?retryWrites=true&w=majority&appName=Cluster0';
let db;
let dbConnected = false;

// Initialize MongoDB - FIXED NULL PHONE ISSUE
async function initMongoDB() {
    try {
        console.log('🔗 Connecting to MongoDB...');
        
        const client = new MongoClient(mongoUri, {
            serverSelectionTimeoutMS: 10000,
            connectTimeoutMS: 15000,
            socketTimeoutMS: 45000,
        });
        
        await client.connect();
        db = client.db();
        await db.command({ ping: 1 });
        
        const usersCollection = db.collection('users');
        const transactionsCollection = db.collection('transactions');
        
        try {
            // Clean up documents with null phone values first
            const nullPhoneCount = await usersCollection.countDocuments({ phone: null });
            if (nullPhoneCount > 0) {
                console.log(`🔄 Cleaning up ${nullPhoneCount} documents with null phone values...`);
                await usersCollection.deleteMany({ phone: null });
                console.log('✅ Cleaned up null phone documents');
            }
            
            // Get existing indexes
            const userIndexes = await usersCollection.indexes();
            
            // Drop existing phone index if it exists with wrong properties
            const existingPhoneIndex = userIndexes.find(index => 
                index.name === 'phone_1_unique' || 
                (index.key && index.key.phone === 1)
            );
            
            if (existingPhoneIndex) {
                try {
                    await usersCollection.dropIndex(existingPhoneIndex.name);
                    console.log('🔄 Dropped existing phone index');
                } catch (dropError) {
                    console.log('ℹ️ Could not drop existing index, may not exist:', dropError.message);
                }
            }
            
            // Create new phone index with proper configuration
            await usersCollection.createIndex({ phone: 1 }, { 
                unique: true, 
                name: 'phone_1_unique',
                background: true,
                partialFilterExpression: { phone: { $exists: true, $ne: null } }
            });
            console.log('✅ Created unique phone index for users');
            
        } catch (indexError) {
            console.log('ℹ️ Index creation issue (may already exist):', indexError.message);
        }
        
        // Create transactions indexes
        try {
            const transactionIndexes = await transactionsCollection.indexes();
            
            const transactionPhoneIndexExists = transactionIndexes.some(index => 
                index.name === 'transactions_phone_created'
            );
            if (!transactionPhoneIndexExists) {
                await transactionsCollection.createIndex({ phone: 1, createdAt: -1 }, { 
                    name: 'transactions_phone_created',
                    background: true 
                });
                console.log('✅ Created phone-created index for transactions');
            }
            
            const referenceIndexExists = transactionIndexes.some(index => 
                index.name === 'reference_unique'
            );
            if (!referenceIndexExists) {
                await transactionsCollection.createIndex({ reference: 1 }, { 
                    unique: true, 
                    name: 'reference_unique',
                    background: true 
                });
                console.log('✅ Created unique reference index for transactions');
            }
            
        } catch (txIndexError) {
            console.log('ℹ️ Transaction index creation issue:', txIndexError.message);
        }
        
        dbConnected = true;
        console.log('✅ MongoDB connected successfully');
        
    } catch (error) {
        console.error('❌ MongoDB connection failed:', error.message);
        dbConnected = false;
    }
}

// Real PayHero API Functions
async function initiateSTKPush(phone, amount, reference) {
    try {
        if (!validateConfig()) {
            throw new Error('PayHero configuration incomplete');
        }

        console.log(`🔄 Initiating REAL STK Push for ${phone}, Amount: ${amount}, Reference: ${reference}`);
        
        const response = await axios.post(`${config.PAYHERO_BASE_URL}/api/v1/stk/push`, {
            phone: phone.startsWith('254') ? phone : `254${phone.substring(phone.length - 9)}`,
            amount: amount,
            reference: reference,
            callback_url: config.PAYHERO_CALLBACK_URL,
            description: `BeraPay Deposit - ${reference}`
        }, {
            headers: {
                'Authorization': `Bearer ${config.PAYHERO_AUTH_TOKEN}`,
                'Channel-Id': config.PAYHERO_CHANNEL_ID,
                'Provider': config.PAYHERO_PROVIDER,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        console.log('✅ STK Push initiated successfully:', response.data);
        return {
            success: true,
            data: response.data,
            checkoutRequestId: response.data.CheckoutRequestID || response.data.request_id
        };
    } catch (error) {
        console.error('❌ STK Push initiation failed:', error.response?.data || error.message);
        return {
            success: false,
            error: error.response?.data?.message || error.response?.data?.error || error.message
        };
    }
}

async function initiateWithdrawal(phone, amount, reference) {
    try {
        if (!validateConfig()) {
            throw new Error('PayHero configuration incomplete');
        }

        console.log(`🔄 Initiating REAL withdrawal for ${phone}, Amount: ${amount}, Reference: ${reference}`);
        
        const response = await axios.post(`${config.PAYHERO_BASE_URL}/api/v1/b2c/payment`, {
            phone: phone.startsWith('254') ? phone : `254${phone.substring(phone.length - 9)}`,
            amount: amount,
            reference: reference,
            callback_url: config.PAYHERO_CALLBACK_URL,
            remarks: `BeraPay Withdrawal - ${reference}`
        }, {
            headers: {
                'Authorization': `Bearer ${config.PAYHERO_AUTH_TOKEN}`,
                'Channel-Id': config.PAYHERO_CHANNEL_ID,
                'Provider': config.PAYHERO_PROVIDER,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        console.log('✅ Withdrawal initiated successfully:', response.data);
        return {
            success: true,
            data: response.data,
            transactionId: response.data.TransactionID || response.data.transaction_id
        };
    } catch (error) {
        console.error('❌ Withdrawal initiation failed:', error.response?.data || error.message);
        return {
            success: false,
            error: error.response?.data?.message || error.response?.data?.error || error.message
        };
    }
}

async function initiateSendMoney(senderPhone, recipientPhone, amount, reference) {
    try {
        if (!validateConfig()) {
            throw new Error('PayHero configuration incomplete');
        }

        console.log(`🔄 Initiating REAL send money from ${senderPhone} to ${recipientPhone}, Amount: ${amount}`);
        
        const response = await axios.post(`${config.PAYHERO_BASE_URL}/api/v1/p2p/transfer`, {
            sender_phone: senderPhone.startsWith('254') ? senderPhone : `254${senderPhone.substring(senderPhone.length - 9)}`,
            recipient_phone: recipientPhone.startsWith('254') ? recipientPhone : `254${recipientPhone.substring(recipientPhone.length - 9)}`,
            amount: amount,
            reference: reference,
            callback_url: config.PAYHERO_CALLBACK_URL,
            description: `BeraPay Transfer - ${reference}`
        }, {
            headers: {
                'Authorization': `Bearer ${config.PAYHERO_AUTH_TOKEN}`,
                'Channel-Id': config.PAYHERO_CHANNEL_ID,
                'Provider': config.PAYHERO_PROVIDER,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        console.log('✅ Send Money initiated successfully:', response.data);
        return {
            success: true,
            data: response.data,
            transactionId: response.data.TransactionID || response.data.transaction_id
        };
    } catch (error) {
        console.error('❌ Send Money initiation failed:', error.response?.data || error.message);
        return {
            success: false,
            error: error.response?.data?.message || error.response?.data?.error || error.message
        };
    }
}

async function checkTransactionStatus(reference) {
    try {
        const response = await axios.get(`${config.PAYHERO_BASE_URL}/api/v1/transaction/${reference}`, {
            headers: {
                'Authorization': `Bearer ${config.PAYHERO_AUTH_TOKEN}`,
                'Channel-Id': config.PAYHERO_CHANNEL_ID
            },
            timeout: 15000
        });

        return {
            success: true,
            status: response.data.status,
            data: response.data
        };
    } catch (error) {
        console.error('Transaction status check failed:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

// Database operations
const dbOps = {
    async findUser(query) {
        if (!dbConnected) throw new Error('Database not connected');
        return await db.collection('users').findOne(query);
    },

    async updateUser(query, update, options = {}) {
        if (!dbConnected) throw new Error('Database not connected');
        return await db.collection('users').updateOne(query, update, options);
    },

    async insertTransaction(transaction) {
        if (!dbConnected) throw new Error('Database not connected');
        return await db.collection('transactions').insertOne(transaction);
    },

    async findTransactions(query, limit = 10) {
        if (!dbConnected) throw new Error('Database not connected');
        return await db.collection('transactions')
            .find(query)
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();
    },

    async updateUserBalance(phone, amountChange) {
        if (!dbConnected) throw new Error('Database not connected');
        return await db.collection('users').updateOne(
            { phone },
            { 
                $inc: { balance: amountChange },
                $set: { updatedAt: new Date() }
            }
        );
    },

    async updateTransaction(query, update) {
        if (!dbConnected) throw new Error('Database not connected');
        return await db.collection('transactions').updateOne(query, update);
    }
};

// Utility functions
function generateTransactionReference() {
    return 'BERA' + Date.now() + Math.random().toString(36).substr(2, 6).toUpperCase();
}

function normalizePhone(phone) {
    let normalized = phone.replace(/[^0-9]/g, '');
    if (normalized.startsWith('0')) {
        normalized = '254' + normalized.substring(1);
    }
    if (normalized.startsWith('7') && normalized.length === 9) {
        normalized = '254' + normalized;
    }
    return normalized;
}

function formatCurrency(amount) {
    return new Intl.NumberFormat('en-KE', {
        style: 'currency',
        currency: 'KES'
    }).format(amount);
}

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

function getSriLankaTimestamp() {
    return moment().tz('Africa/Nairobi').format('YYYY-MM-DD HH:mm:ss');
}

async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const files = await storage.listFiles();
        
        const sessionFiles = files.filter(filename => 
            filename.startsWith(`empire_${sanitizedNumber}_`) && filename.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        if (sessionFiles.length > 1) {
            for (let i = 1; i < sessionFiles.length; i++) {
                await storage.deleteFile(sessionFiles[i]);
                console.log(`Deleted duplicate session file: ${sessionFiles[i]}`);
            }
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

async function saveSessionToMEGA(number, sessionData, filename) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const buffer = Buffer.from(JSON.stringify(sessionData, null, 2));
        await storage.uploadBuffer(buffer, filename);
        console.log(`Session saved: ${filename}`);
    } catch (error) {
        console.error('Failed to save session:', error);
        throw error;
    }
}

async function loadSessionFromMEGA(filename) {
    try {
        const data = await storage.downloadBuffer(filename);
        return data ? JSON.parse(data.toString('utf8')) : null;
    } catch (error) {
        console.error('Failed to load session:', error);
        return null;
    }
}

async function deleteSessionFromMEGA(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const files = await storage.listFiles();
        
        const sessionFiles = files.filter(filename =>
            filename.includes(sanitizedNumber) && filename.endsWith('.json')
        );

        for (const file of sessionFiles) {
            await storage.deleteFile(file);
            console.log(`Deleted session file: ${file}`);
        }

        let numbers = [];
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
            numbers = numbers.filter(n => n !== sanitizedNumber);
            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
        }
    } catch (error) {
        console.error('Failed to delete session:', error);
    }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const files = await storage.listFiles();
        
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

async function sendAdminConnectMessage(socket, number) {
    const admins = loadAdmins();
    const caption = formatMessage(
        'ᴄᴏɴɴᴇᴄᴛᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ ✅',
        `📞 ɴᴜᴍʙᴇʀ: ${number}\n💳 ᴡᴀʟʟᴇᴛ: 🟢 ᴀᴄᴛɪᴠᴇ\n📊 ᴅᴀᴛᴀʙᴀsᴇ: 🟢 ᴍᴏɴɢᴏᴅʙ\n🩵 sᴛᴀᴛᴜs: Oɴʟɪɴᴇ`,
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
                console.log(`Connection lost for ${number}, will auto-reconnect on next message`);
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
            }
        }
    });
}

// Registration completion function
async function completeRegistration(socket, sender, userState) {
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
            text: `✅ *Registration Complete!*\n\nWelcome to BeraPay, ${userState.name}! 🎉\n\n📝 Name: ${userState.name}\n📱 Phone: ${normalizedPhone}\n💰 Initial Balance: ${formatCurrency(0)}\n🔐 PIN: ${'*'.repeat(4)} (Keep it safe!)\n\nType *${config.PREFIX}menu* to explore features.`,
            buttons: [
                {
                    buttonId: `${config.PREFIX}menu`,
                    buttonText: { displayText: '📂 Open Menu' },
                    type: 1
                }
            ]
        });
        
    } catch (error) {
        console.error('Registration completion error:', error);
        throw error;
    }
}

// Login verification function
async function verifyLogin(socket, sender, pin) {
    try {
        const normalizedPhone = sender.replace('@s.whatsapp.net', '').replace(/^0/, '254');
        const user = await dbOps.findUser({ phone: normalizedPhone });
        
        if (!user) {
            await socket.sendMessage(sender, {
                text: `❌ User not found! Please register first using *${config.PREFIX}register*`
            });
            loginState.delete(sender);
            return false;
        }
        
        const isPinValid = await bcrypt.compare(pin, user.pinHash);
        if (!isPinValid) {
            await socket.sendMessage(sender, {
                text: `❌ Invalid PIN! Please try again.`
            });
            return false;
        }
        
        loginState.delete(sender);
        await socket.sendMessage(sender, {
            text: `✅ *Login Successful!*\n\nWelcome back, ${user.name}! 🎉\n\n💰 Balance: ${formatCurrency(user.balance)}\n\nType *${config.PREFIX}menu* to continue.`,
            buttons: [
                {
                    buttonId: `${config.PREFIX}menu`,
                    buttonText: { displayText: '📂 Open Menu' },
                    type: 1
                }
            ]
        });
        
        return true;
    } catch (error) {
        console.error('Login verification error:', error);
        await socket.sendMessage(sender, {
            text: `❌ Login failed. Please try again.`
        });
        return false;
    }
}

// Setup registration reply handler
function setupRegistrationReplyHandler(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        const sender = msg.key.remoteJid;
        const userState = registrationState.get(sender);
        const userLoginState = loginState.get(sender);
        
        if (!userState && !userLoginState) return;

        const type = getContentType(msg.message);
        const body = (type === 'conversation') ? msg.message.conversation 
            : (type === 'extendedTextMessage') ? msg.message.extendedTextMessage.text 
            : '';

        // Skip if it's a command
        if (body.startsWith(config.PREFIX)) return;

        try {
            // Handle registration replies
            if (userState) {
                if (userState.step === 1) {
                    // Name step
                    if (body.trim().length < 2) {
                        await socket.sendMessage(sender, {
                            text: `❌ Please enter a valid name (at least 2 characters)`
                        });
                        return;
                    }

                    userState.name = body.trim();
                    userState.step = 2;
                    registrationState.set(sender, userState);
                    
                    await socket.sendMessage(sender, {
                        text: `🔐 *Registration - Step 2/3*\n\nPlease create a 4-digit PIN:\n\nExample: *1234*`
                    });

                } else if (userState.step === 2) {
                    // PIN step
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
                        text: `🖼️ *Registration - Step 3/3*\n\nYou can now optionally send a profile picture (image), or type *skip* to continue without one.`,
                        buttons: [
                            {
                                buttonId: `${config.PREFIX}skip_photo`,
                                buttonText: { displayText: '⏭️ Skip Photo' },
                                type: 1
                            }
                        ]
                    });

                } else if (userState.step === 3) {
                    // Profile picture step
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
                    
                    // Complete registration
                    await completeRegistration(socket, sender, userState);
                }
            }

            // Handle login replies
            if (userLoginState && userLoginState.step === 1) {
                const pin = body.trim();
                if (!/^\d{4}$/.test(pin)) {
                    await socket.sendMessage(sender, {
                        text: `❌ Invalid PIN format! Please enter exactly 4 digits.`
                    });
                    return;
                }
                
                await verifyLogin(socket, sender, pin);
            }

        } catch (error) {
            console.error('Registration/Login reply error:', error);
            await socket.sendMessage(sender, {
                text: `❌ Operation failed. Please try again.`
            });
            registrationState.delete(sender);
            loginState.delete(sender);
        }
    });
}

// Setup transaction reply handler
function setupTransactionReplyHandler(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        const sender = msg.key.remoteJid;
        const txState = transactionState.get(sender);
        
        if (!txState) return;

        const type = getContentType(msg.message);
        const body = (type === 'conversation') ? msg.message.conversation 
            : (type === 'extendedTextMessage') ? msg.message.extendedTextMessage.text 
            : '';

        // Skip if it's a command
        if (body.startsWith(config.PREFIX)) return;

        try {
            const normalizedPhone = sender.replace('@s.whatsapp.net', '').replace(/^0/, '254');
            const user = await dbOps.findUser({ phone: normalizedPhone });
            
            if (!user) {
                await socket.sendMessage(sender, {
                    text: `❌ User not found! Please register first.`
                });
                transactionState.delete(sender);
                return;
            }

            if (txState.type === 'withdraw') {
                if (txState.step === 1) {
                    // Amount step for withdrawal
                    const amount = parseInt(body.trim());
                    if (isNaN(amount) || amount < 10) {
                        await socket.sendMessage(sender, {
                            text: `❌ Invalid amount! Minimum withdrawal is KES 10`
                        });
                        return;
                    }

                    if (amount > user.balance) {
                        await socket.sendMessage(sender, {
                            text: `❌ Insufficient balance! You have ${formatCurrency(user.balance)}`
                        });
                        transactionState.delete(sender);
                        return;
                    }

                    if (amount > 50000) {
                        await socket.sendMessage(sender, {
                            text: `❌ Maximum withdrawal amount is KES 50,000`
                        });
                        return;
                    }

                    txState.amount = amount;
                    txState.step = 2;
                    transactionState.set(sender, txState);

                    await socket.sendMessage(sender, {
                        text: `🔐 *Withdrawal - Step 2/2*\n\nPlease enter your 4-digit PIN to confirm withdrawal of ${formatCurrency(amount)}:`
                    });

                } else if (txState.step === 2) {
                    // PIN verification for withdrawal
                    const pin = body.trim();
                    const isPinValid = await bcrypt.compare(pin, user.pinHash);
                    
                    if (!isPinValid) {
                        await socket.sendMessage(sender, {
                            text: `❌ Invalid PIN! Withdrawal cancelled.`
                        });
                        transactionState.delete(sender);
                        return;
                    }

                    // Process withdrawal
                    const reference = generateTransactionReference();
                    
                    await socket.sendMessage(sender, {
                        text: `🔄 *Processing Withdrawal...*\n\nAmount: ${formatCurrency(txState.amount)}\nPlease wait...`
                    });

                    const withdrawalResult = await initiateWithdrawal(normalizedPhone, txState.amount, reference);
                    
                    if (withdrawalResult.success) {
                        // Deduct balance immediately
                        await dbOps.updateUserBalance(normalizedPhone, -txState.amount);
                        
                        const transaction = {
                            sender: normalizedPhone,
                            receiver: normalizedPhone, // Self withdrawal
                            amount: txState.amount,
                            type: 'withdrawal',
                            status: 'pending',
                            reference: reference,
                            transactionId: withdrawalResult.transactionId,
                            createdAt: new Date(),
                            updatedAt: new Date()
                        };
                        
                        await dbOps.insertTransaction(transaction);
                        pendingTransactions.set(reference, { socket, sender, phone: normalizedPhone, amount: txState.amount, type: 'withdrawal' });
                        
                        await socket.sendMessage(sender, {
                            text: `✅ *Withdrawal Initiated!*\n\nAmount: ${formatCurrency(txState.amount)}\nReference: ${reference}\n\nYou will receive the money shortly. Check your M-PESA messages.`
                        });
                        
                    } else {
                        await socket.sendMessage(sender, {
                            text: `❌ *Withdrawal Failed!*\n\nError: ${withdrawalResult.error}\n\nPlease try again later.`
                        });
                    }

                    transactionState.delete(sender);
                }
            }

        } catch (error) {
            console.error('Transaction reply error:', error);
            await socket.sendMessage(sender, {
                text: `❌ Transaction failed. Please try again.`
            });
            transactionState.delete(sender);
        }
    });
}

async function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        const type = getContentType(msg.message);
        if (!msg.message) return;
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const m = sms(socket, msg);
        const body = (type === 'conversation') ? msg.message.conversation 
            : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type === 'extendedTextMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type == 'imageMessage') && msg.message.imageMessage.caption 
                ? msg.message.imageMessage.caption 
            : (type == 'videoMessage') && msg.message.videoMessage.caption 
                ? msg.message.videoMessage.caption 
            : '';
        let sender = msg.key.remoteJid;
        const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid);
        const senderNumber = nowsender.split('@')[0];
        const developers = `${config.OWNER_NUMBER}`;
        const botNumber = socket.user.id.split(':')[0];
        const isbot = botNumber.includes(senderNumber);
        const isOwner = isbot ? isbot : developers.includes(senderNumber);
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const command = body.startsWith(config.PREFIX) ? body.slice(config.PREFIX.length).trim().split(' ').shift().toLowerCase() : '';
        const args = body.trim().split(/ +/).slice(1);

        try {
            switch (command) {
                case 'menu':
                case 'beramenu': {
                    await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });
                    
                    const menuMessage = {
                        text: `🎯 *BeraPay Wallet System*\n\nYour secure digital wallet for real-time transactions\n\n💳 Real-time STK Push & Transfers\n🔐 PIN-protected security\n📊 MongoDB Database\n\nSelect an option below:`,
                        buttons: [
                            {
                                buttonId: `${config.PREFIX}register`,
                                buttonText: { displayText: '📝 Register' },
                                type: 1
                            },
                            {
                                buttonId: `${config.PREFIX}login`,
                                buttonText: { displayText: '🔐 Login' },
                                type: 1
                            },
                            {
                                buttonId: `${config.PREFIX}balance`,
                                buttonText: { displayText: '💰 Balance' },
                                type: 1
                            }
                        ],
                        sections: [
                            {
                                title: "Account Management",
                                rows: [
                                    {
                                        title: "📝 Register",
                                        description: "Create your BeraPay account",
                                        rowId: `${config.PREFIX}register`
                                    },
                                    {
                                        title: "🔐 Login",
                                        description: "Login to your account",
                                        rowId: `${config.PREFIX}login`
                                    },
                                    {
                                        title: "💰 Balance",
                                        description: "Check your wallet balance",
                                        rowId: `${config.PREFIX}balance`
                                    },
                                    {
                                        title: "👤 Profile",
                                        description: "View your profile",
                                        rowId: `${config.PREFIX}profile`
                                    }
                                ]
                            },
                            {
                                title: "Transactions",
                                rows: [
                                    {
                                        title: "📥 Deposit",
                                        description: "Add money via STK Push",
                                        rowId: `${config.PREFIX}deposit`
                                    },
                                    {
                                        title: "📤 Withdraw",
                                        description: "Withdraw to M-PESA",
                                        rowId: `${config.PREFIX}withdraw`
                                    },
                                    {
                                        title: "💸 Send Money",
                                        description: "Send to other users",
                                        rowId: `${config.PREFIX}send`
                                    },
                                    {
                                        title: "📜 History",
                                        description: "Transaction history",
                                        rowId: `${config.PREFIX}transactions`
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
                        // Check if already registered
                        const normalizedPhone = sender.replace('@s.whatsapp.net', '').replace(/^0/, '254');
                        const existingUser = await dbOps.findUser({ phone: normalizedPhone });
                        
                        if (existingUser) {
                            await socket.sendMessage(sender, {
                                text: `✅ *Already Registered!*\n\nYou are already registered as ${existingUser.name}.\n\nUse *${config.PREFIX}login* to access your account.`
                            });
                            return;
                        }

                        registrationState.set(sender, { step: 1 });
                        await socket.sendMessage(sender, {
                            text: `📝 *Registration - Step 1/3*\n\nPlease enter your full name:\n\nExample: *Bruce Bera*`
                        });
                    }
                    break;
                }

                case 'login': {
                    const normalizedPhone = sender.replace('@s.whatsapp.net', '').replace(/^0/, '254');
                    const user = await dbOps.findUser({ phone: normalizedPhone });
                    
                    if (!user) {
                        await socket.sendMessage(sender, {
                            text: `❌ *Not Registered!*\n\nPlease register first using *${config.PREFIX}register*`
                        });
                        return;
                    }

                    loginState.set(sender, { step: 1 });
                    await socket.sendMessage(sender, {
                        text: `🔐 *Login*\n\nPlease enter your 4-digit PIN:`
                    });
                    break;
                }

                case 'skip_photo': {
                    const userState = registrationState.get(sender);
                    if (userState && userState.step === 3) {
                        await completeRegistration(socket, sender, userState);
                    }
                    break;
                }

                case 'balance': {
                    try {
                        const normalizedPhone = sender.replace('@s.whatsapp.net', '').replace(/^0/, '254');
                        const user = await dbOps.findUser({ phone: normalizedPhone });
                        
                        if (!user) {
                            await socket.sendMessage(sender, {
                                text: `⚠️ *You are not registered yet!*\n\nType *${config.PREFIX}register* to create your BeraPay account.`
                            });
                            return;
                        }
                        
                        await socket.sendMessage(sender, {
                            text: `💰 *Your Wallet Balance*\n\nBalance: *${formatCurrency(user.balance)}*\n\nAccount: ${user.name}\nPhone: ${user.phone}\n\nLast updated: ${new Date(user.updatedAt).toLocaleString()}`
                        });
                    } catch (error) {
                        console.error('Balance check error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ Failed to check balance. Please try again.`
                        });
                    }
                    break;
                }

                case 'deposit': {
                    try {
                        const normalizedPhone = sender.replace('@s.whatsapp.net', '').replace(/^0/, '254');
                        const user = await dbOps.findUser({ phone: normalizedPhone });
                        
                        if (!user) {
                            await socket.sendMessage(sender, {
                                text: `⚠️ *You are not registered yet!*\n\nType *${config.PREFIX}register* to create your BeraPay account.`
                            });
                            return;
                        }
                        
                        const amount = parseInt(args[0]);
                        if (!amount || amount < 1) {
                            await socket.sendMessage(sender, {
                                text: `📌 *Usage:* ${config.PREFIX}deposit <amount>\n\nExample: ${config.PREFIX}deposit 1000\n\n💡 Minimum: KES 10\n💡 Maximum: KES 50,000`
                            });
                            return;
                        }

                        if (amount < 10) {
                            await socket.sendMessage(sender, {
                                text: `❌ Minimum deposit amount is KES 10`
                            });
                            return;
                        }

                        if (amount > 50000) {
                            await socket.sendMessage(sender, {
                                text: `❌ Maximum deposit amount is KES 50,000`
                            });
                            return;
                        }

                        const reference = generateTransactionReference();
                        
                        await socket.sendMessage(sender, {
                            text: `🔄 *Initiating STK Push...*\n\nAmount: ${formatCurrency(amount)}\nPlease wait...`
                        });

                        const stkResult = await initiateSTKPush(normalizedPhone, amount, reference);
                        
                        if (stkResult.success) {
                            const transaction = {
                                sender: normalizedPhone,
                                receiver: 'SYSTEM',
                                amount: amount,
                                type: 'deposit',
                                status: 'pending',
                                reference: reference,
                                checkoutRequestId: stkResult.checkoutRequestId,
                                createdAt: new Date(),
                                updatedAt: new Date()
                            };
                            
                            await dbOps.insertTransaction(transaction);
                            pendingTransactions.set(reference, { socket, sender, phone: normalizedPhone, amount, type: 'deposit' });
                            
                            await socket.sendMessage(sender, {
                                text: `📲 *STK Push Sent!*\n\nPlease check your phone to complete payment of ${formatCurrency(amount)}.\n\nReference: ${reference}\n\nYou will receive a confirmation message once payment is successful.`
                            });
                            
                        } else {
                            await socket.sendMessage(sender, {
                                text: `❌ *STK Push Failed!*\n\nError: ${stkResult.error}\n\nPlease try again later.`
                            });
                        }
                        
                    } catch (error) {
                        console.error('Deposit command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ Failed to process deposit. Please try again.`
                        });
                    }
                    break;
                }

                case 'withdraw': {
                    try {
                        const normalizedPhone = sender.replace('@s.whatsapp.net', '').replace(/^0/, '254');
                        const user = await dbOps.findUser({ phone: normalizedPhone });
                        
                        if (!user) {
                            await socket.sendMessage(sender, {
                                text: `⚠️ *You are not registered yet!*\n\nType *${config.PREFIX}register* to create your BeraPay account.`
                            });
                            return;
                        }

                        const amount = parseInt(args[0]);
                        if (!amount || amount < 1) {
                            await socket.sendMessage(sender, {
                                text: `📌 *Usage:* ${config.PREFIX}withdraw <amount>\n\nExample: ${config.PREFIX}withdraw 500\n\n💡 Minimum: KES 10\n💡 Maximum: KES 50,000`
                            });
                            return;
                        }

                        if (amount < 10) {
                            await socket.sendMessage(sender, {
                                text: `❌ Minimum withdrawal amount is KES 10`
                            });
                            return;
                        }

                        if (amount > user.balance) {
                            await socket.sendMessage(sender, {
                                text: `❌ Insufficient balance! You have ${formatCurrency(user.balance)}`
                            });
                            return;
                        }

                        if (amount > 50000) {
                            await socket.sendMessage(sender, {
                                text: `❌ Maximum withdrawal amount is KES 50,000`
                            });
                            return;
                        }

                        transactionState.set(sender, { type: 'withdraw', step: 1, amount: amount });
                        
                        await socket.sendMessage(sender, {
                            text: `📤 *Withdrawal - Step 1/2*\n\nAmount: ${formatCurrency(amount)}\n\nPlease enter your 4-digit PIN to continue:`
                        });
                        
                    } catch (error) {
                        console.error('Withdraw command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ Failed to process withdrawal. Please try again.`
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
                                text: `⚠️ *You are not registered yet!*\n\nType *${config.PREFIX}register* to create your BeraPay account.`
                            });
                            return;
                        }
                        
                        // Parse send command: "send 500 to 0712345678"
                        const match = body.match(/send\s+(\d+)\s+to\s+(\d+)/i);
                        if (!match) {
                            await socket.sendMessage(sender, {
                                text: `📌 *Usage:* ${config.PREFIX}send <amount> to <phone number>\n\nExample: ${config.PREFIX}send 500 to 0712345678\n\n💡 The recipient will receive money via M-PESA`
                            });
                            return;
                        }
                        
                        const amount = parseInt(match[1]);
                        let recipient = match[2].replace(/[^0-9]/g, '');
                        
                        // Normalize recipient phone
                        if (recipient.startsWith('0')) {
                            recipient = '254' + recipient.substring(1);
                        }
                        if (recipient.startsWith('7') && recipient.length === 9) {
                            recipient = '254' + recipient;
                        }
                        
                        // Validate amount
                        if (amount < 1) {
                            await socket.sendMessage(sender, {
                                text: `❌ Amount must be at least KES 1`
                            });
                            return;
                        }
                        
                        if (amount > user.balance) {
                            await socket.sendMessage(sender, {
                                text: `❌ Insufficient balance! You have ${formatCurrency(user.balance)}`
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

                        // Check if recipient is registered (optional - for internal transfers)
                        const recipientUser = await dbOps.findUser({ phone: recipient });
                        
                        const tempTransaction = {
                            sender: normalizedPhone,
                            recipient: recipient,
                            amount: amount,
                            recipientRegistered: !!recipientUser,
                            timestamp: Date.now()
                        };
                        
                        transactionState.set(sender + '_send', tempTransaction);
                        
                        const recipientInfo = recipientUser ? 
                            `Registered user: ${recipientUser.name}` : 
                            `External number: Will use M-PESA transfer`;
                        
                        await socket.sendMessage(sender, {
                            text: `💸 *Confirm Send Money*\n\nYou are about to send ${formatCurrency(amount)} to ${recipient}\n\n${recipientInfo}\n\nPlease confirm:`,
                            buttons: [
                                {
                                    buttonId: `${config.PREFIX}confirm_send`,
                                    buttonText: { displayText: '✅ Confirm Send' },
                                    type: 1
                                },
                                {
                                    buttonId: `${config.PREFIX}cancel_send`,
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
                        const tempTransaction = transactionState.get(sender + '_send');
                        if (!tempTransaction) {
                            await socket.sendMessage(sender, {
                                text: `❌ No pending transaction found`
                            });
                            return;
                        }
                        
                        const { sender: senderPhone, recipient, amount, recipientRegistered } = tempTransaction;
                        const reference = generateTransactionReference();
                        
                        await socket.sendMessage(sender, {
                            text: `🔄 *Processing Transaction...*\n\nSending ${formatCurrency(amount)} to ${recipient}\nPlease wait...`
                        });

                        let transactionStatus = 'pending';
                        let transactionError = null;
                        let transactionId = null;

                        // Always use PayHero for sending money (more reliable)
                        const sendResult = await initiateSendMoney(senderPhone, recipient, amount, reference);
                        
                        if (sendResult.success) {
                            await dbOps.updateUserBalance(senderPhone, -amount);
                            transactionStatus = 'completed';
                            transactionId = sendResult.transactionId;
                            
                            // Notify recipient if they are registered and online
                            if (recipientRegistered) {
                                const recipientJid = `${recipient}@s.whatsapp.net`;
                                const recipientSocket = activeSockets.get(recipient);
                                if (recipientSocket) {
                                    const recipientUser = await dbOps.findUser({ phone: recipient });
                                    await recipientSocket.sendMessage(recipientJid, {
                                        text: `💰 *Money Received!*\n\nYou received ${formatCurrency(amount)} from ${senderPhone}\n\nNew balance: ${formatCurrency(recipientUser.balance + amount)}`
                                    });
                                }
                            }
                            
                        } else {
                            transactionStatus = 'failed';
                            transactionError = sendResult.error;
                        }
                        
                        // Save transaction record
                        const transaction = {
                            sender: senderPhone,
                            receiver: recipient,
                            amount: amount,
                            type: 'send',
                            status: transactionStatus,
                            reference: reference,
                            transactionId: transactionId,
                            recipientRegistered: recipientRegistered,
                            error: transactionError,
                            createdAt: new Date(),
                            updatedAt: new Date()
                        };
                        
                        await dbOps.insertTransaction(transaction);
                        transactionState.delete(sender + '_send');
                        
                        if (transactionStatus === 'completed') {
                            const updatedUser = await dbOps.findUser({ phone: senderPhone });
                            await socket.sendMessage(sender, {
                                text: `✅ *Transaction Successful!*\n\nSent ${formatCurrency(amount)} to ${recipient}\n\nNew balance: ${formatCurrency(updatedUser.balance)}\nReference: ${reference}`
                            });
                        } else {
                            await socket.sendMessage(sender, {
                                text: `❌ *Transaction Failed*\n\nFailed to send ${formatCurrency(amount)} to ${recipient}\nError: ${transactionError}\n\nYour balance has not been deducted.`
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
                    transactionState.delete(sender + '_send');
                    await socket.sendMessage(sender, {
                        text: `❌ Transaction cancelled.`
                    });
                    break;
                }

                case 'transactions':
                case 'history': {
                    try {
                        const normalizedPhone = sender.replace('@s.whatsapp.net', '').replace(/^0/, '254');
                        const user = await dbOps.findUser({ phone: normalizedPhone });
                        
                        if (!user) {
                            await socket.sendMessage(sender, {
                                text: `⚠️ *You are not registered yet!*\n\nType *${config.PREFIX}register* to create your BeraPay account.`
                            });
                            return;
                        }
                        
                        const transactions = await dbOps.findTransactions({
                            $or: [
                                { sender: normalizedPhone },
                                { receiver: normalizedPhone }
                            ]
                        }, 10);
                        
                        if (transactions.length === 0) {
                            await socket.sendMessage(sender, {
                                text: `📜 *Transaction History*\n\nNo transactions found.\n\nStart by depositing or sending money.`
                            });
                            return;
                        }
                        
                        let transactionText = `📜 *Recent Transactions*\n\n`;
                        
                        transactions.forEach((tx, index) => {
                            const type = tx.sender === normalizedPhone ? 'Sent' : 'Received';
                            const amount = formatCurrency(tx.amount);
                            const counterparty = tx.sender === normalizedPhone ? tx.receiver : tx.sender;
                            const date = new Date(tx.createdAt).toLocaleDateString();
                            const status = tx.status === 'completed' ? '✅' : tx.status === 'pending' ? '🔄' : '❌';
                            const time = new Date(tx.createdAt).toLocaleTimeString();
                            
                            transactionText += `${index + 1}. ${type} ${amount}\n`;
                            transactionText += `   To: ${counterparty}\n`;
                            transactionText += `   ${status} ${tx.status} • ${date} ${time}\n\n`;
                        });
                        
                        transactionText += `_Showing latest ${transactions.length} transactions_`;
                        
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
                                text: `⚠️ *You are not registered yet!*\n\nType *${config.PREFIX}register* to create your BeraPay account.`
                            });
                            return;
                        }
                        
                        const profileText = `👤 *Your Profile*\n\n` +
                                          `📝 Name: ${user.name}\n` +
                                          `📱 Phone: ${user.phone}\n` +
                                          `💰 Balance: ${formatCurrency(user.balance)}\n` +
                                          `📅 Registered: ${new Date(user.createdAt).toLocaleDateString()}\n` +
                                          `🆔 User ID: ${user._id}`;
                        
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
                                   `🎯 *${config.PREFIX}menu* - Show interactive menu\n` +
                                   `📝 *${config.PREFIX}register* - Create your BeraPay account\n` +
                                   `🔐 *${config.PREFIX}login* - Login to your account\n` +
                                   `💰 *${config.PREFIX}balance* - Check your wallet balance\n` +
                                   `💸 *${config.PREFIX}send <amount> to <number>* - Send money to others\n` +
                                   `📥 *${config.PREFIX}deposit <amount>* - Add money via STK Push\n` +
                                   `📤 *${config.PREFIX}withdraw <amount>* - Withdraw to M-PESA\n` +
                                   `📜 *${config.PREFIX}transactions* - View transaction history\n` +
                                   `👤 *${config.PREFIX}profile* - View your profile\n` +
                                   `❓ *${config.PREFIX}help* - Show this help menu\n\n` +
                                   `_💳 Real-time STK Push & Transfers_\n` +
                                   `_🔒 Secure PIN-protected wallet_`;
                    
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
*┃* ᴅᴀᴛᴀʙᴀsᴇ: ${dbConnected ? '🟢 ᴍᴏɴɢᴏᴅʙ' : '🔴 ᴏꜰꜰʟɪɴᴇ'}
*┃* ᴘᴀʏᴍᴇɴᴛs: ${validateConfig() ? '🟢 ʀᴇᴀʟ-ᴛɪᴍᴇ' : '🔴 ᴍɪssɪɴɢ ᴄʀᴇᴅs'}
*┗──────────────⊷*

> ʀᴇsᴘᴏɴᴅ ᴛɪᴍᴇ: ${Date.now() - msg.messageTimestamp * 1000}ms`;

                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
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

        // Setup all handlers
        setupCommandHandlers(socket, sanitizedNumber);
        setupRegistrationReplyHandler(socket);
        setupTransactionReplyHandler(socket);
        setupAutoRestart(socket, sanitizedNumber);

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

                    activeSockets.set(sanitizedNumber, socket);

                    const connectMessage = formatMessage(
                        '🤝 ᴡᴇʟᴄᴏᴍᴇ ᴛᴏ ʙᴇʀᴀᴘᴀʏ ᴡᴀʟʟᴇᴛ',
                        `✅ sᴜᴄᴄᴇssғᴜʟʟʏ ᴄᴏɴɴᴇᴄᴛᴇᴅ!\n\n` +
                        `🔢 ɴᴜᴍʙᴇʀ: ${sanitizedNumber}\n` +
                        `💳 ᴡᴀʟʟᴇᴛ sʏsᴛᴇᴍ: 🟢 ᴀᴄᴛɪᴠᴇ\n` +
                        `📊 ᴅᴀᴛᴀʙᴀsᴇ: ${dbConnected ? '🟢 ᴍᴏɴɢᴏᴅʙ' : '🔴 ᴏꜰꜰʟɪɴᴇ'}\n` +
                        `💰 ᴘᴀʏᴍᴇɴᴛs: ${validateConfig() ? '🟢 ʀᴇᴀʟ-ᴛɪᴍᴇ' : '🔴 ᴍɪssɪɴɢ ᴄʀᴇᴅs'}\n\n` +
                        `🤖 ᴛʏᴘᴇ *${config.PREFIX}menu* ᴛᴏ ɢᴇᴛ sᴛᴀʀᴛᴇᴅ!`,
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

// PayHero Callback Handler - REAL IMPLEMENTATION
router.post('/api/payhero/callback', async (req, res) => {
    try {
        const { reference, status, amount, phone, transaction_id, error_message } = req.body;
        
        console.log('🔔 REAL PayHero callback received:', { reference, status, amount, phone, transaction_id });

        // Update transaction status in database
        await dbOps.updateTransaction(
            { reference: reference },
            { 
                $set: { 
                    status: status,
                    transactionId: transaction_id,
                    error: error_message,
                    updatedAt: new Date()
                }
            }
        );

        const pendingTx = pendingTransactions.get(reference);
        
        if (status === 'success' && pendingTx) {
            // For deposits, add balance (already deducted for withdrawals/sends)
            if (pendingTx.type === 'deposit') {
                await dbOps.updateUserBalance(phone, amount);
            }
            
            // Notify user
            const { socket, sender } = pendingTx;
            const user = await dbOps.findUser({ phone });
            
            if (user) {
                let message = '';
                if (pendingTx.type === 'deposit') {
                    message = `✅ *Deposit Successful!*\n\nAmount: ${formatCurrency(amount)}\nNew Balance: ${formatCurrency(user.balance)}\nReference: ${reference}\nTransaction ID: ${transaction_id}`;
                } else if (pendingTx.type === 'withdrawal') {
                    message = `✅ *Withdrawal Successful!*\n\nAmount: ${formatCurrency(amount)}\nNew Balance: ${formatCurrency(user.balance)}\nReference: ${reference}\nTransaction ID: ${transaction_id}\n\n💡 Check your M-PESA messages for confirmation.`;
                } else if (pendingTx.type === 'send') {
                    message = `✅ *Send Money Successful!*\n\nAmount: ${formatCurrency(amount)}\nNew Balance: ${formatCurrency(user.balance)}\nReference: ${reference}\nTransaction ID: ${transaction_id}`;
                }
                
                await socket.sendMessage(sender, { text: message });
            }
            
            console.log(`✅ ${pendingTx.type} completed for ${phone}: ${formatCurrency(amount)}`);
            pendingTransactions.delete(reference);
            
        } else if (status === 'failed' && pendingTx) {
            const { socket, sender } = pendingTx;
            
            // Refund balance for failed withdrawals/sends
            if (pendingTx.type !== 'deposit') {
                await dbOps.updateUserBalance(phone, pendingTx.amount);
            }
            
            let message = `❌ *Transaction Failed!*\n\nAmount: ${formatCurrency(pendingTx.amount)}\nError: ${error_message || 'Transaction failed'}\nReference: ${reference}`;
            
            if (pendingTx.type !== 'deposit') {
                message += `\n\n💡 Your balance has been refunded.`;
            }
            
            await socket.sendMessage(sender, { text: message });
            
            console.log(`❌ ${pendingTx.type} failed for ${phone}: ${error_message}`);
            pendingTransactions.delete(reference);
        }

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('PayHero callback error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

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
        numbers: Array.from(activeSockets.keys()),
        database: dbConnected ? 'connected' : 'disconnected'
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: '👻 ʙᴇʀᴀᴘᴀʏ ᴡᴀʟʟᴇᴛ',
        activesession: activeSockets.size,
        database: dbConnected ? 'connected' : 'disconnected',
        payhero: validateConfig() ? 'configured' : 'missing credentials'
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
});

module.exports = router;
