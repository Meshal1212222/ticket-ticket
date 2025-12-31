require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Firebase Configuration
if (process.env.FIREBASE_CONFIG) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('✅ Connected to Firebase');
    } catch (error) {
        console.error('❌ Firebase config error:', error);
    }
}

const db = admin.apps.length ? admin.firestore() : null;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// API Key Configuration
const API_KEY = process.env.API_KEY || crypto.randomBytes(32).toString('hex');
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';

// Ultra Msg WhatsApp Configuration
const ULTRAMSG_INSTANCE_ID = process.env.ULTRAMSG_INSTANCE_ID;
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN;
const WHATSAPP_GROUP_ID = process.env.WHATSAPP_GROUP_ID;

// OpenAI Configuration
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
if (openai) {
    console.log('✅ OpenAI configured');
} else {
    console.log('⚠️ OpenAI not configured - OPENAI_API_KEY missing');
}

// API Key Authentication Middleware
function authenticateAPI(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

    if (!apiKey || apiKey !== API_KEY) {
        return res.status(401).json({
            success: false,
            message: 'مفتاح API غير صالح'
        });
    }
    next();
}

// Admin Authentication Middleware
function authenticateAdmin(req, res, next) {
    const adminKey = req.headers['x-admin-key'] || req.query.key;

    if (!adminKey || adminKey !== ADMIN_KEY) {
        return res.status(401).json({
            success: false,
            message: 'غير مصرح'
        });
    }
    next();
}

// Function to send message to WhatsApp Group via Ultra Msg
async function sendToWhatsApp(message) {
    const url = `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                token: ULTRAMSG_TOKEN,
                to: WHATSAPP_GROUP_ID,
                body: message
            })
        });

        const data = await response.json();

        if (data.error) {
            console.error('Ultra Msg Error:', data.error);
            throw new Error(data.error);
        }

        return data;
    } catch (error) {
        console.error('Error sending to WhatsApp:', error);
        throw error;
    }
}

// Get next ticket number
async function getNextTicketNumber() {
    if (!db) return 1;

    const counterRef = db.collection('settings').doc('counter');
    const counter = await counterRef.get();

    if (!counter.exists) {
        await counterRef.set({ ticketNumber: 1 });
        return 1;
    }

    const newNumber = (counter.data().ticketNumber || 0) + 1;
    await counterRef.update({ ticketNumber: newNumber });
    return newNumber;
}

// Analyze ticket with OpenAI
async function analyzeTicketWithAI(ticketData) {
    if (!openai) {
        console.log('⚠️ OpenAI not available, skipping analysis');
        return ticketData;
    }

    console.log('🤖 Starting OpenAI analysis...');

    try {
        const prompt = `أنت موظف في قولدن تيكت. حلل بلاغ العميل واكتب ملخص للموظفين.

البلاغ: ${ticketData.subject || ''}

【شراء تذكرة】
• قبل الشراء,[فعالية] → يريد شراء تذكرة للفعالية المذكورة
• بعد الشراء,فعالية إنتهت → اشترى تذكرة لفعالية انتهت ويحتاج مساعدة
• بعد الشراء,فعالية قادمة → اشترى تذكرة لفعالية قادمة وعنده استفسار
• بعد الشراء,فعالية خارج السعودية → اشترى تذكرة لفعالية خارج السعودية

【بيع تذكرة - قبل البيع】
• عرض تذاكري للبيع → يسأل كيف يعرض تذاكره (استلم رد آلي بالخطوات)
• تذكرتي لم يتم قبولها → عرض تذكرته ولم تُقبل ويحتاج مساعدة
• لا أرى تذكرتي معروضه → لا يجد تذكرته معروضة (استلم رد: إذا نشطة فهي معروضة)
• متى يصلني المبلغ → يسأل متى يستلم المبلغ (استلم رد: 24-48 ساعة)
• التراجع عن البيع → يريد التراجع (استلم رد: لايمكن إلا بوجود مشكلة)
• ارسال التذكرة بعد البيع → يسأل كيف يرسل التذكرة للمشتري

【بيع تذكرة - بعد البيع】
• كيفية ارسال التذاكر → باع ويسأل كيف يرسلها
• التراجع عن البيع → باع ويريد التراجع عن البيع
• لم أستلم المبلغ → باع ولم يستلم المبلغ (استلم رد: 24-48 ساعة)
• حالة التذكره لم يستلم → أرسل التذكرة لكن المشتري لم يستلمها
• اخرى → استفسار آخر

اكتب جملة واحدة مختصرة تشرح طلب العميل للموظف.
الرد JSON فقط: {"summary": "..."}`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 500
        });

        const content = response.choices[0].message.content;
        console.log('🤖 OpenAI response:', content);

        // Extract JSON from response (in case there's extra text)
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.error('❌ No JSON found in OpenAI response');
            return ticketData;
        }

        const result = JSON.parse(jsonMatch[0]);
        console.log('✅ OpenAI analysis complete');

        return {
            ...ticketData,
            summary: result.summary || '',
            priority: ticketData.priority || result.priority || 'متوسط',
            aiProcessed: true
        };
    } catch (error) {
        console.error('❌ OpenAI Error:', error.message);
        console.error('Full error:', error);
        return ticketData;
    }
}

// Format ticket message for WhatsApp
function formatTicketMessage(ticket) {
    let message = `🎫 *بلاغ #${ticket.ticketNumber}*`;

    if (ticket.name) message += `\n👤 ${ticket.name}`;
    if (ticket.phone) message += `\n📱 ${ticket.phone}`;

    // الملخص من OpenAI
    if (ticket.summary) {
        message += `\n\n📋 ${ticket.summary}`;
    }

    return message;
}

