const { storage } = require('megajs');
const fs = require('fs-extra');
const path = require('path');

class MegaStorage {
    constructor(email, password) {
        this.email = email;
        this.password = password;
        this.storage = null;
        this.isAuthenticated = false;
        this.retryCount = 0;
        this.maxRetries = 3;
    }

    async initialize() {
        try {
            console.log('🔄 Initializing MEGA storage...');
            
            // Clear any existing sessions first
            await this.clearLocalSessions();
            
            this.storage = await storage.login({
                email: this.email,
                password: this.password,
                keepalive: true
            });
            
            this.isAuthenticated = true;
            this.retryCount = 0;
            console.log('✅ MEGA storage authenticated successfully');
            return true;
            
        } catch (error) {
            console.error('❌ MEGA storage initialization failed:', error.message);
            this.retryCount++;
            
            if (this.retryCount <= this.maxRetries) {
                console.log(`🔄 Retrying MEGA login (attempt ${this.retryCount}/${this.maxRetries})...`);
                await this.delay(2000 * this.retryCount);
                return await this.initialize();
            }
            
            throw new Error(`MEGA authentication failed after ${this.maxRetries} attempts: ${error.message}`);
        }
    }

    async ensureAuthenticated() {
        if (!this.isAuthenticated || !this.storage) {
            return await this.initialize();
        }
        
        try {
            // Test connection by listing root directory
            await this.storage.root;
            return true;
        } catch (error) {
            console.log('🔄 MEGA session expired, reauthenticating...');
            this.isAuthenticated = false;
            return await this.initialize();
        }
    }

    async uploadBuffer(buffer, filename) {
        try {
            await this.ensureAuthenticated();
            
            // Convert buffer to readable stream
            const { Readable } = require('stream');
            const stream = Readable.from(buffer);
            
            const file = await this.storage.upload(filename, stream).complete;
            console.log(`✅ File uploaded to MEGA: ${filename}`);
            return file;
            
        } catch (error) {
            console.error('❌ MEGA upload failed:', error.message);
            throw error;
        }
    }

    async downloadBuffer(filename) {
        try {
            await this.ensureAuthenticated();
            
            const files = await this.storage.root.children;
            const file = files.find(f => f.name === filename);
            
            if (!file) {
                console.log(`❌ File not found in MEGA: ${filename}`);
                return null;
            }
            
            const downloadStream = file.download();
            const chunks = [];
            
            return new Promise((resolve, reject) => {
                downloadStream.on('data', chunk => chunks.push(chunk));
                downloadStream.on('end', () => resolve(Buffer.concat(chunks)));
                downloadStream.on('error', reject);
            });
            
        } catch (error) {
            console.error('❌ MEGA download failed:', error.message);
            return null;
        }
    }

    async listFiles() {
        try {
            await this.ensureAuthenticated();
            const files = await this.storage.root.children;
            return files.map(file => file.name);
        } catch (error) {
            console.error('❌ MEGA list files failed:', error.message);
            return [];
        }
    }

    async deleteFile(filename) {
        try {
            await this.ensureAuthenticated();
            
            const files = await this.storage.root.children;
            const file = files.find(f => f.name === filename);
            
            if (file) {
                await file.delete();
                console.log(`✅ File deleted from MEGA: ${filename}`);
                return true;
            }
            
            console.log(`❌ File not found for deletion: ${filename}`);
            return false;
            
        } catch (error) {
            console.error('❌ MEGA delete failed:', error.message);
            return false;
        }
    }

    async fileExists(filename) {
        try {
            await this.ensureAuthenticated();
            const files = await this.storage.root.children;
            return files.some(file => file.name === filename);
        } catch (error) {
            console.error('❌ MEGA file exists check failed:', error.message);
            return false;
        }
    }

    async clearLocalSessions() {
        try {
            // Clear any local MEGA session files that might be causing conflicts
            const sessionFiles = await fs.readdir('.').catch(() => []);
            const megaSessionFiles = sessionFiles.filter(file => 
                file.startsWith('megajs_') || 
                file.includes('mega_session') ||
                file.endsWith('.megajs')
            );
            
            for (const file of megaSessionFiles) {
                await fs.unlink(file).catch(() => {});
            }
            
            console.log('🧹 Cleared local MEGA session files');
        } catch (error) {
            console.log('ℹ️ No local MEGA sessions to clear');
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async logout() {
        try {
            if (this.storage) {
                await this.storage.logout();
            }
            this.isAuthenticated = false;
            this.storage = null;
            console.log('✅ MEGA storage logged out');
        } catch (error) {
            console.error('MEGA logout error:', error.message);
        }
    }
}

module.exports = MegaStorage;