// API Route - Submit Ticket (Protected with API Key)
app.post('/api/ticket', authenticateAPI, async (req, res) => {
    try {
        const { name, email, phone, category, priority, subject, description } = req.body;

        // Validation - فقط الاسم والوصف مطلوبين
        if (!name || !description) {
            return res.status(400).json({
                success: false,
                message: 'الرجاء تعبئة الحقول المطلوبة (الاسم والتفاصيل على الأقل)'
            });
        }

        // Get next ticket number
        const ticketNumber = await getNextTicketNumber();

        // Create ticket object
        let ticketData = {
            ticketId: `TKT-${ticketNumber}`,
            ticketNumber,
            name: name || '',
            email: email || '',
            phone: phone || '',
            category: category || '',
            priority: priority || '',
            subject: subject || '',
            description: description || '',
            status: 'جديد',
            createdAt: new Date().toISOString()
        };

        // Analyze with OpenAI
        console.log('📥 Ticket received:', ticketData.ticketId);
        if (openai) {
            ticketData = await analyzeTicketWithAI(ticketData);
        }

        // Save to Firebase
        if (db) {
            await db.collection('tickets').doc(ticketData.ticketId).set(ticketData);
        }

        // Send to WhatsApp if configured (skip if test mode)
        const skipWhatsapp = req.body.skipWhatsapp || req.query.skipWhatsapp;
        if (ULTRAMSG_INSTANCE_ID && ULTRAMSG_TOKEN && WHATSAPP_GROUP_ID && !skipWhatsapp) {
            try {
                const whatsappMessage = formatTicketMessage(ticketData);
                await sendToWhatsApp(whatsappMessage);
            } catch (whatsappError) {
                console.error('WhatsApp send failed:', whatsappError);
            }
        }

        // Return success
        res.json({
            success: true,
            message: 'تم إرسال البلاغ بنجاح',
            ticketId: ticketData.ticketId,
            aiProcessed: ticketData.aiProcessed || false,
            ticket: ticketData
        });

    } catch (error) {
        console.error('Error submitting ticket:', error);
        res.status(500).json({
            success: false,
            message: 'حدث خطأ أثناء إرسال البلاغ'
        });
    }
});

// API Route - Get All Tickets (Admin only)
app.get('/api/tickets', authenticateAdmin, async (req, res) => {
    try {
        if (!db) {
            return res.json({ success: true, count: 0, tickets: [] });
        }

        const snapshot = await db.collection('tickets').orderBy('createdAt', 'desc').get();
        const tickets = snapshot.docs.map(doc => doc.data());

        res.json({
            success: true,
            count: tickets.length,
            tickets
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'حدث خطأ'
        });
    }
});

// API Route - Get Ticket by ID (Admin only)
app.get('/api/tickets/:id', authenticateAdmin, async (req, res) => {
    try {
        if (!db) {
            return res.status(404).json({ success: false, message: 'التذكرة غير موجودة' });
        }

        const doc = await db.collection('tickets').doc(req.params.id).get();

        if (!doc.exists) {
            return res.status(404).json({
                success: false,
                message: 'التذكرة غير موجودة'
            });
        }

        res.json({
            success: true,
            ticket: doc.data()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'حدث خطأ'
        });
    }
});

// API Route - Update Ticket Status (Admin only)
app.patch('/api/tickets/:id', authenticateAdmin, async (req, res) => {
    try {
        if (!db) {
            return res.status(404).json({ success: false, message: 'التذكرة غير موجودة' });
        }

        const docRef = db.collection('tickets').doc(req.params.id);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.status(404).json({
                success: false,
                message: 'التذكرة غير موجودة'
            });
        }

        await docRef.update(req.body);
        const updated = await docRef.get();

        res.json({
            success: true,
            ticket: updated.data()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'حدث خطأ'
        });
    }
});

// API Route - Get Statistics (Admin only)
app.get('/api/stats', authenticateAdmin, async (req, res) => {
    try {
        if (!db) {
            return res.json({
                success: true,
                stats: { total: 0, new: 0, inProgress: 0, resolved: 0, byCategory: {}, byPriority: {} }
            });
        }

        const snapshot = await db.collection('tickets').get();
        const tickets = snapshot.docs.map(doc => doc.data());

        const stats = {
            total: tickets.length,
            new: tickets.filter(t => t.status === 'جديد').length,
            inProgress: tickets.filter(t => t.status === 'قيد المعالجة').length,
            resolved: tickets.filter(t => t.status === 'تم الحل').length,
            byCategory: {},
            byPriority: {}
        };

        tickets.forEach(t => {
            stats.byCategory[t.category] = (stats.byCategory[t.category] || 0) + 1;
            stats.byPriority[t.priority] = (stats.byPriority[t.priority] || 0) + 1;
        });

        res.json({
            success: true,
            stats
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'حدث خطأ'
        });
    }
});

// ==================== WEBHOOK للرسائل الواردة ====================

// Ultra Msg Webhook - استقبال الرسائل لحظياً
app.post('/webhook/ultramsg', async (req, res) => {
    try {
        const data = req.body;
        console.log('📨 Webhook received:', JSON.stringify(data).substring(0, 500));

        // التحقق من نوع الـ webhook
        if (data.event_type === 'message_received' || data.data || data.from || data.body !== undefined) {
            const message = data.data || data;

            // حفظ الرسالة في Firebase
            if (db) {
                const messageDoc = {
                    messageId: message.id || `msg_${Date.now()}`,
                    from: message.from || message.sender || '',
                    to: message.to || '',
                    body: message.body || '',
                    type: message.type || 'chat',
                    timestamp: message.timestamp ? new Date(message.timestamp * 1000) : new Date(),
                    fromMe: message.fromMe === true,
                    chatId: message.from || message.chatId || message.sender || '',
                    // معلومات الوسائط
                    hasMedia: ['image', 'video', 'audio', 'ptt', 'document', 'sticker'].includes(message.type),
                    media: message.media || '',
                    mimetype: message.mimetype || '',
                    filename: message.filename || '',
                    // معلومات إضافية
                    pushName: message.pushName || message.notifyName || '',
                    isGroup: message.isGroup === true || (message.from && message.from.includes('@g.us')),
                    receivedAt: new Date().toISOString()
                };

                await db.collection('whatsapp_messages').add(messageDoc);
                console.log('✅ Message saved to Firebase:', messageDoc.from, messageDoc.body.substring(0, 50));
            }
        }

        res.status(200).json({ success: true, message: 'Webhook received' });
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.status(200).json({ success: false, error: error.message });
    }
});

// API لجلب الرسائل المحفوظة من Firebase
app.get('/api/messages', authenticateAdmin, async (req, res) => {
    try {
        if (!db) {
            return res.json({ success: true, messages: [] });
        }

        const chatId = req.query.chatId;
        const limit = parseInt(req.query.limit) || 100;

        let query = db.collection('whatsapp_messages')
            .orderBy('timestamp', 'desc')
            .limit(limit);

        if (chatId) {
            query = db.collection('whatsapp_messages')
                .where('chatId', '==', chatId)
                .orderBy('timestamp', 'desc')
                .limit(limit);
        }

        const snapshot = await query.get();
        const messages = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            timestamp: doc.data().timestamp?.toDate?.() || doc.data().timestamp
        }));

        res.json({ success: true, count: messages.length, messages });
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API لجلب المحادثات الفريدة
app.get('/api/chats', authenticateAdmin, async (req, res) => {
    try {
        if (!db) {
            return res.json({ success: true, chats: [] });
        }

        const snapshot = await db.collection('whatsapp_messages')
            .orderBy('timestamp', 'desc')
            .limit(1000)
            .get();

        // تجميع المحادثات الفريدة
        const chatsMap = new Map();
        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const chatId = data.chatId;
            if (chatId && !chatsMap.has(chatId)) {
                chatsMap.set(chatId, {
                    id: chatId,
                    name: data.pushName || chatId.replace('@c.us', '').replace('@g.us', ''),
                    lastMessage: data.body,
                    lastTime: data.timestamp,
                    isGroup: data.isGroup
                });
            }
        });

        res.json({ success: true, chats: Array.from(chatsMap.values()) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        firebase: !!db,
        whatsapp: !!(ULTRAMSG_INSTANCE_ID && ULTRAMSG_TOKEN),
        openai: !!openai,
        webhook: 'https://ticket-ticket-production.up.railway.app/webhook/ultramsg'
    });
});

// ==================== أداة تصدير البيانات ====================

// Proxy لجلب البيانات من Ultra Msg مع محاولة جلب الوسائط
app.get('/api/export/chats', async (req, res) => {
    try {
        const response = await fetch(`https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/chats?token=${ULTRAMSG_TOKEN}`);
        const chats = await response.json();
        res.json({ success: true, chats });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// جلب جميع الرسائل مع محاولة جلب روابط الوسائط
app.get('/api/export/messages/:chatId', async (req, res) => {
    try {
        const { chatId } = req.params;
        const limit = parseInt(req.query.limit) || 500;

        // جلب الرسائل
        const response = await fetch(
            `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/chats/messages?token=${ULTRAMSG_TOKEN}&chatId=${chatId}&limit=${limit}`
        );
        const messages = await response.json();

        // محاولة جلب روابط الوسائط للرسائل التي تحتوي على وسائط
        const mediaTypes = ['image', 'video', 'audio', 'ptt', 'document', 'sticker'];

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (mediaTypes.includes(msg.type) && !msg.media && msg.id) {
                // محاولة جلب رابط الوسائط
                try {
                    const mediaResponse = await fetch(
                        `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/media?token=${ULTRAMSG_TOKEN}&msgId=${msg.id}`
                    );
                    const mediaData = await mediaResponse.json();
                    if (mediaData.media) {
                        messages[i].media = mediaData.media;
                        messages[i].mediaFetched = true;
                    }
                } catch(e) {
                    // تجاهل الأخطاء
                }
            }
        }

        res.json({ success: true, messages });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// جلب جميع البيانات دفعة واحدة
app.get('/api/export/all', async (req, res) => {
    try {
        const exportData = {
            exportDate: new Date().toISOString(),
            instance: ULTRAMSG_INSTANCE_ID,
            chats: [],
            allMessages: [],
            mediaMessages: [],
            stats: {
                totalChats: 0,
                totalMessages: 0,
                mediaMessages: 0
            }
        };

        // جلب المحادثات
        const chatsResponse = await fetch(
            `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/chats?token=${ULTRAMSG_TOKEN}`
        );
        const chats = await chatsResponse.json();
        exportData.chats = chats;
        exportData.stats.totalChats = chats.length;

        // جلب رسائل كل محادثة
        for (const chat of chats) {
            try {
                const msgsResponse = await fetch(
                    `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/chats/messages?token=${ULTRAMSG_TOKEN}&chatId=${chat.id}&limit=500`
                );
                const msgs = await msgsResponse.json();

                if (Array.isArray(msgs)) {
                    const chatMessages = {
                        chatId: chat.id,
                        chatName: chat.name || chat.id,
                        messageCount: msgs.length,
                        messages: msgs
                    };

                    exportData.allMessages.push(chatMessages);
                    exportData.stats.totalMessages += msgs.length;

                    // جمع رسائل الوسائط
                    const mediaTypes = ['image', 'video', 'audio', 'ptt', 'document', 'sticker'];
                    msgs.forEach(m => {
                        if (mediaTypes.includes(m.type)) {
                            exportData.mediaMessages.push({
                                chatId: chat.id,
                                chatName: chat.name,
                                messageId: m.id,
                                type: m.type,
                                media: m.media || null,
                                timestamp: m.timestamp,
                                body: m.body
                            });
                            exportData.stats.mediaMessages++;
                        }
                    });
                }

                // تأخير لتجنب rate limiting
                await new Promise(r => setTimeout(r, 100));
            } catch(e) {
                console.error(`Error fetching messages for ${chat.id}:`, e.message);
            }
        }

        res.json({ success: true, data: exportData });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// محاولة جلب وسائط رسالة معينة
app.get('/api/export/media/:msgId', async (req, res) => {
    try {
        const { msgId } = req.params;

        // طريقة 1: استخدام messages/media endpoint
        const mediaResponse = await fetch(
            `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/media?token=${ULTRAMSG_TOKEN}&msgId=${msgId}`
        );
        const mediaData = await mediaResponse.json();

        if (mediaData.media) {
            return res.json({ success: true, media: mediaData.media, source: 'messages/media' });
        }

        // طريقة 2: استخدام media endpoint
        const media2Response = await fetch(
            `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/media/${msgId}?token=${ULTRAMSG_TOKEN}`
        );
        const media2Data = await media2Response.json();

        if (media2Data.media || media2Data.url) {
            return res.json({ success: true, media: media2Data.media || media2Data.url, source: 'media/{id}' });
        }

        res.json({ success: false, message: 'لم يتم العثور على رابط الوسائط', response: { mediaData, media2Data } });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Serve export page
app.get('/export', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'export.html'));
});

// Public endpoint للوسائط من Firebase (بدون authentication)
app.get('/api/public/media', async (req, res) => {
    try {
        if (!db) {
            return res.json({ success: true, messages: [] });
        }

        const chatId = req.query.chatId;
        const limit = parseInt(req.query.limit) || 50;

        // استخدام query بسيط بدون composite index
        let query;
        if (chatId) {
            query = db.collection('whatsapp_messages')
                .where('chatId', '==', chatId)
                .limit(limit * 2); // جلب أكثر ثم فلترة
        } else {
            query = db.collection('whatsapp_messages')
                .orderBy('timestamp', 'desc')
                .limit(limit * 2);
        }

        const snapshot = await query.get();

        // فلترة الوسائط يدوياً
        const messages = snapshot.docs
            .map(doc => ({
                id: doc.id,
                messageId: doc.data().messageId,
                type: doc.data().type,
                media: doc.data().media,
                mimetype: doc.data().mimetype,
                filename: doc.data().filename,
                timestamp: doc.data().timestamp?.toDate?.() || doc.data().timestamp,
                from: doc.data().from,
                chatId: doc.data().chatId,
                hasMedia: doc.data().hasMedia,
                body: doc.data().body
            }))
            .filter(m => m.hasMedia && m.media) // فقط الرسائل التي لديها وسائط مع رابط
            .slice(0, limit);

        res.json({ success: true, count: messages.length, messages });
    } catch (error) {
        console.error('Error fetching media:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Webhook logs - آخر الرسائل المستلمة
app.get('/api/public/recent', async (req, res) => {
    try {
        if (!db) {
            return res.json({ success: true, messages: [] });
        }

        const limit = parseInt(req.query.limit) || 20;

        const snapshot = await db.collection('whatsapp_messages')
            .orderBy('timestamp', 'desc')
            .limit(limit)
            .get();

        const messages = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            timestamp: doc.data().timestamp?.toDate?.() || doc.data().timestamp
        }));

        res.json({ success: true, count: messages.length, messages });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve archive page
app.get('/archive', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'archive.html'));
});

// Serve WhatsApp dashboard
app.get('/whatsapp', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'whatsapp.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🔑 API Key: ${API_KEY}`);
    console.log(`👤 Admin Key: ${ADMIN_KEY}`);
    console.log(`📱 WhatsApp: ${ULTRAMSG_INSTANCE_ID ? 'Configured' : 'Not configured'}`);
    console.log(`🔥 Firebase: ${db ? 'Connected' : 'Not configured'}`);
    console.log(`🤖 OpenAI: ${openai ? 'Configured' : 'Not configured'}`);
});
